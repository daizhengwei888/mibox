// 工具栏弹窗：一点就存。可以马上改名、换分组、设为星标、写备注，或者撤销；有保险箱账号时可以填入。

import { html, morph, bind, scheduler, debounce } from '../kit/dom.js';
import { icon } from '../kit/icons.js';
import { tile, applyTheme, openApp } from '../kit/ui.js';
import { call } from '../../shared/client.js';
import { isWebUrl, domainOf, formatWhen } from '../../shared/util.js';

const root = document.getElementById('root');
const state = {
  phase: 'loading', // loading | blocked | saved | undone | error
  tab: null,
  bookmark: null,
  existed: false,
  groups: [],
  settings: null,
  logins: [],
  vault: null,
  sync: null,
  newGroupOpen: false,
  newGroup: '',
  unlockFor: null,
  pw: '',
  pwErr: '',
  msg: '',
  err: '',
};
const render = scheduler(draw);

function groupName(id) {
  return state.groups.find((g) => g.id === id)?.name || '';
}

function syncLine() {
  const s = state.sync;
  if (!s || !s.signedIn) return html`<span class="dot"></span>未登录`;
  if (s.lastError) return html`<span class="dot danger"></span>同步出错`;
  if (!s.auto) return html`<span class="dot"></span>同步已暂停`;
  if (s.syncing || s.pending) return html`<span class="dot warn"></span>正在同步`;
  return html`<span class="dot ok"></span>已同步`;
}

/** 不能收藏的页面只说明类型，不显示一长串内部网址。 */
function pageKind(url = '') {
  if (url.startsWith('chrome-extension:')) return '扩展页面';
  if (/^(chrome|edge|brave):\/\/newtab|^chrome-search:/.test(url)) return '新标签页';
  if (/^(chrome|edge|brave):\/\/settings/.test(url)) return '浏览器设置页';
  if (url.startsWith('file:')) return '本地文件';
  if (/^(chrome|edge|brave|about|devtools|view-source):/.test(url)) return '浏览器内部页面';
  return url.split('?')[0] || '浏览器内部页面';
}

function banner() {
  const b = state.bookmark;
  if (state.phase === 'blocked') {
    return html`<div class="banner muted-banner" role="status"><span class="b-icon info">${icon('info', 15)}</span>
      <div class="grow"><div class="b-title">这个页面不能收藏</div><div class="b-sub ellipsis">${pageKind(state.tab?.url)}</div></div></div>`;
  }
  if (state.phase === 'undone') {
    return html`<div class="banner muted-banner" role="status"><span class="b-icon info">${icon('undo', 15)}</span>
      <div class="grow"><div class="b-title">已撤销</div><div class="b-sub">这个网页没有保存</div></div>
      <button type="button" class="btn pri sm" data-click="redo">重新收藏</button></div>`;
  }
  if (state.phase === 'error') {
    return html`<div class="banner muted-banner" role="alert"><span class="b-icon bad">${icon('alert', 15)}</span>
      <div class="grow"><div class="b-title">没能收藏</div><div class="b-sub">${state.err}</div></div></div>`;
  }
  const g = groupName(b.groupId);
  const title = state.existed ? '已经收藏过了' : g ? `已收藏到「${g}」` : '已收藏';
  const sub = state.existed ? `${formatWhen(b.createdAt)}存的${g ? `，在「${g}」` : ''}，下面的改动会自动保存` : '改名、换分组都会自动保存';
  return html`<div class="banner" role="status"><span class="b-icon ok">${icon('check', 15, { stroke: 3 })}</span>
    <div class="grow"><div class="b-title">${title}</div><div class="b-sub">${state.msg || sub}</div></div>
    ${!state.existed ? html`<button type="button" class="btn sm" data-click="undo">${icon('undo', 13)}撤销</button>` : ''}</div>`;
}

function form() {
  const b = state.bookmark;
  return html`<div class="body">
    <div class="row form-head">
      ${tile(b.title, b.url, 36, state.settings?.favicons)}
      <div class="grow col" style="gap:2px">
        <label class="sr" for="p-title">名称</label>
        <textarea id="p-title" class="title-edit" rows="2" data-input="title" data-blur="flushTitle" maxlength="256">${b.title}</textarea>
        <span class="small muted ellipsis">${domainOf(b.url)}</span>
      </div>
    </div>
    <div class="col" style="gap:8px" role="radiogroup" aria-label="分组">
      <span class="label">分组</span>
      <div class="row wrap" style="gap:6px">
        <button type="button" class="chip none-chip" role="radio" aria-checked="${!b.groupId ? 'true' : 'false'}" data-click="group" data-id="">未分类</button>
        ${state.groups.map((g) => html`<button type="button" class="chip" role="radio" aria-checked="${b.groupId === g.id ? 'true' : 'false'}" data-click="group" data-id="${g.id}">${g.name}</button>`)}
        ${state.newGroupOpen
          ? html`<form class="row" style="gap:4px" data-submit="createGroup"><label class="sr" for="p-ng">新分组名称</label><input id="p-ng" class="input" style="height:var(--h-sm);width:120px;font-size:var(--fs-sub)" value="${state.newGroup}" data-input="newGroup" placeholder="分组名称" autocomplete="off"><button type="submit" class="btn sm pri">添加</button></form>`
          : html`<button type="button" class="chip dashed" data-click="openNewGroup">${icon('plus', 13)}新分组</button>`}
      </div>
    </div>
    <button type="button" class="star-row" data-click="star" aria-pressed="${b.favorite ? 'true' : 'false'}">
      <span class="star ${b.favorite ? 'on' : ''}">${icon('star', 18)}</span><span class="grow">${b.favorite ? '已设为星标' : '设为星标'}</span><span class="small muted">显示在星标里</span></button>
    <div class="field"><label for="p-note">备注</label>
      <textarea id="p-note" class="textarea" rows="2" data-input="note" data-blur="flushNote" placeholder="写一句以后搜得到的话（可选）">${b.note || ''}</textarea></div>
    ${vaultBlock()}
  </div>`;
}

function vaultBlock() {
  if (!state.logins.length) return '';
  const unlocked = state.vault?.unlocked;
  return html`<div class="vault-box">
    <div class="row" style="gap:10px">${icon('lock', 17, { cls: 'accent' })}<span class="grow small">保险箱里有 ${state.logins.length} 个这个网站的账号</span></div>
    ${state.logins.map(
      (l) => html`<div class="row" style="gap:8px" data-key="${l.id}"><span class="grow ellipsis small" style="font-weight:600">${l.name}</span>
        <button type="button" class="btn sm outline" data-click="fill" data-id="${l.id}">填入账号</button></div>`,
    )}
    ${state.unlockFor
      ? html`<form class="row" style="gap:6px" data-submit="unlock"><label class="sr" for="p-pw">主密码</label>
          <input id="p-pw" class="input" style="height:var(--h-sm)" type="password" value="${state.pw}" data-input="pw" placeholder="输入主密码解锁" autocomplete="current-password">
          <button type="submit" class="btn sm pri">解锁</button></form>${state.pwErr ? html`<span class="error-text">${state.pwErr}</span>` : ''}`
      : !unlocked
        ? html`<span class="small muted">保险箱锁着，点「填入账号」时先输入主密码。</span>`
        : ''}
  </div>`;
}

function blockedBody() {
  return html`<div class="body">
    <p class="muted" style="line-height:1.7">浏览器设置页、扩展页、新标签页和本地文件不能收藏。你仍然可以：</p>
    <button type="button" class="big-link" data-click="search">${icon('search', 18)}<span class="grow">搜索收藏和笔记</span>${icon('chevronRight', 16)}</button>
    <button type="button" class="big-link" data-click="sidepanel">${icon('note', 18)}<span class="grow">在侧栏记一条笔记</span>${icon('chevronRight', 16)}</button>
  </div>`;
}

function draw() {
  if (state.phase === 'loading') {
    morph(root, html`<div class="loading"><span class="spinner"></span>正在收藏…</div>`);
    return;
  }
  morph(
    root,
    html`${banner()}
    ${state.phase === 'saved' ? form() : state.phase === 'blocked' ? blockedBody() : html`<div class="body grow"></div>`}
    <footer class="foot">
      <button type="button" class="foot-btn" data-click="sidepanel">${icon('sidebar', 16)}侧栏</button>
      <button type="button" class="foot-btn" data-click="app">${icon('external', 16)}完整页</button>
      <span class="grow"></span><span class="row small muted" style="gap:6px">${syncLine()}</span>
    </footer>`,
  );
}

// ───────── 保存改动 ─────────

async function patch(p) {
  if (!state.bookmark) return;
  try {
    state.bookmark = await call('bookmarks.update', { id: state.bookmark.id, patch: p });
    state.msg = '已保存';
    setTimeout(() => {
      state.msg = '';
      render();
    }, 1500);
  } catch (e) {
    state.msg = e.message;
  }
  render();
}
let titleDirty = false;
let noteDirty = false;
const saveTitle = debounce((v) => {
  if (!titleDirty) return;
  titleDirty = false;
  return patch({ title: v });
}, 400);
const saveNote = debounce((v) => {
  if (!noteDirty) return;
  noteDirty = false;
  return patch({ note: v });
}, 400);

async function loadVault() {
  if (!state.tab) return;
  const [logins, vault] = await Promise.all([call('vault.matchSite', { url: state.tab.url }), call('vault.status')]);
  state.logins = logins;
  state.vault = vault;
}

async function fill(id) {
  try {
    await call('vault.fill', { tabId: state.tab.id, id });
    window.close();
  } catch (e) {
    if (e.code === 'LOCKED') {
      state.unlockFor = id;
      render();
      setTimeout(() => root.querySelector('#p-pw')?.focus(), 30);
    } else {
      state.msg = e.message;
      render();
    }
  }
}

bind(root, {
  title: (e) => {
    titleDirty = true;
    saveTitle(e.target.value);
  },
  flushTitle: (e) => saveTitle.flush(e.target.value),
  note: (e) => {
    noteDirty = true;
    saveNote(e.target.value);
  },
  flushNote: (e) => saveNote.flush(e.target.value),
  group: (e, el) => patch({ groupId: el.getAttribute('data-id') || null }),
  star: () => patch({ favorite: !state.bookmark.favorite }),
  openNewGroup() {
    state.newGroupOpen = true;
    render();
    setTimeout(() => root.querySelector('#p-ng')?.focus(), 20);
  },
  newGroup: (e) => (state.newGroup = e.target.value),
  async createGroup() {
    try {
      const g = await call('groups.create', { name: state.newGroup });
      state.groups = await call('library.get').then((l) => l.groups);
      state.newGroupOpen = false;
      state.newGroup = '';
      await patch({ groupId: g.id });
    } catch (e) {
      state.msg = e.message;
      render();
    }
  },
  async undo() {
    await call('bookmarks.remove', { ids: [state.bookmark.id] });
    state.phase = 'undone';
    render();
  },
  async redo() {
    await call('bookmarks.restore', { ids: [state.bookmark.id] });
    state.phase = 'saved';
    render();
  },
  fill: (e, el) => fill(el.getAttribute('data-id')),
  pw: (e) => {
    state.pw = e.target.value;
    state.pwErr = '';
  },
  async unlock() {
    try {
      state.vault = await call('vault.unlock', { password: state.pw });
      state.pw = '';
      const id = state.unlockFor;
      state.unlockFor = null;
      await fill(id);
    } catch (e) {
      state.pwErr = e.message;
      render();
    }
  },
  sidepanel() {
    // 必须在点击时直接打开。
    chrome.sidePanel.open({ windowId: state.tab?.windowId ?? chrome.windows.WINDOW_ID_CURRENT }).then(() => window.close(), () => {});
  },
  app() {
    openApp('/home').then(() => window.close());
  },
  search() {
    chrome.windows.create({ url: chrome.runtime.getURL('src/ui/search/search.html?mode=window'), type: 'popup', width: 720, height: 620 }).then(() => window.close());
  },
});

// 弹窗关闭前把还没保存的改动发出去。
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'hidden') return;
  if (titleDirty) saveTitle.flush(root.querySelector('#p-title')?.value ?? '');
  if (noteDirty) saveNote.flush(root.querySelector('#p-note')?.value ?? '');
});

(async () => {
  draw();
  try {
    // ?tab=123 用于在普通标签页里调试弹窗。
    const forced = Number(new URLSearchParams(location.search).get('tab'));
    const [tab] = forced ? [await chrome.tabs.get(forced)] : await chrome.tabs.query({ active: true, currentWindow: true });
    state.tab = tab;
    const lib = await call('library.get');
    state.groups = lib.groups;
    state.settings = lib.settings;
    applyTheme(lib.settings.theme);
    call('sync.status').then((s) => ((state.sync = s), render())).catch(() => {});
    if (!tab || !isWebUrl(tab.url)) {
      state.phase = 'blocked';
      render();
      return;
    }
    const r = await call('bookmarks.save', { url: tab.url, title: tab.title });
    state.bookmark = r.bookmark;
    state.existed = r.status === 'exists';
    state.phase = 'saved';
    await loadVault().catch(() => {});
  } catch (e) {
    state.phase = 'error';
    state.err = e.message;
  }
  render();
})();
