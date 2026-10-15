// 侧栏：边看边收藏、边记笔记。跟着当前标签页变化。

import { html, morph, bind, scheduler, debounce } from '../kit/dom.js';
import { icon, brandMark } from '../kit/icons.js';
import { tile, applyTheme, openApp, toast, toastError } from '../kit/ui.js';
import { call, onChange } from '../../shared/client.js';
import { isWebUrl, domainOf, formatWhen, makeMatcher, noteTitle, excerpt, originOf } from '../../shared/util.js';

const root = document.getElementById('root');
const state = {
  tab: 'marks',
  page: null, // { id, url, title }
  saved: null,
  bookmarks: [],
  groups: [],
  notes: [],
  settings: null,
  sync: null,
  q: '',
  draft: '',
  withSource: true,
  selection: null,
  windowId: null,
};
const render = scheduler(draw);

async function loadLibrary() {
  const [lib, notes, sync] = await Promise.all([call('library.get'), call('notes.list'), call('sync.status')]);
  state.bookmarks = lib.bookmarks;
  state.groups = lib.groups;
  state.settings = lib.settings;
  state.notes = notes;
  state.sync = sync;
  applyTheme(lib.settings.theme);
  await refreshSaved();
  render();
}

async function refreshPage() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, windowId: state.windowId ?? chrome.windows.WINDOW_ID_CURRENT });
    const prev = state.page?.url;
    state.page = tab ? { id: tab.id, url: tab.url || '', title: tab.title || '' } : null;
    if (prev !== state.page?.url) state.selection = null;
    await refreshSaved();
  } catch {}
  render();
}

async function refreshSaved() {
  state.saved = state.page && isWebUrl(state.page.url) ? await call('bookmarks.findByUrl', { url: state.page.url }).catch(() => null) : null;
}

function syncText() {
  const s = state.sync;
  if (!s?.signedIn) return html`<span class="dot"></span>未登录`;
  if (s.lastError) return html`<span class="dot danger"></span>同步出错`;
  if (!s.auto) return html`<span class="dot"></span>同步已暂停`;
  if (s.syncing || s.pending) return html`<span class="dot warn"></span>正在同步`;
  return html`<span class="dot ok"></span>已同步`;
}

function pageCard() {
  const p = state.page;
  if (!p || !isWebUrl(p.url)) {
    return html`<section class="page-card" aria-label="当前网页"><p class="small muted">当前标签页不是普通网页，不能收藏。</p></section>`;
  }
  const s = state.saved;
  const g = s ? state.groups.find((x) => x.id === s.groupId)?.name : '';
  return html`<section class="page-card" aria-label="当前网页">
    <div class="row" style="gap:10px">
      ${tile(p.title, p.url, 32, state.settings?.favicons)}
      <div class="grow"><div class="ellipsis" style="font-weight:600" title="${p.title}">${p.title || domainOf(p.url)}</div><div class="small muted ellipsis">${domainOf(p.url)}</div></div>
      ${s
        ? html`<span class="saved-tag" title="${g ? '在「' + g + '」' : ''}">${icon('check', 14, { stroke: 3 })}已收藏</span>`
        : html`<button type="button" class="btn pri sm" data-click="save">收藏</button>`}
      ${!state.selection ? html`<button type="button" class="btn sm" data-click="readSel" title="把网页上选中的文字摘出来存成笔记">${icon('scissors', 14)}摘录</button>` : ''}
    </div>
    ${state.selection
      ? html`<div class="sel-block"><span class="small muted">页面上选中的文字</span><blockquote>${state.selection}</blockquote>
          <div class="row"><button type="button" class="btn outline sm" data-click="saveSel">存为笔记</button><button type="button" class="btn ghost sm" data-click="clearSel">不要了</button></div></div>`
      : ''}
  </section>`;
}

function marksTab() {
  const match = makeMatcher(state.q);
  const list = state.bookmarks
    .filter((b) => match(b.title, b.url, b.note))
    .sort((a, b) => (b.favorite ? 1 : 0) - (a.favorite ? 1 : 0) || (a.favorite && b.favorite ? (a.favOrder || 0) - (b.favOrder || 0) : b.createdAt - a.createdAt))
    .slice(0, 200);
  const target = state.settings?.openIn === 'current' ? '' : '_blank';
  return html`<div class="tab-body">
    <label class="search-box">${icon('search', 15)}<span class="sr">搜索收藏</span><input id="sp-search" type="search" value="${state.q}" data-input="q" placeholder="搜索收藏" autocomplete="off"></label>
    <div class="list">
      ${list.map(
        (b) => html`<a class="item" data-key="${b.id}" href="${b.url}" ${target ? html`target="_blank" rel="noopener"` : ''} data-click="openMark" data-id="${b.id}" title="${b.note || b.title}">
          ${tile(b.title, b.url, 28, state.settings?.favicons)}
          <span class="grow"><span class="ellipsis" style="display:block;font-weight:500">${b.title}</span><span class="ellipsis small muted" style="display:block">${domainOf(b.url)}</span></span>
          ${b.favorite ? html`<span class="fav">${icon('star', 13)}</span>` : ''}</a>`,
      )}
      ${!list.length ? html`<p class="small muted" style="padding:12px 8px">${state.q ? '没有匹配的收藏。' : '还没有收藏。点上面的「收藏」存下当前网页。'}</p>` : ''}
    </div>
  </div>`;
}

function notesTab() {
  const p = state.page;
  const hasSource = p && isWebUrl(p.url);
  return html`<div class="tab-body">
    <form class="composer" data-submit="saveDraft">
      <label class="sr" for="sp-draft">快速记一条</label>
      <textarea id="sp-draft" rows="3" data-input="draft" data-keydown="draftKey" placeholder="记点什么，Ctrl+Enter 保存">${state.draft}</textarea>
      <div class="row" style="gap:8px">
        ${hasSource ? html`<label class="check small grow" style="min-width:0"><input type="checkbox" data-change="withSource" ${state.withSource ? 'checked' : ''}><span class="ellipsis">带上来源：${domainOf(p.url)}</span></label>` : html`<span class="grow"></span>`}
        <button type="submit" class="btn pri sm">保存</button>
      </div>
    </form>
    <div class="list notes">
      ${state.notes.slice(0, 100).map(
        (n) => html`<button type="button" class="note" data-key="${n.id}" data-click="openNote" data-id="${n.id}">
          <span class="nt">${noteTitle(n)}</span>
          ${n.body && n.title ? html`<span class="nb">${excerpt(n.body, '', 80)}</span>` : ''}
          <span class="small muted">${formatWhen(n.updatedAt)}${n.sourceUrl ? '，' + domainOf(n.sourceUrl) : ''}</span></button>`,
      )}
      ${!state.notes.length ? html`<p class="small muted" style="padding:12px 8px">还没有笔记。在上面随手记一条，会自动带上当前网页。</p>` : ''}
    </div>
  </div>`;
}

function draw() {
  morph(
    root,
    html`<header class="sp-head">
      <span class="brand">${brandMark(18)}</span>
      <div class="seg" role="group" aria-label="侧栏内容">
        <button type="button" aria-pressed="${state.tab === 'marks' ? 'true' : 'false'}" data-click="tab" data-t="marks">收藏</button>
        <button type="button" aria-pressed="${state.tab === 'notes' ? 'true' : 'false'}" data-click="tab" data-t="notes">笔记</button>
      </div>
      <span class="grow"></span>
      <button type="button" class="icon-btn" data-click="search" aria-label="搜索收藏、笔记和保险箱" title="搜索全部">${icon('search', 17)}</button>
    </header>
    ${pageCard()}
    ${state.tab === 'marks' ? marksTab() : notesTab()}
    <footer class="sp-foot"><span class="row small muted" style="gap:6px">${syncText()}</span><span class="grow"></span><button type="button" class="link-btn" data-click="app">打开完整页</button></footer>`,
  );
}

const setQ = debounce((v) => {
  state.q = v;
  render();
}, 100);

bind(root, {
  tab(e, el) {
    state.tab = el.getAttribute('data-t');
    render();
  },
  search() {
    chrome.windows.create({ url: chrome.runtime.getURL('src/ui/search/search.html?mode=window'), type: 'popup', width: 720, height: 620 });
  },
  async save() {
    try {
      const r = await call('bookmarks.save', { url: state.page.url, title: state.page.title });
      state.saved = r.bookmark;
      toast(r.status === 'exists' ? '已经收藏过了' : '已收藏');
      render();
    } catch (e) {
      toastError(e);
    }
  },
  readSel() {
    const p = state.page;
    if (!p || !isWebUrl(p.url)) return;
    const origin = originOf(p.url);
    // 读取选中文字需要这个网站的权限，在点击时申请。
    chrome.permissions.request({ origins: [origin + '/*'] }).then(async (ok) => {
      if (!ok) return toast('没有授权读取这个网站。也可以选中文字后右键「把选中的文字存为笔记」');
      const r = await call('page.selection', { tabId: p.id });
      if (!r?.text) return toast('网页上没有选中的文字');
      state.selection = r.text;
      render();
    });
  },
  clearSel() {
    state.selection = null;
    render();
  },
  async saveSel() {
    try {
      await call('notes.save', { title: '', body: state.selection, sourceUrl: state.page.url, sourceTitle: state.page.title });
      state.selection = null;
      state.tab = 'notes';
      toast('已存为笔记，记下了来源网址');
    } catch (e) {
      toastError(e);
    }
  },
  q: (e) => setQ(e.target.value),
  openMark(e, el) {
    call('bookmarks.opened', { id: el.getAttribute('data-id') }).catch(() => {});
    if (state.settings?.openIn === 'current') {
      e.preventDefault();
      chrome.tabs.update(state.page?.id, { url: el.getAttribute('href') });
    }
  },
  draft: (e) => (state.draft = e.target.value),
  draftKey(e) {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      saveDraft();
    }
  },
  saveDraft: () => saveDraft(),
  withSource: (e) => (state.withSource = e.target.checked),
  openNote: (e, el) => openApp('/notes/' + el.getAttribute('data-id')),
  app: () => openApp('/home'),
});
async function saveDraft() {
  const text = state.draft.trim();
  if (!text) return;
  const p = state.page;
  const src = state.withSource && p && isWebUrl(p.url) ? { sourceUrl: p.url, sourceTitle: p.title } : {};
  try {
    await call('notes.save', { title: '', body: text, ...src });
    state.draft = '';
    const ta = root.querySelector('#sp-draft');
    if (ta) ta.value = '';
    toast('已保存');
  } catch (e) {
    toastError(e);
  }
}

(async () => {
  try {
    const win = await chrome.windows.getCurrent();
    state.windowId = win.id;
  } catch {}
  await refreshPage();
  await loadLibrary().catch((e) => toastError(e));
  chrome.tabs.onActivated.addListener((info) => {
    if (info.windowId === state.windowId) refreshPage();
  });
  chrome.tabs.onUpdated.addListener((tabId, change) => {
    if (tabId === state.page?.id && (change.url || change.title || change.status === 'complete')) refreshPage();
  });
  onChange(['bookmarks', 'groups', 'notes', 'settings', 'sync'], () => loadLibrary().catch(() => {}));
})();
