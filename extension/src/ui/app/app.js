// 完整页外壳：左侧导航、路由、同步状态浮层、全局快捷键、搜索浮层。

import { html, morph, bind, scheduler } from '../kit/dom.js';
import { icon, brandMark } from '../kit/icons.js';
import { toast, toastError, openMenu, promptBox, confirmBox, tile, trapFocus } from '../kit/ui.js';
import * as uiKit from '../kit/ui.js';
import { domainOf, splitTitle } from '../../shared/util.js';
import { BUILD } from '../../shared/defaults.js';
import { call } from '../../shared/client.js';
import { formatWhen } from '../../shared/util.js';
import { store, init, subscribe, syncSummary } from './store.js';
import bookmarksPage from './pages/bookmarks.js';
import notesPage from './pages/notes.js';
import vaultPage from './pages/vault.js';
import toolsPage from './pages/tools.js';
import settingsPage from './pages/settings.js';
import welcomePage from './pages/welcome.js';
import independentPage from './pages/independent.js';
import homePage from './pages/home.js';
import publishPage from './pages/publish.js';
import { mountSearch } from '../search/search-core.js';

const PAGES = { home: homePage, bookmarks: bookmarksPage, notes: notesPage, vault: vaultPage, tools: toolsPage, publish: publishPage, settings: settingsPage, welcome: welcomePage, independent: independentPage };

const nav = document.getElementById('nav');
const main = document.getElementById('main');
const app = document.getElementById('app');

let current = null; // { name, instance }
let route = parseRoute();
let navOpen = false;
let dragGroupId = null;
let homeUi = { homeCollapsed: false, groupCollapsed: {}, none: false, allowMultipleGroups: true, lastOpenGroup: null, pinnedGroupIds: [], folderListCollapsed: true, skin: 'emboss', motion: true, hiddenOrigins: [], sidebarWidth: 248 };
let homeUiLastSuccess = { ...homeUi, groupCollapsed: {} };
let homeUiRevision = 0;
let homeUiQueue = Promise.resolve();
let homeUiGeneration = 0;
let lastOpenKey = null;
let navIndex = null;
let navWorkspaceBlocked = false;
const navExpandedCache = new Set();
let navGroupQuery = '';
let navFilterOpen = false;
let navScrollBeforeFilter = 0;
const navGroupLimits = new Map();
let pendingTheme = null;
let savingTheme = false;

export function parseRoute() {
  const raw = location.hash.replace(/^#\/?/, '') || 'home';
  const [path, qs] = raw.split('?');
  const parts = path.split('/').filter(Boolean);
  const name = PAGES[parts[0]] ? parts[0] : 'bookmarks';
  return { name, parts: parts.slice(1), query: new URLSearchParams(qs || ''), hash: '#/' + raw };
}

export function go(hash) {
  const target = hash.startsWith('#') ? hash : '#' + hash;
  if (location.hash === target) {
    route = parseRoute();
    current?.instance?.update?.(route);
    renderNav();
  } else {
    location.hash = target;
  }
}

const ctx = {
  get route() {
    return route;
  },
  go,
  store,
  subscribe,
  openSearch,
  openSyncPanel,
  openAppearance,
  refreshNav: () => scheduleNav(),
  refreshHomeNav: () => scheduleNav(),
  get homeUi() {
    return homeUi;
  },
  setHomeUi,
  applyUiPreferences(next = {}) {
    if (next.skin !== undefined) homeUi.skin = next.skin;
    if (next.motion !== undefined) homeUi.motion = !!next.motion;
    renderNav();
  },
};

async function loadHomeUi() {
  const generation = homeUiGeneration;
  const revision = homeUiRevision;
  try {
    const r = await call('home.uiGet');
    if (generation !== homeUiGeneration || revision !== homeUiRevision || document.documentElement.dataset.pendingAppearance === 'true') return;
    homeUi = { ...homeUi, ...r, groupCollapsed: r?.groupCollapsed || {}, none: !!r?.groupCollapsed?.none, pinnedGroupIds: Array.isArray(r?.pinnedGroupIds) ? r.pinnedGroupIds.slice(0, 5) : [], folderListCollapsed: r?.folderListCollapsed !== false, hiddenOrigins: Array.isArray(r?.hiddenOrigins) ? r.hiddenOrigins : [] };
    lastOpenKey = r?.lastOpenGroup || Object.keys(homeUi.groupCollapsed).find((id) => homeUi.groupCollapsed[id] === false) || null;
    homeUiLastSuccess = { ...homeUi, groupCollapsed: { ...homeUi.groupCollapsed }, pinnedGroupIds: [...homeUi.pinnedGroupIds], hiddenOrigins: [...homeUi.hiddenOrigins] };
    uiKit.applyAppearance?.(homeUi);
  } catch {}
}

function mergeHomeUi(next = {}) {
  if (next.lastOpenGroup !== undefined) lastOpenKey = next.lastOpenGroup;
  homeUi = {
    ...homeUi,
    homeCollapsed: next.homeCollapsed === undefined ? !!homeUi.homeCollapsed : !!next.homeCollapsed,
    groupCollapsed: next.groupCollapsed || homeUi.groupCollapsed || {},
    none: next.groupCollapsed ? !!next.groupCollapsed.none : !!homeUi.none,
    allowMultipleGroups: next.allowMultipleGroups === undefined ? !!homeUi.allowMultipleGroups : !!next.allowMultipleGroups,
    lastOpenGroup: next.lastOpenGroup === undefined ? homeUi.lastOpenGroup : next.lastOpenGroup,
    pinnedGroupIds: Array.isArray(next.pinnedGroupIds) ? next.pinnedGroupIds.slice(0, 5) : [...(homeUi.pinnedGroupIds || [])],
    folderListCollapsed: next.folderListCollapsed === undefined ? !!homeUi.folderListCollapsed : !!next.folderListCollapsed,
    skin: next.skin === undefined ? homeUi.skin : next.skin,
    sidebarWidth: next.sidebarWidth === undefined ? homeUi.sidebarWidth : next.sidebarWidth,
    motion: next.motion === undefined ? !!homeUi.motion : !!next.motion,
    hiddenOrigins: Array.isArray(next.hiddenOrigins) ? [...next.hiddenOrigins] : [...(homeUi.hiddenOrigins || [])],
  };
}

function cloneHomeUi(value = homeUi) {
  return { ...value, groupCollapsed: { ...(value.groupCollapsed || {}) }, pinnedGroupIds: [...(value.pinnedGroupIds || [])], hiddenOrigins: [...(value.hiddenOrigins || [])] };
}

function setHomeUi(payload = {}) {
  const revision = ++homeUiRevision;
  const generation = homeUiGeneration;
  const next = { ...homeUi, groupCollapsed: { ...(homeUi.groupCollapsed || {}) } };
  if (payload.homeCollapsed !== undefined) next.homeCollapsed = !!payload.homeCollapsed;
  if (payload.allowMultipleGroups !== undefined) {
    next.allowMultipleGroups = !!payload.allowMultipleGroups;
    if (!next.allowMultipleGroups) {
      const keep = next.groupCollapsed[lastOpenKey] === false ? lastOpenKey : Object.keys(next.groupCollapsed).find((key) => next.groupCollapsed[key] === false);
      if (keep) for (const key of Object.keys(next.groupCollapsed)) if (key !== keep) next.groupCollapsed[key] = true;
    }
  }
  if (payload.groupId !== undefined && payload.collapsed !== undefined) {
    const id = payload.groupId || 'none';
    next.groupCollapsed[id] = !!payload.collapsed;
    if (!payload.collapsed) lastOpenKey = id;
    if (!payload.collapsed && !next.allowMultipleGroups) {
      for (const key of Object.keys(next.groupCollapsed)) if (key !== id) next.groupCollapsed[key] = true;
    }
    next.none = !!next.groupCollapsed.none;
  }
  if (payload.pinnedGroupIds !== undefined) next.pinnedGroupIds = [...new Set(Array.isArray(payload.pinnedGroupIds) ? payload.pinnedGroupIds : [])].slice(0, 5);
  if (payload.folderListCollapsed !== undefined) next.folderListCollapsed = !!payload.folderListCollapsed;
  if (payload.skin !== undefined) next.skin = payload.skin;
  if (payload.sidebarWidth !== undefined) next.sidebarWidth = payload.sidebarWidth;
  if (payload.motion !== undefined) next.motion = !!payload.motion;
  if (payload.hiddenOrigins !== undefined) next.hiddenOrigins = [...new Set(Array.isArray(payload.hiddenOrigins) ? payload.hiddenOrigins : [])];
  if (payload.collapseAllGroups) {
    for (const key of Object.keys(next.groupCollapsed)) next.groupCollapsed[key] = true;
    next.none = true;
    lastOpenKey = null;
  }
  if (payload.lastOpenGroup !== undefined) next.lastOpenGroup = payload.lastOpenGroup;
  homeUi = next;
  if (payload.skin !== undefined || payload.motion !== undefined || payload.sidebarWidth !== undefined) {
    document.documentElement.dataset.pendingAppearance = 'true';
    if (payload.skin !== undefined) uiKit.withViewTransition(() => uiKit.applyAppearance(homeUi));
    else uiKit.applyAppearance(homeUi);
  }
  renderNav();
  const request = { ...payload };
  const task = homeUiQueue.then(async () => {
    if (generation !== homeUiGeneration) throw new Error('STALE_WORKSPACE');
    try {
      const result = await call('home.uiSet', request);
      if (generation !== homeUiGeneration) throw new Error('STALE_WORKSPACE');
      const optimistic = cloneHomeUi(homeUi);
      if (result && typeof result === 'object') {
        homeUi = cloneHomeUi(homeUiLastSuccess);
        mergeHomeUi(result);
        homeUiLastSuccess = cloneHomeUi(homeUi);
        homeUi = optimistic;
      }
      if (revision === homeUiRevision) {
        if (result && typeof result === 'object') mergeHomeUi(result);
        delete document.documentElement.dataset.pendingAppearance;
        uiKit.applyAppearance?.(homeUi);
      }
      scheduleNav();
      return result;
    } catch (e) {
      if (revision === homeUiRevision && generation === homeUiGeneration && e.message !== 'STALE_WORKSPACE') {
        homeUi = cloneHomeUi(homeUiLastSuccess);
        delete document.documentElement.dataset.pendingAppearance;
        uiKit.applyAppearance(homeUi);
        lastOpenKey = homeUi.lastOpenGroup || Object.keys(homeUi.groupCollapsed).find((id) => homeUi.groupCollapsed[id] === false) || null;
        renderNav();
        toastError(staleNotice && e.code === 'INVALID_UI_STATE' ? new Error('插件后台还是旧版本，请按页面顶部的提示重新启用插件') : e);
      }
      throw e;
    }
  });
  homeUiQueue = task.catch(() => undefined);
  return task;
}

// ───────────── 同步状态 ─────────────


let closeSyncPanel = null;
function openSyncPanel(anchor = null) {
  if (closeSyncPanel) {
    closeSyncPanel();
    return;
  }
  let busy = '';
  let error = '';
  const previousFocus = document.activeElement;
  const render = (box) => {
    const s = store.sync;
    const sum = syncSummary(s);
    const body = !s?.signedIn
      ? s && !s.configured
        ? html`<div class="col" style="gap:14px"><p class="muted" style="line-height:1.7">这个插件还没有配置 Google 登录，资料只保存在这台电脑上。可在<a href="#/settings/advanced" data-sp="go">设置 → 高级设置</a>中配置。</p></div>`
        : html`<div class="col" style="gap:14px">
          <p class="muted" style="line-height:1.7">还没有登录 Google。登录后，收藏、笔记和保险箱会同步到你自己的 Google Drive 应用私有空间，换一台电脑也能用。</p>
          <button type="button" class="btn pri" data-sp="signin" ${busy ? 'disabled' : ''}>${busy === 'signin' ? html`<span class="spinner"></span>正在打开登录…` : html`${icon('user', 16)}用 Chrome 里的 Google 账号登录`}</button>
          <p class="small muted" style="line-height:1.7">会用 Chrome 当前登录的 Google 账号；Chrome 还没登录时会先请你登录。</p>
        </div>`
      : html`<div class="col" style="gap:14px">
          <div class="row" style="gap:12px"><span class="avatar">${(s.user?.email || '?')[0].toUpperCase()}</span>
            <div class="grow"><div style="font-weight:600" class="ellipsis">${s.user?.email || ''}</div><div class="small muted">Google 账号</div></div></div>
          <dl class="kv">
            <dt>状态</dt><dd><span class="dot ${sum.dot}"></span> ${sum.detail}</dd>
            <dt>上次同步</dt><dd>${s.lastSyncAt ? formatWhen(s.lastSyncAt) : '还没有同步过'}</dd>
            <dt>待上传</dt><dd>${s.pending} 项</dd>
          </dl>
          ${s.conflicts?.length ? html`<div class="notice warn">${icon('alert', 16)}<span>有 ${s.conflicts.length} 条笔记两台电脑都改过，已另存副本。<a href="#/settings/account" data-sp="go">去看看</a></span></div>` : ''}
          ${s.vaultConflict ? html`<div class="notice warn">${icon('alert', 16)}<span>云端已经有另一个保险箱。<a href="#/vault" data-sp="go">去合并</a></span></div>` : ''}
          <p class="small muted" style="line-height:1.7">资料存在你自己的 Google Drive 应用私有空间，只有本插件能读写，不会出现在 Drive 文件列表里。</p>
          <div class="row wrap">
            ${s.reauth || s.otherAccount ? html`<button type="button" class="btn pri sm" data-sp="signin" ${busy ? 'disabled' : ''}>${busy === 'signin' ? html`<span class="spinner"></span>正在登录…` : '重新登录'}</button>` : html`<button type="button" class="btn pri sm" data-sp="now" ${s.syncing || busy ? 'disabled' : ''}>${s.syncing || busy === 'now' ? html`<span class="spinner"></span>正在同步…` : html`${icon('refresh', 14)}${error || s.lastError ? '重试同步' : '立即同步'}`}</button>`}
            <button type="button" class="btn sm" data-sp="pause" ${busy || s.syncing ? 'disabled' : ''}>${busy === 'pause' ? html`<span class="spinner"></span>正在更新…` : html`${s.auto ? icon('pause', 14) : icon('play', 14)}${s.auto ? '暂停同步' : '继续同步'}`}</button>
            <a class="btn ghost sm" href="#/settings/account" data-sp="go">同步设置</a>
          </div>
        </div>`;
    box.setAttribute('aria-busy', busy ? 'true' : 'false');
    box.innerHTML = String(html`<div class="modal-head"><h2>同步</h2><button type="button" class="icon-btn" data-sp="close" aria-label="关闭">${icon('x', 18)}</button></div>${error ? html`<div class="notice danger" role="alert">${icon('alert', 16)}<span>${error}。资料仍保存在本机，可以重试。</span></div>` : ''}`) + String(body);
  };
  const scrim = document.createElement('div');
  scrim.className = 'popover-scrim';
  const box = document.createElement('div');
  box.className = 'popover';
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-modal', 'true');
  box.setAttribute('aria-label', '同步状态');
  // 从顶栏的「已同步」打开时，浮层在按钮正下方展开；从侧栏底部打开时仍在左下角。
  if (anchor?.isConnected && !anchor.closest('.nav')) {
    const r = anchor.getBoundingClientRect();
    box.classList.add('is-anchored');
    box.style.top = Math.round(r.bottom + 8) + 'px';
    box.style.left = Math.max(12, Math.min(Math.round(r.left), innerWidth - Math.min(380, innerWidth - 24) - 12)) + 'px';
    box.style.bottom = 'auto';
  }
  scrim.appendChild(box);
  document.body.appendChild(scrim);
  render(box);
  const unsub = subscribe(() => render(box));
  const releaseTrap = trapFocus(box);
  const onKey = (e) => e.key === 'Escape' && close();
  function close() {
    unsub();
    releaseTrap();
    document.removeEventListener('keydown', onKey);
    scrim.remove();
    closeSyncPanel = null;
    if (previousFocus?.isConnected) previousFocus.focus();
  }
  closeSyncPanel = close;
  document.addEventListener('keydown', onKey);
  scrim.addEventListener('mousedown', (e) => e.target === scrim && close());
  box.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-sp]');
    if (!b) return;
    const act = b.getAttribute('data-sp');
    if (act === 'close' || act === 'go') { close(); return; }
    if (busy) return;
    busy = act;
    error = '';
    render(box);
    try {
      if (act === 'signin') {
        await call('google.signIn');
        toast('已登录 Google，当前账号的资料库已打开');
      }
      if (act === 'now') {
        await call('sync.now');
        toast('同步完成');
      }
      if (act === 'pause') {
        const next = await call('sync.setAuto', { auto: !store.sync.auto });
        if (next?.lastError) throw new Error(next.lastError);
      }
    } catch (err) {
      error = err.message;
    } finally {
      busy = '';
      if (closeSyncPanel === close) render(box);
    }
  });
  setTimeout(() => box.querySelector('button')?.focus(), 0);
}

// ───────────── 外观浮层（首页右上角） ─────────────

// 预览色取自 base.css 各材质的 背景 / 卡片 / 选中底色 / 强调色，浅色与深色各一组。
const SKIN_CHOICES = [
  ['dusk-widgets', '暮色', 'Dusk Widgets', ['#e6e6e8', '#e8e8ea', '#d9dce6', '#14142c'], ['#1d1e24', '#21222a', '#1a2740', '#5fc6ff']],
  ['neo-apple', '玻璃', '暖瓷 · 丝光', ['#e6dbd2', '#ffffff', '#f6bf87', '#0b6e52'], ['#1d1b18', '#39352f', '#c77432', '#3fbf93']],
  ['liquid', '灰紫', '厚板 · 紫光', ['#bdbab5', '#efeeea', '#bdb6d6', '#7f9886'], ['#262624', '#3a3a37', '#625a82', '#6c8876']],
  ['ivory-cobalt', '象牙钴蓝', '软垫 · 钴蓝', ['#f5f1eb', '#f4f0ea', '#dfe7f7', '#0b5ae4'], ['#1f2229', '#252830', '#1f2f52', '#4f8bff']],
  ['mist-slate', '雾灰', '冷雾 · 叠层玻璃', ['#dfe5ee', '#f3f6fa', '#dbe5f8', '#5f88e8'], ['#161b23', '#2b3441', '#22314f', '#7d9ff0']],
  ['cardiology', '深壳荧光', '石墨 · 荧光节点', ['#4d4f4e', '#e2e2dc', '#efefea', '#e3ec4f'], ['#1c1d1d', '#2a2c2b', '#343635', '#e3ec4f']],
  ['cream-paper', '素笺', '轻拟物 · 白纸金线', ['#eeece7', '#fffefb', '#f0ede7', '#1b1a17'], ['#171614', '#262421', '#312f2b', '#f2eee6']],
  ['smoked-glass', '液态玻璃', 'Liquid Glass', ['#c4c6ca', '#e3e4e7', '#f5f5f7', '#141416'], ['#131417', '#2a2b2e', '#45464a', '#ffffff']],
  ['emboss', '浮雕', 'Emboss · 默认', ['#f5f4f0', '#fffefa', '#dfeadf', '#355e4b'], ['#141815', '#202721', '#2c4033', '#a9ceb5']],
];

let closeAppearance = null;
function openAppearance(anchor) {
  if (closeAppearance) {
    closeAppearance();
    return;
  }
  const previousFocus = document.activeElement;
  const scrim = document.createElement('div');
  scrim.className = 'popover-scrim';
  const box = document.createElement('div');
  box.className = 'popover appearance-pop';
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-modal', 'true');
  box.setAttribute('aria-label', '外观');
  scrim.appendChild(box);
  document.body.appendChild(scrim);
  const sw = (on, act, label) => html`<button type="button" class="switch" role="switch" aria-checked="${on ? 'true' : 'false'}" aria-label="${label}" data-click="${act}"></button>`;
  const seg = (label, act, current, options) => {
    const pick = options.some(([k]) => k === current) ? current : options[0]?.[0];
    return html`<div class="seg" role="radiogroup" aria-label="${label}">${options.map(([k, t]) => html`<button type="button" role="radio" tabindex="${k === pick ? '0' : '-1'}" aria-checked="${current === k ? 'true' : 'false'}" data-click="${act}" data-k="${k}">${t}</button>`)}</div>`;
  };
  const place = () => {
    const r = anchor.isConnected ? anchor.getBoundingClientRect() : { bottom: 56, right: innerWidth - 12 };
    const top = Math.round(r.bottom + 8);
    box.style.top = top + 'px';
    box.style.right = Math.max(12, Math.round(innerWidth - r.right)) + 'px';
    box.style.maxHeight = Math.max(240, innerHeight - top - 12) + 'px';
  };
  const render = () => {
    const st = store.settings || {};
    const skin = uiKit.UI_SKINS.includes(homeUi.skin) ? homeUi.skin : 'emboss';
    const width = homeUi.sidebarWidth || 248;
    morph(
      box,
      html`<div class="modal-head"><h2>外观</h2><button type="button" class="icon-btn" data-click="close" aria-label="关闭">${icon('x', 18)}</button></div>
        <div class="ap-row ap-theme"><span class="ap-label">明暗<span class="ap-hint">跟随系统，或固定浅色 / 深色</span></span>${seg('明暗', 'theme', pendingTheme ?? st.theme ?? 'system', [['system', '跟随系统'], ['light', '浅色'], ['dark', '深色']])}</div>
        <hr class="sep">
        <div class="ap-block"><span class="ap-label">材质与强调色</span>
          <div class="skin-grid" role="radiogroup" aria-label="材质与强调色">${SKIN_CHOICES.map(
            ([k, name, sub, l, d]) => html`<button type="button" class="skin-choice" role="radio" tabindex="${skin === k ? '0' : '-1'}" aria-checked="${skin === k ? 'true' : 'false'}" data-click="skin" data-k="${k}" style="--sw-bg:${l[0]};--sw-card:${l[1]};--sw-soft:${l[2]};--sw-accent:${l[3]};--sw-bg-d:${d[0]};--sw-card-d:${d[1]};--sw-soft-d:${d[2]};--sw-accent-d:${d[3]}">
              <span class="skin-preview" aria-hidden="true"><span class="skin-card"><span class="skin-pill"></span><span class="skin-dot"></span></span></span>
              <span class="skin-name">${name}</span><span class="skin-sub">${sub}</span></button>`,
          )}</div></div>
        <div class="ap-row"><span class="ap-label">轻动效<span class="ap-hint">关闭后保留交互反馈，不使用位移、缩放和呼吸动效</span></span>${sw(homeUi.motion !== false, 'motion', '轻动效')}</div>
        <hr class="sep">
        <div class="ap-row"><span class="ap-label">收藏显示方式</span>${seg('收藏显示方式', 'view', st.view, [['card', '卡片'], ['list', '列表'], ['compact', '紧凑']])}</div>
        <div class="ap-row"><span class="ap-label">网站图标<span class="ap-hint">用 Chrome 缓存的图标，关掉后只显示字母</span></span>${sw(!!st.favicons, 'favicons', '显示网站图标')}</div>
        <div class="ap-row"><label class="ap-label" for="ap-width">侧栏宽度</label><span class="row"><input id="ap-width" type="range" min="224" max="304" step="8" value="${width}" data-input="widthPreview" data-change="width"><output class="small muted" for="ap-width">${width}px</output></span></div>
        <div class="ap-row"><span class="ap-label">同时展开多个分组<span class="ap-hint">关闭后只保留最近展开的一组</span></span>${sw(!!homeUi.allowMultipleGroups, 'multiple', '同时展开多个分组')}</div>
        <p class="small muted">外观只保存在当前账号的这台电脑上，不参与同步。</p>`,
    );
  };
  const settled = (task) => task.catch(() => {}).finally(render);
  const unbind = bind(box, {
    close: () => close(),
    skin(e, el) {
      if (el.dataset.k === homeUi.skin) return;
      settled(setHomeUi({ skin: el.dataset.k }));
      render();
    },
    motion() {
      settled(setHomeUi({ motion: homeUi.motion === false }));
      render();
    },
    async theme(e, el) {
      const theme = el.dataset.k;
      if (!store.settings || (pendingTheme ?? store.settings.theme) === theme) return;
      pendingTheme = theme;
      uiKit.withViewTransition(() => uiKit.applyTheme(theme));
      render();
      if (savingTheme) return;
      savingTheme = true;
      let persistedTheme = store.settings.theme || 'system';
      let lastError = null;
      try {
        while (pendingTheme !== null) {
          const next = pendingTheme;
          try {
            const saved = await call('settings.update', { theme: next });
            persistedTheme = next;
            if (pendingTheme === next) pendingTheme = null;
            store.settings = { ...store.settings, ...saved, theme: pendingTheme ?? next };
            lastError = null;
          } catch (error) {
            lastError = error;
            if (pendingTheme === next) {
              pendingTheme = null;
              store.settings = { ...store.settings, theme: persistedTheme };
              uiKit.applyTheme(persistedTheme);
            }
          }
        }
        if (lastError) toastError(lastError);
      } finally {
        pendingTheme = null;
        savingTheme = false;
        render();
      }
    },
    // 开关和分段先变再保存：保存失败就退回并提示。
    view(e, el) {
      if (!store.settings || store.settings.view === el.dataset.k) return;
      const before = store.settings;
      store.settings = { ...before, view: el.dataset.k };
      render();
      call('settings.update', { view: el.dataset.k }).then((s) => { store.settings = s; render(); }).catch((err) => { store.settings = before; render(); toastError(err); });
    },
    favicons() {
      if (!store.settings) return;
      const before = store.settings;
      store.settings = { ...before, favicons: !before.favicons };
      render();
      call('settings.update', { favicons: store.settings.favicons }).then((s) => { store.settings = s; render(); }).catch((err) => { store.settings = before; render(); toastError(err); });
    },
    widthPreview(e, el) {
      document.documentElement.style.setProperty('--sidebar-width', el.value + 'px');
      el.nextElementSibling.textContent = el.value + 'px';
    },
    width(e, el) {
      settled(setHomeUi({ sidebarWidth: Number(el.value) }));
    },
    multiple() {
      settled(setHomeUi({ allowMultipleGroups: !homeUi.allowMultipleGroups }));
      render();
    },
  });
  const unsub = subscribe(() => render());
  const releaseTrap = trapFocus(box);
  const onKey = (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    }
  };
  function close() {
    unsub();
    unbind();
    releaseTrap();
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', place);
    scrim.remove();
    closeAppearance = null;
    if (previousFocus?.isConnected) previousFocus.focus();
  }
  closeAppearance = close;
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('resize', place);
  scrim.addEventListener('mousedown', (e) => e.target === scrim && close());
  place();
  render();
  setTimeout(() => box.querySelector('[aria-checked="true"]')?.focus(), 0);
}

// ───────────── 后台版本 ─────────────

// 更新已解压的插件文件夹后，Chrome 可能继续运行旧的后台脚本，新功能会被旧后台拒绝。
let staleNotice = null;
async function checkBackgroundBuild() {
  try {
    if ((await call('app.build'))?.build === BUILD) return;
  } catch (e) {
    if (e.code !== 'UNKNOWN') return;
  }
  staleNotice = document.createElement('div');
  staleNotice.className = 'notice danger stale-notice';
  staleNotice.setAttribute('role', 'alert');
  staleNotice.innerHTML = String(html`${icon('alert', 16)}<span class="grow">Chrome 还在运行旧版插件后台，外观、分组置顶等设置会保存失败。请在扩展管理页把「谜盒」关闭再打开（资料不会丢失，不要点「移除」），然后刷新本页。</span><button type="button" class="btn sm">打开扩展管理页</button>`);
  staleNotice.querySelector('button').addEventListener('click', () => chrome.tabs.create({ url: 'chrome://extensions/?id=' + chrome.runtime.id }));
  main.prepend(staleNotice);
}

// 后台调用失败时（重启、出错）不要静默用旧数据重绘，挂一条提示。
let storeErrorNotice = null;
function renderStoreError() {
  const msg = store.error || '';
  if (!msg) {
    storeErrorNotice?.remove();
    storeErrorNotice = null;
    return;
  }
  if (!storeErrorNotice) {
    storeErrorNotice = document.createElement('div');
    storeErrorNotice.className = 'notice danger stale-notice';
    storeErrorNotice.setAttribute('role', 'alert');
    storeErrorNotice.innerHTML = String(html`${icon('alert', 16)}<span class="grow"></span><button type="button" class="btn sm">重试</button>`);
    storeErrorNotice.querySelector('button').addEventListener('click', () => { store.error = ''; location.reload(); });
  }
  storeErrorNotice.querySelector('.grow').textContent = msg;
  if (!storeErrorNotice.isConnected) main.prepend(storeErrorNotice);
}

// ───────────── 搜索浮层（Ctrl+K） ─────────────

let searchClose = null;
function openSearch(initial = '') {
  if (searchClose) return;
  const scrim = document.createElement('div');
  scrim.className = 'search-scrim';
  const holder = document.createElement('div');
  holder.className = 'search-holder';
  scrim.appendChild(holder);
  document.body.appendChild(scrim);
  const prev = document.activeElement;
  const instance = mountSearch(holder, {
    mode: 'app',
    initial,
    onClose: () => close(),
    onOpenNote: (id) => {
      close();
      go('#/notes/' + id);
    },
    onOpenVault: (id) => {
      close();
      go('#/vault?id=' + id);
    },
  });
  function close() {
    instance.destroy();
    scrim.remove();
    searchClose = null;
    prev?.focus?.();
  }
  searchClose = close;
  scrim.addEventListener('mousedown', (e) => e.target === scrim && close());
}

// ───────────── 导航 ─────────────

const scheduleNav = scheduler(renderNav);

function renderNav() {
  if (navWorkspaceBlocked) {
    morph(nav, html``);
    return;
  }
  const r = route;
  const s = store.sync;
  nav.dataset.syncing = s?.syncing ? 'true' : 'false';
  main.dataset.syncing = s?.syncing ? 'true' : 'false';
  const sum = syncSummary(s);
  const groups = store.groups;
  if (!navIndex || navIndex.bookmarks !== store.bookmarks || navIndex.groups !== groups) {
    const groupIds = new Set(groups.map((g) => g.id));
    const byGroup = new Map();
    let ungrouped = [];
    let favs = [];
    for (const b of store.bookmarks) {
      const id = b.groupId && groupIds.has(b.groupId) ? b.groupId : '';
      if (!byGroup.has(id)) byGroup.set(id, []);
      byGroup.get(id).push(b);
      if (b.favorite) favs.push(b);
    }
    ungrouped = byGroup.get('') || [];
    navIndex = { bookmarks: store.bookmarks, groups, groupIds, byGroup, ungrouped, favs };
  }
  const { byGroup, favs, ungrouped } = navIndex;
  const countBy = new Map();
  for (const [id, list] of byGroup) if (id) countBy.set(id, list.length);
  const activeGroup = r.name === 'bookmarks' ? r.query.get('group') || '' : null;
  const vaultText = !store.vault.exists ? '未设置' : store.vault.unlocked ? '已解锁' : '已锁定';
  const item = (name, href, ic, label, extra) =>
    html`<a class="nav-item nav-${name}" href="${href}" ${(r.name === name || (name === 'tools' && r.name === 'publish')) && (name !== 'bookmarks' || !activeGroup) ? html`aria-current="page"` : ''}>${icon(ic, 16)}<span class="grow">${label}</span>${extra}</a>`;
  const previewLink = (b, key) => html`<a class="nav-preview" data-key="${key}" href="${b.url}" ${store.settings.openIn === 'current' ? '' : html`target="_blank" rel="noopener"`} title="${b.title} · ${domainOf(b.url)}">${tile(b.title, b.url, 18, !!store.settings.favicons)}<span class="nav-preview-title">${splitTitle(b.title, b.url).main}</span></a>`;
  const navExpanded = (id) => homeUi.groupCollapsed[id] === false;
  const groupBlock = (g, i) => {
    const collapsed = !navExpanded(g.id);
    if (!collapsed) navExpandedCache.add(g.id);
    const items = byGroup.get(g.id) || [];
    const cached = navExpandedCache.has(g.id);
    const active = activeGroup === g.id;
    const limit = navGroupLimits.get(g.id) || 8;
    return html`<div class="nav-group-block" data-key="group-${g.id}">
      <div class="nav-sub nav-group-head ${active ? 'is-active' : ''}" draggable="true" data-group-id="${g.id}" data-dragstart="groupDragStart" data-dragover="groupDragOver" data-drop="groupDrop" data-dragend="groupDragEnd" data-dragleave="groupDragLeave" data-contextmenu="groupMenu">
        <button type="button" class="nav-chevron nav-group-toggle" data-click="toggleGroup" data-group-id="${g.id}" aria-expanded="${collapsed ? 'false' : 'true'}" aria-controls="nav-group-${g.id}" aria-label="${collapsed ? '展开' : '收起'}${g.name}">${icon('chevronRight', 13)}</button><a class="nav-group-link grow ellipsis" href="#/bookmarks?group=${g.id}" data-click="openGroup" data-group-id="${g.id}" title="${g.name}" ${active ? html`aria-current="page"` : ''}>${g.name}</a><span class="nav-count">${countBy.get(g.id) || 0}</span>
        <button type="button" class="icon-btn sm sub-more" data-click="groupMenu" data-group-id="${g.id}" aria-label="${g.name} 的更多操作">${icon('more', 14)}</button>
      </div>
      <div id="nav-group-${g.id}" class="nav-group-items ${collapsed ? 'is-collapsed' : 'is-open'}" aria-hidden="${collapsed ? 'true' : 'false'}" ${collapsed ? 'inert' : ''}>
        <div class="nav-panel-inner">${cached ? items.slice(0, limit).map((b) => previewLink(b, `gp-${b.id}`)) : ''}${items.length > limit ? html`<button type="button" class="nav-preview nav-more" data-click="moreGroup" data-group-id="${g.id}">再显示 8 条（还剩 ${items.length - limit} 条）</button>` : ''}</div>
      </div>
    </div>`;
  };
  const noneCollapsed = !navExpanded('none');
  if (!noneCollapsed) navExpandedCache.add('none');
  const noneCached = navExpandedCache.has('none');
  const query = navGroupQuery.trim().toLocaleLowerCase();
  const matchingGroups = groups.filter((g) => !query || g.name.toLocaleLowerCase().includes(query));
  const pinnedIds = new Set((homeUi.pinnedGroupIds || []).filter((id) => groups.some((g) => g.id === id)).slice(0, 5));
  const pinnedGroups = matchingGroups.filter((g) => pinnedIds.has(g.id));
  const otherGroups = matchingGroups.filter((g) => !pinnedIds.has(g.id));
  const manyGroups = groups.length > 12;
  const filtering = navFilterOpen || !!navGroupQuery;
  const folderListOpen = !!query || !homeUi.folderListCollapsed;
  const activeOutsideList = manyGroups && !folderListOpen ? otherGroups.find((g) => g.id === activeGroup) : null;
  const noneLimit = navGroupLimits.get('none') || 8;
  morph(
    nav,
    html`
    <div class="nav-top">
      <a class="nav-brand" href="#/bookmarks">${brandMark(22)}<span>谜盒</span></a>
      <button type="button" class="icon-btn nav-toggle" data-click="toggleNav" aria-label="${navOpen ? '收起菜单' : '展开菜单'}" aria-expanded="${navOpen ? 'true' : 'false'}">${icon(navOpen ? 'x' : 'menu', 20)}</button>
    </div>
    <div class="nav-body ${navOpen ? 'open' : ''}">
      <div class="nav-section">
        ${item('home', '#/home', 'clock', '首页', '')}
        ${filtering
          ? html`<div class="nav-label is-filter">${icon('search', 14)}<input class="nav-filter-input" type="search" aria-label="筛选分组" value="${navGroupQuery}" placeholder="筛选分组" data-input="groupFilter" data-keydown="groupFilterKey" data-blur="groupFilterBlur" autocomplete="off"><button type="button" class="icon-btn xs" data-click="closeGroupFilter" aria-label="关闭筛选">${icon('x', 14)}</button></div>`
          : html`<div class="nav-label"><span class="grow">分组</span>
              ${groups.length > 6 ? html`<button type="button" class="icon-btn xs" data-click="openGroupFilter" aria-label="筛选分组" title="筛选分组">${icon('search', 14)}</button>` : ''}
              <button type="button" class="icon-btn xs" data-click="newGroup" aria-label="新建分组" title="新建分组">${icon('plus', 14)}</button>
              ${groups.length ? html`<button type="button" class="icon-btn xs" data-click="collapseAllGroups" aria-label="全部收起" title="全部收起">${icon('collapse', 14)}</button>` : ''}</div>`}
        <div class="nav-groups" role="group" aria-label="分组">
          ${query ? '' : html`<a class="nav-sub nav-tree-link" href="#/bookmarks?group=fav" ${activeGroup === 'fav' ? html`aria-current="page"` : ''}><span class="nav-ico">${icon('star', 14, { cls: 'sub-star' })}</span><span class="grow ellipsis">星标</span>${favs.length ? html`<span class="nav-count">${favs.length}</span>` : ''}</a>`}
          ${pinnedGroups.map(groupBlock)}${activeOutsideList ? groupBlock(activeOutsideList) : ''}
          ${manyGroups && !query ? html`<div class="nav-folder-list ${folderListOpen ? 'is-open' : 'is-collapsed'}"><button type="button" class="nav-sub nav-folder-toggle" data-click="toggleFolderList" aria-controls="nav-other-folders" aria-expanded="${folderListOpen ? 'true' : 'false'}"><span class="nav-ico">${icon(folderListOpen ? 'chevronDown' : 'chevronRight', 13)}</span><span class="grow">${pinnedGroups.length ? '其他分组' : '全部分组'}</span><span class="nav-count">${otherGroups.length}</span></button><div id="nav-other-folders" class="nav-folder-items">${folderListOpen ? otherGroups.map(groupBlock) : ''}</div></div>` : otherGroups.map(groupBlock)}
          ${query && !matchingGroups.length ? html`<p class="nav-empty">没有叫「${navGroupQuery.trim()}」的分组</p>` : ''}
          ${ungrouped.length && !query ? html`<div class="nav-group-block" data-key="group-none">
            <div class="nav-sub nav-group-head ${activeGroup === 'none' ? 'is-active' : ''}" data-group-id="" data-dragover="groupDragOver" data-drop="groupDrop" data-dragleave="groupDragLeave"><button type="button" class="nav-chevron nav-group-toggle" data-click="toggleGroup" data-group-id="" aria-expanded="${noneCollapsed ? 'false' : 'true'}" aria-controls="nav-group-none" aria-label="${noneCollapsed ? '展开' : '收起'}未分类">${icon('chevronRight', 13)}</button><a class="nav-group-link grow" href="#/bookmarks?group=none" data-click="openGroup" data-group-id="" ${activeGroup === 'none' ? html`aria-current="page"` : ''}>未分类</a><span class="nav-count">${ungrouped.length}</span></div>
            <div id="nav-group-none" class="nav-group-items ${noneCollapsed ? 'is-collapsed' : 'is-open'}" aria-hidden="${noneCollapsed ? 'true' : 'false'}" ${noneCollapsed ? 'inert' : ''}><div class="nav-panel-inner">${noneCached ? ungrouped.slice(0, noneLimit).map((b) => previewLink(b, `np-${b.id}`)) : ''}${ungrouped.length > noneLimit ? html`<button type="button" class="nav-preview nav-more" data-click="moreGroup" data-group-id="">再显示 8 条（还剩 ${ungrouped.length - noneLimit} 条）</button>` : ''}</div></div>
          </div>` : ''}
          ${groups.length ? '' : html`<button type="button" class="nav-sub add" data-click="newGroup"><span class="nav-ico">${icon('plus', 14)}</span><span>新建分组</span></button>`}
        </div>
        <div class="nav-tools-section">
        ${item('bookmarks', '#/bookmarks', 'bookmark', '总收藏', html`<span class="nav-count">${store.counts.bookmarks}</span>`)}
        ${item('notes', '#/notes', 'note', '笔记', html`<span class="nav-count">${store.counts.notes}</span>`)}
        ${item('vault', '#/vault', store.vault.unlocked ? 'unlock' : 'lock', '保险箱', html`<span class="nav-state">${vaultText}</span>`)}
        ${item('tools', '#/tools', 'tool', '工具', '')}</div>
      </div>
      <div class="nav-foot">
        ${item('settings', '#/settings', 'settings', '设置', '')}
        <button type="button" class="nav-account" data-click="sync" aria-label="同步状态：${sum.text}">
          <span class="avatar">${s?.signedIn ? (s.user?.email || '?')[0].toUpperCase() : html`${icon('cloudOff', 14)}`}</span>
          <span class="grow" style="min-width:0;text-align:left">
            <span class="ellipsis" style="display:block;font-size:13px;font-weight:600">${s?.signedIn ? s.user?.email : '未登录 Google'}</span>
            <span class="row small muted" style="gap:6px"><span class="dot ${sum.dot}"></span>${sum.text}</span>
          </span>
        </button>
      </div>
    </div>`,
  );
}

function closeGroupFilter(focusButton) {
  navGroupQuery = '';
  navFilterOpen = false;
  renderNav();
  const list = nav.querySelector('.nav-groups');
  if (list) list.scrollTop = navScrollBeforeFilter;
  if (focusButton) nav.querySelector('[data-click="openGroupFilter"]')?.focus({ preventScroll: true });
}

bind(nav, {
  toggleNav() {
    navOpen = !navOpen;
    renderNav();
    if (!navOpen) nav.querySelector('.nav-toggle')?.focus({ preventScroll: true });
  },
  sync: () => openSyncPanel(),
  toggleGroup(e, el) {
    const groupId = el.getAttribute('data-group-id') || '';
    const collapsed = el.getAttribute('aria-expanded') === 'true';
    if (!collapsed) navExpandedCache.add(groupId || 'none');
    setHomeUi({ groupId, collapsed }).catch(() => {});
  },
  openGroup(e, el) {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    const groupId = el.getAttribute('data-group-id') || 'none';
    navExpandedCache.add(groupId);
    setHomeUi({ groupId: groupId === 'none' ? '' : groupId, collapsed: false }).catch(() => {});
    go(el.getAttribute('href'));
  },
  collapseAllGroups() {
    for (const id of [...navExpandedCache]) navExpandedCache.delete(id);
    setHomeUi({ collapseAllGroups: true }).catch(() => {});
  },
  // 分组筛选：平时只是「分组」标题旁的一个放大镜，点开才变成输入框；Esc 或 × 收回。
  openGroupFilter() {
    navScrollBeforeFilter = nav.querySelector('.nav-groups')?.scrollTop || 0;
    navFilterOpen = true;
    renderNav();
    nav.querySelector('.nav-filter-input')?.focus({ preventScroll: true });
  },
  groupFilter(e, el) {
    navGroupQuery = el.value || '';
    renderNav();
  },
  groupFilterKey(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeGroupFilter(true);
    } else if (e.key === 'Enter') {
      // 回车打开第一个匹配的分组
      const first = nav.querySelector('.nav-groups .nav-group-link');
      if (first) {
        e.preventDefault();
        first.click();
      }
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      nav.querySelector('.nav-groups .nav-group-link')?.focus();
    }
  },
  groupFilterBlur(e, el) {
    // 输入框空着、焦点离开侧栏的筛选行时自动收回
    if (!el.value && !e.relatedTarget?.closest?.('.nav-label')) setTimeout(() => !navGroupQuery && navFilterOpen && closeGroupFilter(false), 120);
  },
  closeGroupFilter: () => closeGroupFilter(true),
  moreGroup(e, el) {
    const id = el.getAttribute('data-group-id') || 'none';
    navGroupLimits.set(id, (navGroupLimits.get(id) || 8) + 8);
    renderNav();
  },
  toggleFolderList() {
    setHomeUi({ folderListCollapsed: !homeUi.folderListCollapsed }).catch(() => {});
  },
  async newGroup() {
    const name = await promptBox({ title: '新建分组', label: '分组名称', ok: '创建', placeholder: '比如：工作、学习' });
    if (name === null) return;
    try {
      const g = await call('groups.create', { name });
      go('#/bookmarks?group=' + g.id);
    } catch (e) {
      toastError(e);
    }
  },
  groupMenu(e, el) {
    e.preventDefault();
    e.stopPropagation();
    const id = el.getAttribute('data-group-id');
    const g = store.groups.find((x) => x.id === id);
    if (!g) return;
    openMenu(el, [
      {
        label: '重命名',
        icon: 'edit',
        run: async () => {
          const name = await promptBox({ title: '重命名分组', label: '分组名称', value: g.name });
          if (name === null) return;
          call('groups.rename', { id, name }).catch(toastError);
        },
      },
      {
        label: (homeUi.pinnedGroupIds || []).includes(id) ? '取消置顶' : '置顶分组',
        icon: 'pin',
        run: () => {
          const ids = [...(homeUi.pinnedGroupIds || [])].filter((x) => x !== id);
          if (!(homeUi.pinnedGroupIds || []).includes(id)) ids.unshift(id);
          setHomeUi({ pinnedGroupIds: ids.slice(0, 5) }).catch(() => {});
        },
      },
      {
        label: '删除分组',
        icon: 'trash',
        danger: true,
        run: async () => {
          const ok = await confirmBox({ title: `删除分组「${g.name}」？`, text: '组里的收藏不会删除，会回到「未分类」。', ok: '删除分组', danger: true });
          if (!ok) return;
          nav.querySelector('a[href="#/bookmarks"]')?.focus();
          try {
            await call('groups.remove', { id });
            if (route.query.get('group') === id) go('#/bookmarks');
          } catch (error) { toastError(error); }
        },
      },
    ], { alignLeft: true });
  },
  groupDragStart(e, el) {
    dragGroupId = el.getAttribute('data-group-id');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/x-sq-group', dragGroupId);
  },
  groupDragOver(e, el) {
    const types = e.dataTransfer.types;
    if (types.includes('text/x-sq-bookmarks') || (dragGroupId && types.includes('text/x-sq-group') && el.getAttribute('data-group-id'))) {
      e.preventDefault();
      el.classList.add('drop-target');
    }
  },
  groupDragLeave(e, el) {
    el.classList.remove('drop-target');
  },
  async groupDrop(e, el) {
    e.preventDefault();
    el.classList.remove('drop-target');
    const target = el.getAttribute('data-group-id');
    const ids = e.dataTransfer.getData('text/x-sq-bookmarks');
    if (ids) {
      const list = JSON.parse(ids);
      const r = await call('bookmarks.move', { ids: list, groupId: target || null }).catch(toastError);
      if (r) toast(r.moved ? `已移动 ${r.moved} 条到「${target ? store.groups.find((g) => g.id === target)?.name : '未分类'}」` : '已经在这个分组里了');
      return;
    }
    if (dragGroupId && target && dragGroupId !== target) {
      const order = store.groups.map((g) => g.id).filter((id) => id !== dragGroupId);
      order.splice(order.indexOf(target), 0, dragGroupId);
      call('groups.reorder', { ids: order }).catch(toastError);
    }
    dragGroupId = null;
  },
  groupDragEnd() {
    dragGroupId = null;
  },
});

nav.addEventListener('click', (e) => {
  if (e.target.closest('a.nav-item, a.nav-sub, a.nav-group-link, a.nav-preview') && navOpen && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey) {
    navOpen = false;
    scheduleNav();
    nav.querySelector('.nav-toggle')?.focus({ preventScroll: true });
  }
});

// ───────────── 页面切换 ─────────────

function mountPage(initial = false) {
  route = parseRoute();
  if (route.name !== 'home') closeAppearance?.();
  app.classList.toggle('bare', route.name === 'welcome' || route.name === 'independent');
  if (current && current.name === route.name && !route.unknown) {
    current.instance.update?.(route);
  } else {
    current?.instance?.unmount?.();
    // 每个页面用自己的容器，换页时整个丢掉，事件监听也跟着消失。
    main.innerHTML = '';
    window.scrollTo(0, 0);
    const pageRoot = document.createElement('div');
    pageRoot.className = 'page-root';
    main.appendChild(pageRoot);
    if (staleNotice) main.prepend(staleNotice);
    const page = PAGES[route.name];
    document.title = (page.title ? page.title + ' · ' : '') + '谜盒';
    current = { name: route.name, instance: page.mount(pageRoot, ctx) };
    if (route.unknown) {
      // 地址栏里是个不存在的页面：不要静默显示成收藏页，说清楚并给条回去的路。
      const notice = document.createElement('div');
      notice.className = 'notice warn';
      notice.setAttribute('role', 'status');
      notice.innerHTML = String(html`${icon('alert', 16)}<span class="grow">没有这个页面，已回到收藏。</span><a class="btn sm" href="#/home">回首页</a>`);
      pageRoot.prepend(notice);
    }
    // 换页后把焦点放到主区域，读屏才会播报新页面；首次打开不动，免得抢走地址栏焦点。
    if (!initial) main.focus({ preventScroll: true });
  }
  renderNav();
  renderStoreError();
}

window.addEventListener('hashchange', () => mountPage());

document.addEventListener('keydown', (e) => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '') || document.activeElement?.isContentEditable;
  if (!e.isComposing && (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    openSearch();
    return;
  }
  if (typing || e.ctrlKey || e.metaKey || e.altKey || document.querySelector('.modal-scrim:not([data-leaving]), .search-scrim')) return;
  if (e.key === '/') {
    if (current?.instance?.focusSearch) {
      e.preventDefault();
      current.instance.focusSearch();
    }
  } else if (e.key === 'n' || e.key === 'N') {
    e.preventDefault();
    go('#/notes/new');
  }
});

subscribe((topics = []) => {
  if (store.settings) uiKit.applyTheme(pendingTheme ?? store.settings.theme);
  if (topics.includes('workspace')) {
    navIndex = null;
    navExpandedCache.clear();
    navGroupLimits.clear();
    navGroupQuery = '';
    navFilterOpen = false;
    homeUiQueue = Promise.resolve();
    homeUiRevision++;
    homeUiGeneration++;
    lastOpenKey = null;
    renderNav();
  }
  if (topics.includes('appearance')) loadHomeUi().then(() => {
    current?.instance?.update?.(route);
    scheduleNav();
  });
  scheduleNav();
  renderStoreError();
});

window.addEventListener('workspace-changed', () => {
  navWorkspaceBlocked = true;
  navIndex = null;
  navExpandedCache.clear();
  navGroupLimits.clear();
  navGroupQuery = '';
  navFilterOpen = false;
  homeUiQueue = Promise.resolve();
  homeUiRevision++;
  homeUiGeneration++;
  lastOpenKey = null;
  renderNav();
});

function historyPermissionChanged(change, granted) {
  const permissions = Array.isArray(change) ? change : change?.permissions;
  if (!permissions?.includes?.('history')) return;
  scheduleNav();
}

if (typeof chrome !== 'undefined' && chrome.permissions) {
  chrome.permissions.onRemoved?.addListener((p) => historyPermissionChanged(p, false));
  chrome.permissions.onAdded?.addListener((p) => historyPermissionChanged(p, true));
}

(async () => {
  try {
    await init();
    await loadHomeUi();
  } catch (e) {
    main.innerHTML = String(html`<div class="page"><div class="notice danger">${icon('alert', 16)}<span>打不开资料库：${e.message}</span></div></div>`);
    return;
  }
  if (!store.settings.onboarded && !location.hash.startsWith('#/welcome') && !location.hash.startsWith('#/settings') && !location.hash.startsWith('#/independent')) {
    // 第一次打开完整页，先走一遍设置。
    location.hash = '#/welcome';
  }
  mountPage(true);
  checkBackgroundBuild();
})();
