// 同步：每次上传生成不可变快照，各设备不会覆盖彼此的写入。每次同步先下载、按条目合并
// （谁改得晚用谁的，删除也是一条记录），再把合并结果写回本机，有变化才上传。
// 两台电脑同时改了同一条笔记时，晚的那份留在原处，早的那份另存为「冲突副本」，不会丢。

import * as db from './db.js';
import * as drive from './drive.js';
import * as google from './google.js';
import * as vault from './vault.js';
import * as cr from './crypto.js';
import * as workspace from './workspace.js';
import { emit, onLocalChange } from './events.js';
import { getSettings, updateSettings, applyRemoteToolSettings, deviceId } from './settings.js';
import { UserError } from './errors.js';
import { SYNC_FILE_NAME, SNAPSHOT_FILE_NAME } from '../shared/defaults.js';
import { sha256Hex, noteTitle } from '../shared/util.js';
import { stable, forUpload, sortById, mergeStore, dedupeBookmarks, dedupeGroups, purgeTombstones, stampNote, recordHash } from './merge.js';

const FORMAT = 'shuqian-sync/4';
const SOON_ALARM = 'sq-sync-soon';
const PERIODIC_ALARM = 'sq-sync';

let running = null;
let again = false;
let soonTimer = null;
let syncing = false;
let clearing = false;

function runtimeClientId() {
  return String(chrome.runtime.getManifest().oauth2?.client_id || '');
}

async function state() {
  return (await db.kvGet('syncState')) || { fileId: null, lastSyncAt: 0, lastError: null, lastErrorCode: null, conflicts: [], account: null, clientId: null };
}

async function patchState(patch) {
  const next = { ...(await state()), ...patch };
  await db.kvSet('syncState', next);
  return next;
}

async function contentHash(snap) {
  const { updatedAt, device, ...rest } = snap;
  return sha256Hex(stable(rest));
}

// ───────────── 一次同步 ─────────────

async function readLocal() {
  const [bookmarks, groups, notes, tasks, vaultRows] = await Promise.all(['bookmarks', 'groups', 'notes', 'tasks', 'vault'].map((s) => db.getAll(s)));
  return {
    bookmarks,
    groups,
    notes,
    tasks,
    vault: {
      header: await db.kvGet('vaultHeader'),
      headerUpdatedAt: (await db.kvGet('vaultHeaderUpdatedAt')) || 0,
      records: vaultRows,
    },
  };
}

function parseRemote(text, format = FORMAT) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new UserError('云端同步文件损坏了，已停止同步，避免覆盖', 'REMOTE_CORRUPT');
  }
  if (!data || data.format !== format) throw new UserError('云端同步文件格式不兼容，已停止同步', 'REMOTE_FORMAT');
  if (data.owner !== workspace.current().id) throw new UserError('云端文件的账号归属不匹配，已停止同步', 'REMOTE_OWNER');
  for (const store of ['bookmarks', 'groups', 'notes', 'tasks']) {
    if (!Array.isArray(data[store]) || data[store].some((r) => !r || typeof r.id !== 'string' || !Number.isFinite(r.updatedAt))) throw new UserError('云端条目格式不完整，已停止同步', 'REMOTE_CORRUPT');
  }
  if (data.groups.some((g) => typeof g.name !== 'string') || data.notes.some((n) => typeof n.body !== 'string')) throw new UserError('云端条目内容无效，已停止同步', 'REMOTE_CORRUPT');
  if (data.vaultAlternates !== undefined && !Array.isArray(data.vaultAlternates)) throw new UserError('云端保险箱格式无效', 'REMOTE_CORRUPT');
  for (const section of [data.vault, ...(data.vaultAlternates || [])]) {
    if (!section?.header) continue;
    cr.validateHeader(section.header);
    if (!Array.isArray(section.records) || section.records.some((r) => !r || typeof r.id !== 'string' || !Number.isFinite(r.updatedAt))) throw new UserError('云端保险箱条目无效', 'REMOTE_CORRUPT');
  }
  return data;
}

async function preserveNoteConflicts(map, conflicts) {
  const added = [];
  for (const c of conflicts) {
    const id = 'conflict-' + await sha256Hex(stable([c.other.id, c.other.title || '', c.other.body || '']));
    // 同一分叉使用稳定 ID；用户删除过的副本也不重复建立。
    if (map.has(id)) continue;
    const copy = await stampNote({ ...c.other, id, title: noteTitle(c.other) + '（冲突副本）', pinned: false, createdAt: c.other.updatedAt, deleted: false, ancestors: [], conflictOf: c.other.id });
    map.set(id, copy);
    added.push({ copy, keep: c.keep });
  }
  return added;
}

/** 将独立快照归并；不同保险箱保留为分支，交给现有合并/替换界面处理。 */
async function combineSnapshots(snapshots, retired = []) {
  if (!snapshots.length) return null;
  const out = { format: FORMAT, owner: workspace.current().id };
  for (const store of ['bookmarks', 'groups', 'notes', 'tasks']) {
    let rows = [];
    for (const snap of snapshots) {
      const incoming = store === 'notes' ? await Promise.all(snap.notes.map((n) => stampNote(n))) : snap[store];
      const ctx = { lastSyncAt: 0, noteConflicts: [] };
      const { merged } = mergeStore(store, rows, incoming, ctx);
      if (store === 'notes') await preserveNoteConflicts(merged, ctx.noteConflicts);
      rows = [...merged.values()];
    }
    out[store] = sortById(rows);
  }
  const retiredIds = new Set(retired);
  const vaults = new Map();
  for (const snap of snapshots) {
    for (const id of snap.vaultRetiredIds || []) if (typeof id === 'string') retiredIds.add(id);
    for (const section of [snap.vault, ...(snap.vaultAlternates || [])]) {
      if (!section?.header) continue;
      const id = section.header.vaultId;
      const previous = vaults.get(id);
      if (!previous) { vaults.set(id, section); continue; }
      const latest = (section.headerUpdatedAt || 0) > (previous.headerUpdatedAt || 0) || ((section.headerUpdatedAt || 0) === (previous.headerUpdatedAt || 0) && stable(section.header) > stable(previous.header)) ? section : previous;
      const { merged } = mergeStore('vault', previous.records, section.records, { noteConflicts: [] });
      vaults.set(id, { ...latest, records: sortById([...merged.values()]) });
    }
    if (snap.tools && (!out.tools || (snap.tools.updatedAt || 0) > (out.tools.updatedAt || 0) || ((snap.tools.updatedAt || 0) === (out.tools.updatedAt || 0) && stable(snap.tools) > stable(out.tools)))) out.tools = snap.tools;
  }
  const choices = [...vaults.values()].sort((a, b) => a.header.vaultId.localeCompare(b.header.vaultId));
  const active = choices.filter((v) => !retiredIds.has(v.header.vaultId));
  // 同时互相合并会产生退役环；两个版本均已被明确处理，保留确定的一支。
  const available = active.length ? active : choices.slice(0, 1);
  out.vault = available[0] || { header: null, headerUpdatedAt: 0, records: [] };
  out.vaultAlternates = available.slice(1);
  out.vaultRetiredIds = [...retiredIds].sort();
  out.tools ||= null;
  return out;
}

async function coversSnapshot(next, previous) {
  return await contentHash(await combineSnapshots([next, previous])) === await contentHash(next);
}

async function acknowledgements(out, settings) {
  const ack = {};
  for (const store of ['bookmarks', 'groups', 'notes', 'tasks', 'vault']) {
    if (!settings.sync[store === 'groups' ? 'bookmarks' : store === 'tasks' ? 'tools' : store]) continue;
    const rows = store === 'vault' ? out.vault.records : out[store];
    ack[store] = Object.fromEntries(await Promise.all(rows.map(async (r) => [r.id, await recordHash(store, r)])));
  }
  ack.vaultHeader = settings.sync.vault ? await sha256Hex(stable(out.vault.header)) : null;
  ack.tools = settings.sync.tools ? await sha256Hex(stable(out.tools)) : null;
  return ack;
}

async function pendingCount(ack, settings) {
  let pending = 0;
  for (const store of ['bookmarks', 'groups', 'notes', 'tasks', 'vault']) {
    if (!settings.sync[store === 'groups' ? 'bookmarks' : store === 'tasks' ? 'tools' : store]) continue;
    const summary = await db.summary(store);
    pending += summary.entries.filter((r) => !r.legacy && ack?.[store]?.[r.id] !== r.hash).length;
  }
  if (settings.sync.vault && await sha256Hex(stable(await db.kvGet('vaultHeader'))) !== ack?.vaultHeader) pending++;
  if (settings.sync.tools) {
    const tools = { settings: { tools: settings.tools, checkin: settings.checkin }, updatedAt: (await db.kvGet('toolsUpdatedAt')) || 0 };
    if (await sha256Hex(stable(tools)) !== ack?.tools) pending++;
  }
  return pending;
}

async function adoptHeaderIfUnchanged(header, updatedAt, before, replace = false) {
  return db.exclusive(async () => {
    const current = await db.kvGet('vaultHeader');
    if (stable(current) !== stable(before.header)) { again = true; return false; }
    if (replace) {
      if ((await db.getLive('vault')).length) { again = true; return false; }
      await db.clear('vault');
    }
    await vault.adoptRemoteHeader(header, updatedAt);
    return true;
  });
}

async function runOnce(reason) {
  const auth = await google.status();
  if (!auth.signedIn) return { skipped: 'not-signed-in' };
  await workspace.assertSyncAllowed();
  const settings = await getSettings();
  const st = await state();
  const startedAt = Date.now();
  syncing = true;
  emit('sync', { syncing: true });

  // 1. 下载：每台设备上传的快照都读进来合并；2.x 早期的单文件（v3）只读不写。
  let fileId = null;
  const sources = [];
  const snapshotFiles = await drive.findFile(SNAPSHOT_FILE_NAME);
  for (const file of snapshotFiles) {
    const bytes = await drive.download(file.id);
    if (!bytes) throw new UserError('云端快照正在更新，请重试', 'REMOTE_CHANGED');
    sources.push({ file, snapshot: parseRemote(await drive.gunzip(bytes)) });
  }
  const files = await drive.findFile(SYNC_FILE_NAME);
  if (files.length > 1) throw new UserError('发现多个同名云端文件，请先备份并人工处理，避免覆盖', 'REMOTE_DUPLICATES');
  if (files.length) {
    fileId = files[0].id;
    const bytes = await drive.download(fileId);
    if (!bytes) throw new UserError('云端文件在同步期间变化，请重试', 'REMOTE_CHANGED');
    sources.push({ file: files[0], snapshot: parseRemote(await drive.gunzip(bytes), 'shuqian-sync/3') });
  }
  sources.sort((a, b) => a.file.id.localeCompare(b.file.id));
  const remote = await combineSnapshots(sources.map((s) => s.snapshot), (await db.kvGet('vaultRetiredIds')) || []);
  const remoteHash = remote ? await contentHash(remote) : null;
  // 换了账号时，上次同步时间不算数。
  const lastSyncAt = st.account === auth.user.googleSub && st.clientId === runtimeClientId() ? st.lastSyncAt || 0 : 0;

  // 2. 合并
  const local = await readLocal();
  local.notes = await Promise.all(local.notes.map((n) => stampNote(n)));
  const now = Date.now();
  const ctx = { lastSyncAt, noteConflicts: [] };
  const enabled = {
    bookmarks: settings.sync.bookmarks,
    groups: settings.sync.bookmarks,
    notes: settings.sync.notes,
    tasks: settings.sync.tools,
  };
  const out = { format: FORMAT, owner: workspace.current().id, updatedAt: now, device: await deviceId(), vaultAlternates: remote?.vaultAlternates || [], vaultRetiredIds: remote?.vaultRetiredIds || [] };
  const writes = { bookmarks: [], groups: [], notes: [], tasks: [], vault: [] };
  const deletes = { bookmarks: [], groups: [], notes: [], tasks: [], vault: [] };
  const maps = {};

  for (const store of ['bookmarks', 'groups', 'notes', 'tasks']) {
    if (!enabled[store]) {
      out[store] = remote?.[store] || [];
      continue;
    }
    const { merged, toLocal } = mergeStore(store, local[store], remote?.[store], ctx);
    maps[store] = merged;
    writes[store].push(...toLocal);
  }
  if (maps.bookmarks) writes.bookmarks.push(...dedupeBookmarks(maps.bookmarks, now));
  if (maps.groups && maps.bookmarks) {
    const g = dedupeGroups(maps.groups, maps.bookmarks, now);
    writes.groups.push(...g.changedGroups);
    writes.bookmarks.push(...g.changedBookmarks);
  }
  // 笔记冲突：另存一份副本。
  const conflicts = [...(st.conflicts || [])];
  for (const { copy, keep } of maps.notes ? await preserveNoteConflicts(maps.notes, ctx.noteConflicts) : []) {
    writes.notes.push(copy);
    if (!conflicts.some((c) => c.copyId === copy.id)) conflicts.push({ id: copy.id, kind: 'note', noteId: keep.id, copyId: copy.id, title: noteTitle(keep), at: now });
  }
  for (const store of Object.keys(maps)) {
    deletes[store] = purgeTombstones(maps[store], now);
    out[store] = sortById([...maps[store].values()].map((r) => forUpload(store, r)));
  }

  // 保险箱
  let vaultConflict = null;
  let vaultChangedWhileReading = false;
  const rv = remote?.vault || null;
  if (!settings.sync.vault) {
    out.vault = rv || { header: null, headerUpdatedAt: 0, records: [] };
  } else {
    const lh = local.vault.header;
    const rh = rv?.header || null;
    if (!rh && !lh) {
      out.vault = { header: null, headerUpdatedAt: 0, records: [] };
    } else if (rh && !lh) {
      vaultChangedWhileReading = !(await adoptHeaderIfUnchanged(rh, rv.headerUpdatedAt, local.vault));
      if (!vaultChangedWhileReading) writes.vault.push(...(rv.records || []));
      out.vault = rv;
    } else if (lh && !rh) {
      out.vault = { header: lh, headerUpdatedAt: local.vault.headerUpdatedAt, records: sortById(local.vault.records.filter((r) => !r.legacy)) };
      // 认不出格式的旧条目不上传。
    } else if (lh.vaultId === rh.vaultId) {
      let header = lh;
      let headerUpdatedAt = local.vault.headerUpdatedAt;
      if ((rv.headerUpdatedAt || 0) > headerUpdatedAt) {
        header = rh;
        headerUpdatedAt = rv.headerUpdatedAt;
        vaultChangedWhileReading = !(await adoptHeaderIfUnchanged(rh, rv.headerUpdatedAt, local.vault));
      }
      const { merged, toLocal } = mergeStore('vault', local.vault.records, rv.records, ctx);
      if (!vaultChangedWhileReading) writes.vault.push(...toLocal);
      deletes.vault = purgeTombstones(merged, now);
      out.vault = { header, headerUpdatedAt, records: sortById([...merged.values()].filter((r) => !r.legacy)) };
    } else {
      const localLive = local.vault.records.filter((r) => !r.deleted);
      if (!localLive.length) {
        // 本机保险箱是空的：直接用云端的。
        vaultChangedWhileReading = !(await adoptHeaderIfUnchanged(rh, rv.headerUpdatedAt, local.vault, true));
        if (!vaultChangedWhileReading) writes.vault.push(...(rv.records || []));
      } else {
        vaultConflict = { header: rh, headerUpdatedAt: rv.headerUpdatedAt, records: rv.records || [], at: now };
      }
      out.vault = rv;
    }
  }

  // 工具设置
  const localToolsAt = (await db.kvGet('toolsUpdatedAt')) || 0;
  if (settings.sync.tools && remote?.tools && (remote.tools.updatedAt || 0) > localToolsAt) {
    await applyRemoteToolSettings(remote.tools.settings || {}, remote.tools.updatedAt);
    out.tools = remote.tools;
  } else {
    const s2 = await getSettings();
    out.tools = settings.sync.tools ? { settings: { tools: s2.tools, checkin: s2.checkin }, updatedAt: localToolsAt } : remote?.tools || null;
  }

  // 3. 写回本机（排队执行；同步期间用户又改过的条目以本机为准，下次再上传）
  await db.exclusive(async () => {
    for (const store of ['bookmarks', 'groups', 'notes', 'tasks', 'vault']) {
      if (!writes[store].length && !deletes[store].length) continue;
      const localList = store === 'vault' ? local.vault.records : local[store];
      const before = new Map(await Promise.all(localList.map(async (r) => [r.id, await recordHash(store, r)])));
      const current = new Map((await db.getAll(store)).map((r) => [r.id, r]));
      const currentHashes = new Map(await Promise.all([...current.values()].map(async (r) => [r.id, await recordHash(store, r)])));
      // 读取之后本机又改过（或新建）的条目
      const changedMeanwhile = (id) => {
        const cur = current.get(id);
        return !!cur && currentHashes.get(id) !== before.get(id);
      };
      const latest = new Map(writes[store].filter((r) => !changedMeanwhile(r.id)).map((r) => [r.id, r]));
      if (latest.size) await db.putMany(store, [...latest.values()]);
      const del = deletes[store].filter((id) => !changedMeanwhile(id));
      if (del.length) await db.removeMany(store, del);
    }
  });
  if (!vaultConflict && settings.sync.vault && out.vaultAlternates.length) vaultConflict = { ...out.vaultAlternates[0], at: now };
  if (settings.sync.vault) {
    const previousConflict = await db.kvGet('vaultConflict');
    if (vaultConflict || (previousConflict && !previousConflict.source)) await db.kvSet('vaultConflict', vaultConflict);
  }
  await db.kvUpdate('vaultRetiredIds', (ids) => [...new Set([...(Array.isArray(ids) ? ids : []), ...out.vaultRetiredIds])], []);

  // 4. 有变化才上传
  const hash = await contentHash(out);
  let uploaded = false;
  if (hash !== remoteHash || !snapshotFiles.length) {
    const bytes = await drive.gzip(JSON.stringify(out));
    fileId = (await drive.create(SNAPSHOT_FILE_NAME, bytes)).id;
    uploaded = true;
    // 只清理本设备已读入、且被新快照逐条覆盖的版本；绝不删除并发产生的未知文件。
    for (const source of sources) {
      if (source.file.name !== SNAPSHOT_FILE_NAME || source.snapshot.device !== out.device || !(await coversSnapshot(out, source.snapshot))) continue;
      await drive.remove(source.file.id).catch(() => {});
    }
  }

  const ack = await acknowledgements(out, settings);
  await patchState({ fileId, lastSyncAt: startedAt, acknowledged: ack, lastError: null, lastErrorCode: null, conflicts: conflicts.slice(-50), account: auth.user.googleSub, clientId: runtimeClientId() });
  if (!vaultConflict && await pendingCount(ack, await getSettings())) again = true;
  const changedTopics = ['bookmarks', 'groups', 'notes', 'tasks', 'vault'].filter((s) => writes[s].length || deletes[s].length);
  if (changedTopics.length) emit(changedTopics, { fromSync: true });
  return { uploaded, pulled: changedTopics, reason };
}

async function syncNowLeased(reason = 'manual') {
  if (clearing) throw new UserError('正在清理云端资料，请稍后同步', 'SYNC_BUSY');
  if (running) {
    again = true;
    return running;
  }
  running = (async () => {
    try {
      let attempts = 0;
      let downloadRetries = 0;
      do {
        again = false;
        try { await runOnce(reason); }
        catch (e) {
          if (e.code !== 'REMOTE_CHANGED' || downloadRetries++ >= 1) throw e;
          again = true;
          continue;
        }
        attempts++;
      } while (again && !clearing && attempts < 3);
      if (again && !clearing) await chrome.alarms.create(SOON_ALARM, { when: Date.now() + 45000 });
      return { ok: true };
    } catch (e) {
      await patchState({ lastError: e.user ? e.message : '同步失败：' + (e.message || '未知错误'), lastErrorCode: e.code || 'ERROR', lastErrorAt: Date.now() });
      if (!e.user) console.warn('sync failed', e);
      return { ok: false, error: e.message, code: e.code };
    } finally {
      syncing = false;
      running = null;
      emit('sync', { syncing: false });
    }
  })();
  return running;
}

export function syncNow(reason = 'manual') {
  return workspace.run(() => syncNowLeased(reason));
}

/** 本机有改动：几秒后同步（自动同步打开时）。 */
async function scheduleSoon() {
  const s = await getSettings();
  if (!s.sync.auto) {
    emit('sync', { pending: true });
    return;
  }
  const auth = await google.status();
  if (!auth.signedIn) return;
  clearTimeout(soonTimer);
  const epoch = workspace.current().epoch;
  soonTimer = setTimeout(() => workspace.run(() => syncNowLeased('change'), epoch).catch(() => {}), 4000);
  // 后台可能在 4 秒内被浏览器挂起，留一个闹钟兜底。
  chrome.alarms.create(SOON_ALARM, { when: Date.now() + 45000 });
}

export function install() {
  onLocalChange((topics) => {
    if (topics.some((t) => ['bookmarks', 'groups', 'notes', 'tasks', 'vault', 'settings'].includes(t))) workspace.run(scheduleSoon).catch(() => {});
  });
  chrome.alarms.get(PERIODIC_ALARM).then((a) => {
    if (!a) chrome.alarms.create(PERIODIC_ALARM, { periodInMinutes: 15 });
  });
}

workspace.onSwitch(async () => {
  clearTimeout(soonTimer);
  soonTimer = null;
  await chrome.alarms.clear(SOON_ALARM);
});

export async function onAlarm(alarm) {
  if (alarm.name !== SOON_ALARM && alarm.name !== PERIODIC_ALARM) return false;
  const s = await getSettings();
  if (s.sync.auto) await syncNow(alarm.name === SOON_ALARM ? 'change' : 'periodic');
  return true;
}

export async function status() {
  const [auth, st, s] = await Promise.all([google.status(), state(), getSettings()]);
  let pending = 0;
  const bound = st.account === auth.user?.googleSub && st.clientId === runtimeClientId();
  if (auth.signedIn) {
    pending = await pendingCount(bound ? st.acknowledged : null, s);
  }
  return {
    configured: auth.configured,
    signedIn: auth.signedIn,
    user: auth.user,
    reauth: auth.reauth,
    otherAccount: auth.otherAccount,
    auto: s.sync.auto,
    what: { bookmarks: s.sync.bookmarks, notes: s.sync.notes, vault: s.sync.vault, tools: s.sync.tools },
    syncing,
    lastSyncAt: bound ? st.lastSyncAt || 0 : 0,
    lastError: st.lastError,
    lastErrorCode: st.lastErrorCode,
    pending,
    conflicts: st.conflicts || [],
    vaultConflict: !!(await db.kvGet('vaultConflict')),
  };
}

export async function dismissConflict(id) {
  const st = await state();
  await patchState({ conflicts: (st.conflicts || []).filter((c) => c.id !== id) });
  emit('sync');
  return { ok: true };
}

/** 删除云端同步文件（本机资料保留），并暂停自动同步，避免马上又传上去。 */
export async function clearCloud() {
  const auth = await google.status();
  if (!auth.signedIn) throw new UserError('还没有登录 Google');
  if (clearing) throw new UserError('正在清理云端资料', 'SYNC_BUSY');
  clearing = true;
  try {
    await updateSettings({ sync: { auto: false } });
    clearTimeout(soonTimer);
    await chrome.alarms.clear(SOON_ALARM);
    if (running) await running;
    const files = [...await drive.findFile(SYNC_FILE_NAME), ...await drive.findFile(SNAPSHOT_FILE_NAME)];
    for (const f of files) await drive.remove(f.id);
    await patchState({ fileId: null, lastSyncAt: 0, acknowledged: null, account: auth.user.googleSub, clientId: runtimeClientId() });
    emit('sync');
    return { removed: files.length };
  } finally { clearing = false; }
}

