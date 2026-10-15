// 笔记页：左边列表，右边编辑器。边写边自动保存，支持 Markdown 预览。

import { html, raw, morph, bind, scheduler, debounce } from '../../kit/dom.js';
import { icon } from '../../kit/icons.js';
import { toast, toastError } from '../../kit/ui.js';
import { renderMarkdown } from '../../kit/markdown.js';
import { call, onChange, getWorkspaceId } from '../../../shared/client.js';
import { formatWhen, makeMatcher, excerpt, noteTitle, domainOf, byteLength } from '../../../shared/util.js';

export default {
  title: '笔记',
  mount(root, ctx) {
    const state = {
      notes: [],
      loaded: false,
      q: '',
      currentId: null,
      isNew: false,
      title: '',
      body: '',
      dirty: false,
      saving: false,
      error: '',
      preview: false,
      workspaceId: null,
      pendingDraft: null,
      switching: false,
    };
    const render = scheduler(draw);

    async function load() {
      state.notes = await call('notes.list');
      state.workspaceId = getWorkspaceId();
      try {
        const key = state.workspaceId ? `shuqian.note-draft.${state.workspaceId}` : null;
        const raw = key && sessionStorage.getItem(key);
        if (raw) state.pendingDraft = { key, ...JSON.parse(raw) };
      } catch (_) { /* sessionStorage may be unavailable */ }
      state.loaded = true;
      syncCurrentFromList();
      render();
    }

    function current() {
      return state.notes.find((n) => n.id === state.currentId) || null;
    }

    function syncCurrentFromList() {
      if (state.isNew) return;
      const n = current();
      if (n && !state.dirty) {
        state.title = n.title;
        state.body = n.body;
      }
    }

    async function openRoute(route) {
      await save.flush?.();
      const id = route.parts[0] || null;
      state.preview = false;
      state.error = '';
      if (id === 'new') {
        state.isNew = true;
        state.currentId = null;
        state.title = '';
        state.body = '';
        state.dirty = false;
        render();
        setTimeout(() => root.querySelector('#note-body')?.focus(), 30);
        return;
      }
      state.isNew = false;
      state.currentId = id;
      state.dirty = false;
      const n = current();
      state.title = n?.title || '';
      state.body = n?.body || '';
      render();
    }

    async function doSave() {
      if (state.switching) return;
      if (!state.dirty) return;
      if (!state.isNew && !state.currentId) return;
      if (state.isNew && !state.title.trim() && !state.body.trim()) return;
      if (byteLength(state.body) > 65536) {
        state.error = '笔记太长了，单条上限 64 KB';
        render();
        return;
      }
      state.saving = true;
      state.error = '';
      render();
      const snapshot = { title: state.title, body: state.body };
      try {
        const saved = await call('notes.save', { id: state.isNew ? undefined : state.currentId, ...snapshot });
        if (state.title === snapshot.title && state.body === snapshot.body) state.dirty = false;
        if (state.isNew) {
          state.isNew = false;
          state.currentId = saved.id;
          history.replaceState(null, '', '#/notes/' + saved.id);
        }
        const i = state.notes.findIndex((n) => n.id === saved.id);
        if (i >= 0) state.notes[i] = saved;
        else state.notes.unshift(saved);
      } catch (e) {
        state.error = e.message;
      } finally {
        state.saving = false;
        render();
      }
    }
    const save = debounce(doSave, 700);

    function saveDraft() {
      if (!state.dirty || !state.workspaceId) return;
      try {
        sessionStorage.setItem(`shuqian.note-draft.${state.workspaceId}`, JSON.stringify({ workspaceId: state.workspaceId, route: location.hash, title: state.title, body: state.body }));
      } catch (_) { /* a draft is best effort */ }
    }

    // 列表里每条笔记的摘要要扫全文，打字时每帧都重算太浪费：按内容指纹记下来。
    const excerptCache = new Map();
    function listExcerpt(n) {
      const key = `${n.id}\u0000${n.updatedAt || 0}\u0000${state.q}`;
      let v = excerptCache.get(key);
      if (v === undefined) {
        const body = n.title ? n.body : n.body.split('\n').slice(1).join(' ');
        v = excerpt(body, state.q, 90) || ' ';
        if (excerptCache.size > 500) excerptCache.clear();
        excerptCache.set(key, v);
      }
      return v;
    }

    // 字数用内容比对来记忆化，避免每次渲染都把整篇正文摊成字符数组。
    let countBody = null;
    let countValue = 0;
    function charCount(body) {
      if (body !== countBody) {
        countBody = body;
        countValue = [...body].length;
      }
      return countValue;
    }

    function draw() {
      const match = makeMatcher(state.q);
      const list = state.notes.filter((n) => match(n.title, n.body, n.sourceTitle, n.sourceUrl));
      const cur = current();
      const hasCurrent = state.isNew || !!cur;
      const saveLabel = state.error ? '保存失败' : state.saving ? '正在保存…' : state.dirty ? '有改动' : state.isNew ? '开始输入就会自动保存' : '已保存';
      const saveDot = state.error ? 'danger' : state.saving || state.dirty ? 'warn' : 'ok';
      morph(
        root,
        html`<div class="notes ${hasCurrent ? 'has-current' : ''}">
          ${state.pendingDraft ? html`<div class="notice" role="status" style="grid-column:1/-1;margin:8px 12px">${icon('info', 16)}<span class="grow">上次切换账号时有一份未保存草稿（不会上传）。</span><button type="button" class="btn sm" data-click="restoreDraft">恢复草稿</button><button type="button" class="btn sm ghost" data-click="discardDraft">丢弃</button></div>` : ''}
          <section class="notes-list" aria-label="笔记列表">
            <div class="notes-list-head">
              <div class="row"><h1 style="font-size:22px;font-weight:700" class="grow">笔记</h1>
                <button type="button" class="btn pri sm" data-click="newNote">${icon('plus', 15)}新建</button></div>
              <label class="search-box">${icon('search', 15)}<span class="sr">搜索笔记</span>
                <input type="search" id="note-search" value="${state.q}" data-input="search" placeholder="搜索标题和正文" autocomplete="off"></label>
            </div>
            <div class="notes-items">
              ${list.map(
                (n) => html`<button type="button" class="note-item" data-key="${n.id}" data-click="pick" data-id="${n.id}" aria-current="${n.id === state.currentId ? 'true' : 'false'}">
                  <span class="t"><span class="ellipsis">${noteTitle(n)}</span>${n.pinned ? html`<span class="badge ok">置顶</span>` : ''}</span>
                  ${n.body ? html`<span class="ex">${listExcerpt(n)}</span>` : ''}
                  <span class="m"><span>${formatWhen(n.updatedAt)}</span>${n.sourceUrl ? html`<span class="ellipsis">${domainOf(n.sourceUrl)}</span>` : ''}</span>
                </button>`,
              )}
              ${state.loaded && !list.length
                ? html`<p class="muted small" style="padding:16px 12px;line-height:1.7">${state.q ? '没有匹配的笔记。换个关键词，或者新建一条。' : '还没有笔记。在网页上选中文字后右键「存为笔记」，或者在侧栏里随手记。'}</p>`
                : ''}
            </div>
          </section>
          <section class="note-editor" aria-label="笔记编辑器">
            ${hasCurrent
              ? html`<div class="note-bar">
                  <button type="button" class="icon-btn mobile-back" data-click="back" aria-label="返回笔记列表">${icon('arrowLeft', 18)}</button>
                  <span class="small muted">${cur ? '更新于 ' + formatWhen(cur.updatedAt) : '新笔记'}</span>
                  ${cur?.sourceUrl ? html`<a class="src" href="${cur.sourceUrl}" target="_blank" rel="noopener" title="${cur.sourceTitle || cur.sourceUrl}">${icon('link', 13)}来源 ${domainOf(cur.sourceUrl)}</a>` : ''}
                  <span class="grow"></span>
                  <div class="seg" role="group" aria-label="编辑或预览">
                    <button type="button" data-click="mode" data-v="edit" aria-pressed="${state.preview ? 'false' : 'true'}">编辑</button>
                    <button type="button" data-click="mode" data-v="preview" aria-pressed="${state.preview ? 'true' : 'false'}">预览</button>
                  </div>
                  ${cur ? html`<button type="button" class="btn sm" data-click="pin" aria-pressed="${cur.pinned ? 'true' : 'false'}">${icon('pin', 14)}${cur.pinned ? '取消置顶' : '置顶'}</button>
                    <button type="button" class="btn sm danger" data-click="remove">${icon('trash', 14)}删除</button>` : ''}
                </div>
                <div class="note-body">
                  <label class="sr" for="note-title">标题</label>
                  <input id="note-title" class="note-title" value="${state.title}" data-input="title" placeholder="标题（可留空）" autocomplete="off" maxlength="200">
                  ${state.preview
                    ? html`<div class="md">${raw(renderMarkdown(state.body) || '<p class="muted">没有内容</p>')}</div>`
                    : html`<label class="sr" for="note-body">正文</label><textarea id="note-body" class="note-text" data-input="body" data-blur="flush" placeholder="记点什么，支持 Markdown">${state.body}</textarea>`}
                </div>
                <div class="note-foot">
                  <span class="row" style="gap:6px"><span class="dot ${saveDot}"></span>${saveLabel}</span>
                  ${state.error ? html`<span class="error-text">${state.error}</span>` : ''}
                  <span>${charCount(state.body)} 字</span>
                  <span class="grow"></span><span>支持 Markdown，单条上限 64 KB</span>
                </div>`
              : html`<div class="notes-empty"><div class="col" style="align-items:center;gap:14px">
                  <p class="muted">从左边选一条笔记，或者新建一条。</p>
                  <button type="button" class="btn pri" data-click="newNote">${icon('plus', 16)}新建笔记</button>
                  <p class="small faint">在完整页任何地方按 N 也能新建</p></div></div>`}
          </section>
        </div>`,
      );
    }

    bind(root, {
      search: debounce((e) => {
        state.q = e.target.value;
        render();
      }, 100),
      newNote: () => ctx.go('#/notes/new'),
      pick: (e, el) => ctx.go('#/notes/' + el.getAttribute('data-id')),
      back: async () => {
        await save.flush();
        ctx.go('#/notes');
      },
      title(e) {
        state.title = e.target.value;
        state.dirty = true;
        save();
        render();
      },
      body(e) {
        state.body = e.target.value;
        state.dirty = true;
        save();
        render();
      },
      flush: () => save.flush(),
      mode(e, el) {
        state.preview = el.getAttribute('data-v') === 'preview';
        if (state.preview) save.flush();
        render();
      },
      restoreDraft() {
        const d = state.pendingDraft;
        if (!d) return;
        state.title = d.title || '';
        state.body = d.body || '';
        state.isNew = true;
        state.currentId = null;
        state.dirty = true;
        state.pendingDraft = null;
        try { sessionStorage.removeItem(d.key); } catch (_) {}
        render();
      },
      discardDraft() {
        try { if (state.pendingDraft?.key) sessionStorage.removeItem(state.pendingDraft.key); } catch (_) {}
        state.pendingDraft = null;
        render();
      },
      async pin() {
        const cur = current();
        if (!cur) return;
        await save.flush();
        call('notes.save', { id: cur.id, title: state.title, body: state.body, pinned: !cur.pinned }).catch(toastError);
      },
      async remove() {
        const cur = current();
        if (!cur) return;
        save.cancel();
        state.dirty = false;
        try {
          await call('notes.remove', { id: cur.id });
          ctx.go('#/notes');
          toast(`已删除「${noteTitle(cur)}」`, { action: { label: '撤销', run: () => call('notes.restore', { id: cur.id }).then(() => ctx.go('#/notes/' + cur.id)).catch(toastError) } });
        } catch (e) {
          toastError(e);
        }
      },
    });

    const off = onChange(['notes'], () => load().catch(() => {}));
    const onWorkspace = (e) => {
      if (e.detail?.phase !== 'switching') return;
      state.switching = true;
      save.cancel();
      saveDraft();
    };
    window.addEventListener('workspace-changed', onWorkspace);
    const onUnload = () => { if (!state.switching) save.flush(); };
    window.addEventListener('beforeunload', onUnload);
    load().then(() => openRoute(ctx.route));

    return {
      update: (route) => openRoute(route),
      unmount() {
        if (state.switching) save.cancel();
        else save.flush();
        off();
        window.removeEventListener('workspace-changed', onWorkspace);
        window.removeEventListener('beforeunload', onUnload);
      },
      focusSearch() {
        root.querySelector('#note-search')?.focus();
      },
    };
  },
};
