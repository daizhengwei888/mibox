// 快速搜索面板：在收藏、笔记、保险箱里一起搜。网页浮层、独立小窗口和完整页的 Ctrl+K 共用。

import { html, morph, bind, scheduler } from '../kit/dom.js';
import { icon } from '../kit/icons.js';
import { tile, copyText, openApp } from '../kit/ui.js';
import { call } from '../../shared/client.js';
import { makeMatcher, splitHit, excerpt, noteTitle, domainOf, isWebUrl, siteMatches } from '../../shared/util.js';

const SCOPES = [
  ['all', '全部'],
  ['bookmarks', '收藏'],
  ['notes', '笔记'],
  ['vault', '保险箱'],
];

function hl(text, q) {
  const [a, b, c] = splitHit(text, q);
  return html`${a}<mark>${b}</mark>${c}`;
}

/**
 * opts: { mode: 'overlay'|'window'|'app', initial, pageUrl, pageTitle, onClose, onOpenNote, onOpenVault }
 */
export function mountSearch(holder, opts) {
  const state = {
    q: opts.initial || '',
    scope: 'all',
    sel: 0,
    data: null,
    vault: null,
    unlockOpen: false,
    pw: '',
    pwErr: '',
    pending: null,
    status: '',
    statusTone: '',
  };
  const render = scheduler(draw);
  let flat = [];
  let statusTimer = null;

  async function load() {
    const [lib, notes, vaultItems, vault] = await Promise.all([call('library.get'), call('notes.list'), call('vault.list'), call('vault.status')]);
    state.data = { bookmarks: lib.bookmarks, groups: lib.groups, settings: lib.settings, notes, vaultItems };
    state.vault = vault;
    render();
  }

  function say(text, tone = '') {
    state.status = text;
    state.statusTone = tone;
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => {
      state.status = '';
      render();
    }, 3000);
    render();
  }

  function actions() {
    const list = [];
    if (opts.mode === 'overlay' && isWebUrl(opts.pageUrl)) list.push({ kind: 'action', id: 'save', title: '收藏当前网页', sub: opts.pageTitle || domainOf(opts.pageUrl), ic: 'bookmark' });
    list.push({ kind: 'action', id: 'note', title: '新建笔记', sub: '在完整页打开编辑器', ic: 'note' });
    list.push({ kind: 'action', id: 'app', title: '打开完整页', sub: '整理收藏、管理分组和设置', ic: 'external' });
    return list;
  }

  function compute() {
    const d = state.data;
    const q = state.q.trim();
    const match = makeMatcher(q);
    const groupName = new Map(d.groups.map((g) => [g.id, g.name]));
    let bms;
    if (q) bms = d.bookmarks.filter((b) => match(b.title, b.url, b.note, groupName.get(b.groupId)));
    else bms = d.bookmarks.filter((b) => b.favorite).sort((a, b) => (a.favOrder || 0) - (b.favOrder || 0));
    if (q) {
      // 标题命中的排前面。
      const lq = q.toLowerCase();
      bms.sort((a, b) => (b.title.toLowerCase().includes(lq) ? 1 : 0) - (a.title.toLowerCase().includes(lq) ? 1 : 0) || (b.openedAt || b.createdAt) - (a.openedAt || a.createdAt));
    }
    const notes = q ? d.notes.filter((n) => match(n.title, n.body, n.sourceTitle)) : d.notes.slice(0, 3);
    const vault = q ? d.vaultItems.filter((v) => match(v.name, v.site)) : [];
    const acts = q ? actions().filter((a) => match(a.title)) : actions();
    return { bms, notes, vault, acts, groupName };
  }

  function draw() {
    if (!state.data) {
      // 资料还没读出来时也先给出输入框，先打的字不会丢。
      morph(
        holder,
        html`<div class="qs-panel" role="dialog" aria-label="搜索收藏、笔记和保险箱">
          <div class="qs-input-row">${icon('search', 20, { cls: 'qs-search-icon' })}
            <input id="qs-input" class="qs-input" type="search" value="${state.q}" data-input="q" data-keydown="key" placeholder="搜索收藏、笔记、保险箱" autocomplete="off" spellcheck="false" aria-label="搜索收藏、笔记和保险箱">
            <button type="button" class="qs-esc" data-click="close" aria-label="关闭"><kbd>Esc</kbd></button></div>
          <div class="qs-loading"><span class="spinner"></span>正在读取…</div></div>`,
      );
      return;
    }
    const q = state.q.trim();
    const r = compute();
    const scope = state.scope;
    const cap = (n, s) => (scope === s ? 50 : scope === 'all' ? n : 0);
    const shownB = r.bms.slice(0, cap(q ? 5 : 6, 'bookmarks'));
    const shownN = r.notes.slice(0, cap(3, 'notes'));
    const shownV = r.vault.slice(0, cap(4, 'vault'));
    const shownA = scope === 'all' ? r.acts.slice(0, q ? 2 : 3) : [];
    flat = [
      ...shownB.map((x) => ({ kind: 'bookmark', item: x })),
      ...shownN.map((x) => ({ kind: 'note', item: x })),
      ...shownV.map((x) => ({ kind: 'vault', item: x })),
      ...shownA.map((x) => ({ kind: 'action', item: x })),
    ];
    if (state.sel >= flat.length) state.sel = Math.max(0, flat.length - 1);
    let idx = 0;
    const on = () => idx++ === state.sel;
    const unlocked = state.vault?.unlocked;
    const pageUrl = opts.pageUrl;
    const counts = { all: r.bms.length + r.notes.length + r.vault.length, bookmarks: r.bms.length, notes: r.notes.length, vault: r.vault.length };
    const empty = q && !flat.length;

    const section = (label, more, moreScope, body) => html`<section class="qs-sec"><div class="qs-sec-head"><span>${label}</span>${more ? html`<button type="button" class="qs-more" data-click="scope" data-s="${moreScope}">查看全部 ${more} 条</button>` : ''}</div>${body}</section>`;

    morph(
      holder,
      html`<div class="qs-panel" role="dialog" aria-label="搜索收藏、笔记和保险箱">
        <div class="qs-input-row">
          ${icon('search', 20, { cls: 'qs-search-icon' })}
          <input id="qs-input" class="qs-input" type="search" value="${state.q}" data-input="q" data-keydown="key" placeholder="搜索收藏、笔记、保险箱" autocomplete="off" spellcheck="false" aria-label="搜索收藏、笔记和保险箱" aria-controls="qs-results">
          <button type="button" class="qs-esc" data-click="close" aria-label="关闭"><kbd>Esc</kbd></button>
        </div>
        <div class="qs-scopes" role="group" aria-label="搜索范围">
          ${SCOPES.map(([k, t]) => html`<button type="button" class="chip" aria-pressed="${scope === k ? 'true' : 'false'}" data-click="scope" data-s="${k}">${t}${q ? html` <span class="qs-n">${counts[k]}</span>` : ''}</button>`)}
        </div>
        <div class="qs-results" id="qs-results">
          ${shownB.length
            ? section(q ? '收藏' : '星标收藏', scope === 'all' && r.bms.length > shownB.length ? r.bms.length : 0, 'bookmarks', shownB.map((b) => {
                const sel = on();
                return html`<a class="qs-row ${sel ? 'sel' : ''}" data-key="b-${b.id}" href="${b.url}" target="_blank" rel="noopener" data-click="openBookmark" data-id="${b.id}" ${sel ? html`aria-current="true"` : ''}>
                  ${tile(b.title, b.url, 30, state.data.settings.favicons)}
                  <span class="qs-main"><span class="qs-title">${hl(b.title, q)}</span><span class="qs-sub">${domainOf(b.url)}${r.groupName.get(b.groupId) ? ' · ' + r.groupName.get(b.groupId) : ''}${b.note && q ? ' · ' + excerpt(b.note, q, 40) : ''}</span></span>
                  ${sel ? html`<span class="qs-hint">打开<kbd>↵</kbd></span>` : ''}</a>`;
              }))
            : ''}
          ${shownN.length
            ? section(q ? '笔记' : '最近的笔记', scope === 'all' && r.notes.length > shownN.length ? r.notes.length : 0, 'notes', shownN.map((n) => {
                const sel = on();
                return html`<button type="button" class="qs-row ${sel ? 'sel' : ''}" data-key="n-${n.id}" data-click="openNote" data-id="${n.id}">
                  <span class="qs-icon">${icon('note', 15)}</span>
                  <span class="qs-main"><span class="qs-title">${hl(noteTitle(n), q)}</span><span class="qs-sub">${hl(excerpt(n.body, q, 70), q)}</span></span>
                  ${sel ? html`<span class="qs-hint">查看<kbd>↵</kbd></span>` : ''}</button>`;
              }))
            : ''}
          ${(shownV.length || (scope === 'vault' && q)) && state.vault
            ? section(unlocked ? '保险箱' : '保险箱（已锁定，只搜名称）', scope === 'all' && r.vault.length > shownV.length ? r.vault.length : 0, 'vault', html`
                ${!unlocked && state.unlockOpen
                  ? html`<form class="qs-unlock" data-submit="unlock"><label class="sr" for="qs-pw">主密码</label>
                      <input id="qs-pw" class="input" type="password" value="${state.pw}" data-input="pw" placeholder="输入主密码解锁" autocomplete="current-password">
                      <button type="submit" class="btn pri sm">解锁</button>${state.pwErr ? html`<span class="error-text">${state.pwErr}</span>` : ''}</form>`
                  : ''}
                ${shownV.map((v) => {
                  const sel = on();
                  const canFill = opts.mode === 'overlay' && v.kind === 'login' && v.site && siteMatches(v.site, pageUrl || '');
                  const verb = v.kind === 'login' ? '复制密码' : v.kind === 'key' ? '复制密钥' : '查看';
                  return html`<div class="qs-row ${sel ? 'sel' : ''}" data-key="v-${v.id}">
                    ${tile(v.name, v.site ? 'https://' + v.site : '', 30, false)}
                    <button type="button" class="qs-main qs-plain" data-click="useVault" data-id="${v.id}"><span class="qs-title">${hl(v.name, q)}</span><span class="qs-sub">${v.kind === 'login' ? v.site || '网站登录' : v.kind === 'key' ? '密钥和令牌' : '私密笔记'}</span></button>
                    ${canFill ? html`<button type="button" class="btn sm" data-click="fill" data-id="${v.id}">填入</button>` : ''}
                    ${sel ? html`<span class="qs-hint">${unlocked ? verb : '解锁'}<kbd>↵</kbd></span>` : ''}</div>`;
                })}
                ${scope === 'vault' && q && !shownV.length ? html`<p class="qs-empty-line">保险箱里没有匹配的条目。</p>` : ''}`)
            : ''}
          ${shownA.length
            ? section('操作', 0, '', shownA.map((a) => {
                const sel = on();
                return html`<button type="button" class="qs-row ${sel ? 'sel' : ''}" data-key="a-${a.id}" data-click="action" data-id="${a.id}">
                  <span class="qs-icon">${icon(a.ic, 15)}</span><span class="qs-main"><span class="qs-title">${a.title}</span><span class="qs-sub">${a.sub}</span></span>
                  ${sel ? html`<span class="qs-hint">执行<kbd>↵</kbd></span>` : ''}</button>`;
              }))
            : ''}
          ${empty
            ? html`<div class="qs-empty"><p><b>没有找到「${q}」</b></p><p class="muted">试试网址里的词，或者换个范围。收藏的标题、网址和备注都能搜到。</p></div>`
            : ''}
          ${!q && !flat.length ? html`<div class="qs-empty"><p class="muted">输入关键词，在收藏、笔记和保险箱里一起找。</p></div>` : ''}
        </div>
        <div class="qs-foot">
          ${state.status ? html`<span class="qs-status ${state.statusTone}" role="status">${state.status}</span>` : html`<span class="row" style="gap:4px"><kbd>↑</kbd><kbd>↓</kbd>选择</span><span class="row" style="gap:4px"><kbd>↵</kbd>打开</span><span class="row" style="gap:4px"><kbd>Tab</kbd>换范围</span>`}
          <span class="grow"></span><span class="row qs-hide-narrow" style="gap:4px">任何网页按<kbd>Alt</kbd><kbd>Shift</kbd><kbd>K</kbd></span>
        </div>
      </div>`,
    );
    const sel = holder.querySelector('.qs-row.sel');
    if (sel) sel.scrollIntoView({ block: 'nearest' });
  }

  // ───────── 动作 ─────────

  function close() {
    opts.onClose?.();
  }

  async function openBookmark(b, { current = false } = {}) {
    call('bookmarks.opened', { id: b.id }).catch(() => {});
    if (opts.mode === 'overlay' && current) {
      window.parent.postMessage({ sq: 'navigate', url: b.url }, '*');
      return;
    }
    const openInCurrent = current || (opts.mode === 'app' && state.data.settings.openIn === 'current');
    if (openInCurrent && opts.mode === 'app') location.href = b.url;
    else await chrome.tabs.create({ url: b.url, active: true });
    if (opts.mode === 'window') window.close();
    else close();
  }

  function openNote(n) {
    if (opts.onOpenNote) return opts.onOpenNote(n.id);
    openApp('/notes/' + n.id);
    if (opts.mode === 'window') window.close();
    else close();
  }

  async function useVault(v) {
    if (!state.vault.unlocked) {
      state.unlockOpen = true;
      state.pending = v.id;
      render();
      setTimeout(() => holder.querySelector('#qs-pw')?.focus(), 30);
      return;
    }
    if (v.kind === 'note') {
      if (opts.onOpenVault) return opts.onOpenVault(v.id);
      openApp('/vault?id=' + v.id);
      return close();
    }
    try {
      const full = await call('vault.reveal', { id: v.id });
      const value = v.kind === 'login' ? full.secret.password : full.secret.secret;
      if (!value) return say('这一条没有可复制的内容', 'warn');
      await copyText(value, { secret: true });
      say(state.data.settings.clipboardClear ? '已复制，30 秒后自动清空剪贴板' : '已复制', 'ok');
    } catch (e) {
      say(e.message, 'bad');
    }
  }

  async function fill(id) {
    try {
      const tab = await chrome.tabs.getCurrent();
      if (!tab) throw new Error('找不到当前网页');
      if (!state.vault.unlocked) {
        state.unlockOpen = true;
        state.pending = 'fill:' + id;
        render();
        setTimeout(() => holder.querySelector('#qs-pw')?.focus(), 30);
        return;
      }
      await call('vault.fill', { tabId: tab.id, id });
      close();
    } catch (e) {
      say(e.message, 'bad');
    }
  }

  async function runAction(id) {
    if (id === 'save') {
      try {
        const r = await call('bookmarks.save', { url: opts.pageUrl, title: opts.pageTitle });
        say(r.status === 'exists' ? '这个网页已经收藏过了' : '已收藏', 'ok');
        load();
      } catch (e) {
        say(e.message, 'bad');
      }
    } else if (id === 'note') {
      openApp('/notes/new');
      if (opts.mode === 'window') window.close();
      else close();
    } else if (id === 'app') {
      openApp('/home');
      if (opts.mode === 'window') window.close();
      else close();
    }
  }

  function activate(entry, { current = false } = {}) {
    if (!entry) return;
    if (entry.kind === 'bookmark') openBookmark(entry.item, { current });
    else if (entry.kind === 'note') openNote(entry.item);
    else if (entry.kind === 'vault') useVault(entry.item);
    else if (entry.kind === 'action') runAction(entry.item.id);
  }

  bind(holder, {
    q(e) {
      state.q = e.target.value;
      state.sel = 0;
      render();
    },
    key(e) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        state.sel = flat.length ? (state.sel + 1) % flat.length : 0;
        render();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        state.sel = flat.length ? (state.sel - 1 + flat.length) % flat.length : 0;
        render();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (state.data) activate(flat[state.sel], { current: e.shiftKey });
      } else if (e.key === 'Tab') {
        e.preventDefault();
        const i = SCOPES.findIndex((s) => s[0] === state.scope);
        state.scope = SCOPES[(i + (e.shiftKey ? SCOPES.length - 1 : 1)) % SCOPES.length][0];
        state.sel = 0;
        render();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        if (state.q) {
          state.q = '';
          e.target.value = '';
          render();
        } else close();
      }
    },
    close,
    scope(e, el) {
      state.scope = el.getAttribute('data-s');
      state.sel = 0;
      render();
      holder.querySelector('#qs-input')?.focus();
    },
    openBookmark(e, el) {
      e.preventDefault();
      const b = state.data.bookmarks.find((x) => x.id === el.getAttribute('data-id'));
      if (b) openBookmark(b, { current: e.shiftKey });
    },
    openNote(e, el) {
      const n = state.data.notes.find((x) => x.id === el.getAttribute('data-id'));
      if (n) openNote(n);
    },
    useVault(e, el) {
      const v = state.data.vaultItems.find((x) => x.id === el.getAttribute('data-id'));
      if (v) useVault(v);
    },
    fill: (e, el) => fill(el.getAttribute('data-id')),
    action: (e, el) => runAction(el.getAttribute('data-id')),
    pw(e) {
      state.pw = e.target.value;
      state.pwErr = '';
    },
    async unlock() {
      try {
        state.vault = await call('vault.unlock', { password: state.pw });
        state.pw = '';
        state.unlockOpen = false;
        const pending = state.pending;
        state.pending = null;
        say('保险箱已解锁', 'ok');
        if (pending?.startsWith('fill:')) fill(pending.slice(5));
        else if (pending) {
          const v = state.data.vaultItems.find((x) => x.id === pending);
          if (v) useVault(v);
        }
        holder.querySelector('#qs-input')?.focus();
      } catch (e) {
        state.pwErr = e.message;
        render();
      }
    },
  });

  holder.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && e.target.id !== 'qs-input') {
      e.preventDefault();
      close();
    }
  });

  draw();
  load()
    .then(() => {
      const input = holder.querySelector('#qs-input');
      if (input && document.activeElement !== input) input.focus();
    })
    .catch((e) => say(e.message, 'bad'));
  setTimeout(() => holder.querySelector('#qs-input')?.focus(), 0);

  return {
    destroy() {
      clearTimeout(statusTimer);
      holder.innerHTML = '';
    },
  };
}
