// History-derived ranks stay in the current account's local UI cache.
import * as db from './db.js';
import { UserError } from './errors.js';
import { emit } from './events.js';

const DAY = 86400000;
export const WINDOW_DAYS = 90;
export const HALF_LIFE_DAYS = 14;
export const CANDIDATE_LIMIT = 1000;
export const HOME_LIMIT = 64;
const MAX_SEARCHES = 32;
const MAX_CANDIDATES = 10000;
const MAX_VISIT_URLS = 4000;
const MAX_VISITS = 50000;
const QUERY_BUDGET_MS = 4000;
const CACHE_KEY = 'ui.home.rankCache';
const REVISION_KEY = 'ui.home.historyRevision';
const SKINS = new Set(['emboss', 'neo-apple', 'ivory-cobalt', 'mist-slate', 'liquid', 'dusk-widgets', 'cardiology', 'cream-paper', 'smoked-glass']);
let historyGeneration = 0;
let revisionQueue = Promise.resolve();

function webUrl(value) {
  try { const url = new URL(value); return /^https?:$/.test(url.protocol) ? url : null; }
  catch { return null; }
}

function ownedSites(bookmarks) {
  const sites = new Map();
  for (const b of bookmarks || []) {
    const url = b && !b.deleted && b.id ? webUrl(b.url) : null;
    if (!url) continue;
    if (!sites.has(url.origin)) sites.set(url.origin, []);
    sites.get(url.origin).push(b);
  }
  for (const list of sites.values()) list.sort((a, b) => Number(!!b.favorite) - Number(!!a.favorite) || (b.openedAt || b.createdAt || 0) - (a.openedAt || a.createdAt || 0) || String(a.id).localeCompare(String(b.id)));
  return sites;
}

export function rankSites(visits, bookmarks, now = Date.now(), limit = HOME_LIMIT) {
  const sites = ownedSites(bookmarks);
  const counts = new Map();
  const seen = new Set();
  for (const visit of visits || []) {
    const url = webUrl(visit?.url);
    const time = Number(visit?.visitTime);
    const id = visit?.visitId;
    if (!url || !sites.has(url.origin) || !id || seen.has(String(id)) || !Number.isFinite(time) || time <= 0 || time > now || time < now - WINDOW_DAYS * DAY || ['reload', 'auto_subframe', 'manual_subframe', 'auto_toplevel'].includes(visit.transition)) continue;
    seen.add(String(id));
    if (!counts.has(url.origin)) counts.set(url.origin, { days: new Map(), count: 0, last: 0 });
    const row = counts.get(url.origin);
    const day = Math.floor(time / DAY);
    row.days.set(day, (row.days.get(day) || 0) + 1);
    row.count++;
    row.last = Math.max(row.last, time);
  }
  const ranked = [...counts].map(([origin, count]) => {
    const books = sites.get(origin);
    const representative = books[0];
    let score = 0;
    for (const [day, n] of count.days) score += Math.min(n, 8) * Math.pow(0.5, (Math.floor(now / DAY) - day) / HALF_LIFE_DAYS);
    return { id: representative.id, url: representative.url, title: representative.title || representative.url, origin, bookmarkIds: books.map((b) => b.id), bookmarkCount: books.length, score, visitCount: count.count, lastVisitTime: count.last };
  });
  const take = Number.isInteger(limit) ? Math.max(0, Math.min(5000, limit)) : HOME_LIMIT;
  return ranked.sort((a, b) => b.score - a.score || b.lastVisitTime - a.lastVisitTime || a.origin.localeCompare(b.origin)).slice(0, take);
}

async function revision() {
  await revisionQueue;
  const stored = await chrome.storage.session.get(REVISION_KEY);
  if (stored[REVISION_KEY]) return stored[REVISION_KEY];
  const next = crypto.randomUUID();
  await chrome.storage.session.set({ [REVISION_KEY]: next });
  return next;
}

export function invalidateHistory() {
  historyGeneration++;
  const database = db.database(db.currentDatabase());
  revisionQueue = revisionQueue.catch(() => {}).then(async () => {
    await chrome.storage.session.set({ [REVISION_KEY]: crypto.randomUUID() });
    await database.kvSet(CACHE_KEY, null);
    emit('home');
  });
  return revisionQueue;
}

const historyListeners = new Set();
function installHistoryListeners() {
  for (const name of ['onVisited', 'onVisitRemoved']) {
    const event = chrome.history?.[name];
    if (!event || historyListeners.has(event)) continue;
    event.addListener(() => { invalidateHistory().catch(() => {}); });
    historyListeners.add(event);
  }
}
installHistoryListeners();
chrome.permissions?.onAdded?.addListener((change) => {
  if (change?.permissions?.includes('history')) {
    installHistoryListeners();
    invalidateHistory().catch(() => {});
  }
});
chrome.permissions?.onRemoved?.addListener((change) => {
  if (change?.permissions?.includes('history')) invalidateHistory().catch(() => {});
});

async function permitted() {
  return await chrome.permissions?.contains({ permissions: ['history'] }).catch(() => false) || false;
}

async function withinBudget(promise, deadline) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('HISTORY_BUDGET')), Math.max(1, deadline - Date.now())); })]);
  } finally { clearTimeout(timer); }
}

async function candidates(now, deadline) {
  const found = new Set();
  const windows = [[now - WINDOW_DAYS * DAY, now]];
  let searches = 0;
  let partial = false;
  while (windows.length && searches < MAX_SEARCHES && Date.now() < deadline && found.size < MAX_CANDIDATES) {
    const [startTime, endTime] = windows.shift();
    searches++;
    let rows;
    try { rows = await withinBudget(chrome.history.search({ text: '', startTime, endTime, maxResults: CANDIDATE_LIMIT }), deadline); }
    catch (e) { if (e.message !== 'HISTORY_BUDGET') throw e; partial = true; break; }
    for (const row of rows) if (webUrl(row.url)) found.add(row.url);
    if (rows.length >= CANDIDATE_LIMIT) {
      if (endTime - startTime <= 1) partial = true;
      else { const mid = Math.floor((startTime + endTime) / 2); windows.push([startTime, mid], [mid, endTime]); }
    }
  }
  if (windows.length || found.size >= MAX_CANDIDATES) partial = true;
  return { urls: [...found].slice(0, MAX_CANDIDATES), partial };
}

async function collectVisits(urls, sites, deadline, generation) {
  const relevant = [...new Set([...urls.filter((url) => sites.has(webUrl(url)?.origin)), ...[...sites.values()].flatMap((books) => books.map((b) => b.url))])];
  const selected = relevant.slice(0, MAX_VISIT_URLS);
  const visits = [];
  let partial = relevant.length > selected.length;
  let cursor = 0;
  let failures = 0;
  let completed = 0;
  await Promise.all(Array.from({ length: Math.min(6, selected.length) }, async () => {
    while (cursor < selected.length && Date.now() < deadline && visits.length < MAX_VISITS && generation === historyGeneration) {
      const url = selected[cursor++];
      try {
        const rows = await withinBudget(chrome.history.getVisits({ url }), deadline);
        completed++;
        for (const row of rows) {
          if (visits.length >= MAX_VISITS) { partial = true; break; }
          const time = Number(row.visitTime);
          if (Number.isFinite(time) && time >= Date.now() - WINDOW_DAYS * DAY && time <= Date.now()) visits.push({ url, visitId: row.visitId, visitTime: time, transition: row.transition, isLocal: row.isLocal });
        }
      } catch { failures++; partial = true; }
    }
  }));
  if (cursor < selected.length || visits.length >= MAX_VISITS) partial = true;
  if (selected.length && failures && !completed) throw new UserError('暂时无法读取访问记录，请重试；收藏仍可正常使用', 'HISTORY_UNAVAILABLE');
  return { visits, partial };
}

export async function top(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((k) => !['refresh', 'all', 'stage'].includes(k)) || (value.refresh !== undefined && typeof value.refresh !== 'boolean') || (value.all !== undefined && typeof value.all !== 'boolean') || (value.stage !== undefined && !['preview', 'month', 'all'].includes(value.stage))) throw new UserError('无效的首页请求', 'BAD_INPUT');
  const stage = value.stage || (value.all === true ? 'all' : 'preview');
  const result = { permissionGranted: false, items: [], computedAt: 0, cached: false, stale: false, partial: false, windowDays: WINDOW_DAYS, monthTotal: 0, total: 0, hasMore: false };
  if (!(await permitted()) || !chrome.history?.search || !chrome.history?.getVisits) return result;
  result.permissionGranted = true;
  const database = db.database(db.currentDatabase());
  const generation = historyGeneration;
  const bookmarks = await database.getLive('bookmarks');
  const sites = ownedSites(bookmarks);
  if (!sites.size) return result;
  const rev = await revision();
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([...sites.keys()].sort())));
  const signature = [...new Uint8Array(digest)].map((n) => n.toString(16).padStart(2, '0')).join('');
  const hiddenValue = await database.kvGet('ui.home.hiddenOrigins', []);
  const hidden = Array.isArray(hiddenValue) ? hiddenValue : [];
  const hydrateItems = (items) => items.filter((item) => sites.has(item.origin)).map((item) => {
    const books = sites.get(item.origin);
    const representative = books[0];
    return { ...item, id: representative.id, url: representative.url, title: representative.title || representative.url, bookmarkIds: books.map((b) => b.id), bookmarkCount: books.length };
  });
  const selectItems = (items) => {
    const now = Date.now();
    const monthStart = now - 30 * DAY;
    const visible = hydrateItems(items).filter((item) => !hidden.includes(item.origin));
    const month = visible.filter((item) => item.lastVisitTime >= monthStart && item.lastVisitTime <= now);
    const limit = stage === 'preview' ? 16 : stage === 'month' ? 50 : 5000;
    const selected = stage === 'all' ? [...month, ...visible.filter((item) => item.lastVisitTime < monthStart)] : month;
    return { items: selected.slice(0, limit), monthTotal: month.length, total: visible.length, hasMore: selected.length > limit };
  };
  const cached = await database.kvGet(CACHE_KEY);
  if (!value.refresh && cached?.version === 1 && cached.revision === rev && cached.signature === signature && Array.isArray(cached.items) && await permitted() && generation === historyGeneration) {
    const items = hydrateItems(cached.items);
    if (JSON.stringify(items) !== JSON.stringify(cached.items)) await database.kvSet(CACHE_KEY, { ...cached, items });
    if (!(await permitted())) { await database.kvSet(CACHE_KEY, null); return { ...result, permissionGranted: false }; }
    if (generation !== historyGeneration || await revision() !== rev) return { ...result, stale: true };
    return { ...result, ...selectItems(items), computedAt: cached.computedAt, partial: !!cached.partial, cached: true, stale: Date.now() - cached.computedAt > 60000 };
  }
  const now = Date.now();
  const deadline = now + QUERY_BUDGET_MS;
  try {
    const discovered = await candidates(now, deadline);
    const collected = await collectVisits(discovered.urls, sites, deadline, generation);
    if (!(await permitted())) { await database.kvSet(CACHE_KEY, null); return { ...result, permissionGranted: false }; }
    if (generation !== historyGeneration || await revision() !== rev) return { ...result, stale: true };
    const items = rankSites(collected.visits, bookmarks, now, 5000);
    const partial = discovered.partial || collected.partial;
    await database.kvSet(CACHE_KEY, { version: 1, revision: rev, signature, computedAt: now, partial, items });
    if (!(await permitted())) { await database.kvSet(CACHE_KEY, null); return { ...result, permissionGranted: false }; }
    if (generation !== historyGeneration || await revision() !== rev) return { ...result, stale: true };
    return { ...result, ...selectItems(items), computedAt: now, partial };
  } catch (e) {
    if (!(await permitted())) return { ...result, permissionGranted: false };
    if (e instanceof UserError) throw e;
    throw new UserError('暂时无法读取浏览历史，请重试；收藏仍可正常使用', 'HISTORY_UNAVAILABLE');
  }
}

function uiState(groups, values) {
  const allowMultipleGroups = values.get('ui.sb.allowMultiple') !== false;
  const groupCollapsed = Object.fromEntries([
    ...groups.map((g) => [g.id, values.get('ui.group.collapsed.' + g.id) !== false]),
    ['none', values.get('ui.group.collapsed.none') !== false],
  ]);
  if (!allowMultipleGroups) {
    const last = values.get('ui.sb.lastOpenGroup');
    const open = Object.keys(groupCollapsed).filter((id) => !groupCollapsed[id]);
    const keep = open.includes(last) ? last : open[0];
    for (const id of open) groupCollapsed[id] = id !== keep;
  }
  const open = Object.keys(groupCollapsed).filter((id) => !groupCollapsed[id]);
  const last = values.get('ui.sb.lastOpenGroup');
  const live = new Set(groups.map((g) => g.id));
  const pinned = values.get('ui.sb.pinnedGroups');
  const hidden = values.get('ui.home.hiddenOrigins');
  return { homeCollapsed: values.get('ui.home.collapsed') === true, groupCollapsed, allowMultipleGroups, lastOpenGroup: open.includes(last) ? last : open[0] || null,
    pinnedGroupIds: Array.isArray(pinned) ? [...new Set(pinned)].filter((id) => live.has(id)).slice(0, 5) : [],
    folderListCollapsed: values.get('ui.sb.listCollapsed') !== false,
    skin: SKINS.has(values.get('ui.skin')) ? values.get('ui.skin') : 'emboss',
    motion: values.get('ui.motion') !== false,
    sidebarWidth: Number.isFinite(values.get('ui.sidebarWidth')) && values.get('ui.sidebarWidth') >= 224 && values.get('ui.sidebarWidth') <= 304 ? values.get('ui.sidebarWidth') : 248,
    hiddenOrigins: Array.isArray(hidden) ? [...new Set(hidden)].filter((origin) => webUrl(origin)?.origin === origin).slice(0, 500) : [],
  };
}

export async function getUi() {
  const database = db.database(db.currentDatabase());
  const [groups, rows] = await Promise.all([database.getLive('groups'), database.getAll('kv')]);
  const state = uiState(groups, new Map(rows.map((row) => [row.key, row.value])));
  if (state.hiddenOrigins.length) {
    const sites = ownedSites(await database.getLive('bookmarks'));
    state.hiddenOrigins = state.hiddenOrigins.filter((origin) => sites.has(origin));
  }
  return state;
}

export async function setUi(value = {}) {
  const keys = value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value).sort().join(',') : '';
  const home = keys === 'homeCollapsed' && typeof value.homeCollapsed === 'boolean';
  const multiple = keys === 'allowMultipleGroups' && typeof value.allowMultipleGroups === 'boolean';
  const group = keys === 'collapsed,groupId' && typeof value.groupId === 'string' && typeof value.collapsed === 'boolean';
  const pinned = keys === 'pinnedGroupIds' && Array.isArray(value.pinnedGroupIds) && value.pinnedGroupIds.length <= 5 && value.pinnedGroupIds.every((id) => typeof id === 'string') && new Set(value.pinnedGroupIds).size === value.pinnedGroupIds.length;
  const list = keys === 'folderListCollapsed' && typeof value.folderListCollapsed === 'boolean';
  const all = keys === 'collapseAllGroups' && value.collapseAllGroups === true;
  const skin = keys === 'skin' && SKINS.has(value.skin);
  const motion = keys === 'motion' && typeof value.motion === 'boolean';
  const width = keys === 'sidebarWidth' && Number.isInteger(value.sidebarWidth) && value.sidebarWidth >= 224 && value.sidebarWidth <= 304;
  const hidden = keys === 'hiddenOrigins' && Array.isArray(value.hiddenOrigins) && value.hiddenOrigins.length <= 500 && value.hiddenOrigins.every((origin) => typeof origin === 'string' && webUrl(origin)?.origin === origin) && new Set(value.hiddenOrigins).size === value.hiddenOrigins.length;
  if (!home && !multiple && !group && !pinned && !list && !all && !skin && !motion && !width && !hidden) throw new UserError('无效的界面设置', 'INVALID_UI_STATE');
  // A single transaction keeps rapid clicks and writes from other tabs from leaving two groups open.
  const result = await db.transact(['kv', 'groups', 'bookmarks'], async (t) => {
    const [allGroups, rows] = await Promise.all([t.getAll('groups'), t.getAll('kv')]);
    const groups = allGroups.filter((g) => !g.deleted);
    const values = new Map(rows.map((row) => [row.key, row.value]));
    const put = (key, next) => { values.set(key, next); t.put('kv', { key, value: next }); };
    const hiddenBefore = values.get('ui.home.hiddenOrigins');
    const sites = hidden || (Array.isArray(hiddenBefore) && hiddenBefore.length) ? ownedSites(await t.getAll('bookmarks')) : null;
    if (sites && Array.isArray(hiddenBefore)) put('ui.home.hiddenOrigins', hiddenBefore.filter((origin) => sites.has(origin)));
    if (pinned) {
      if (value.pinnedGroupIds.some((id) => !groups.some((g) => g.id === id))) throw new UserError('置顶分组已经不存在，请刷新', 'NOT_FOUND');
      put('ui.sb.pinnedGroups', [...value.pinnedGroupIds]);
    }
    if (list) put('ui.sb.listCollapsed', value.folderListCollapsed);
    if (all) for (const id of [...groups.map((g) => g.id), 'none']) put('ui.group.collapsed.' + id, true);
    if (skin) put('ui.skin', value.skin);
    if (motion) put('ui.motion', value.motion);
    if (width) put('ui.sidebarWidth', value.sidebarWidth);
    if (hidden) {
      if (value.hiddenOrigins.some((origin) => !sites.has(origin))) throw new UserError('只能隐藏当前资料库已收藏的网站', 'NOT_FOUND');
      put('ui.home.hiddenOrigins', [...value.hiddenOrigins]);
    }
    if (home) put('ui.home.collapsed', value.homeCollapsed);
    if (multiple) {
      put('ui.sb.allowMultiple', value.allowMultipleGroups);
      if (!value.allowMultipleGroups) {
        const next = uiState(groups, values);
        for (const [id, collapsed] of Object.entries(next.groupCollapsed)) put('ui.group.collapsed.' + id, collapsed);
      }
    }
    if (group) {
      if (value.groupId && !groups.some((g) => g.id === value.groupId)) throw new UserError('这个分组已经不存在，请刷新后继续', 'NOT_FOUND');
      const id = value.groupId || 'none';
      if (!value.collapsed) {
        if (values.get('ui.sb.allowMultiple') === false) {
          for (const other of [...groups.map((g) => g.id), 'none']) put('ui.group.collapsed.' + other, other !== id);
        }
        put('ui.sb.lastOpenGroup', id);
      }
      put('ui.group.collapsed.' + id, value.collapsed);
    }
    return uiState(groups, values);
  });
  if (skin || motion || width) emit('appearance');
  return result;
}
