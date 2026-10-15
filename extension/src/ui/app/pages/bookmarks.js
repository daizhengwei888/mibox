// 收藏页：星标、全部收藏（卡片 / 列表 / 紧凑）、搜索、批量整理、拖到分组。

import { html, morph, bind, scheduler, debounce } from '../../kit/dom.js';
import { icon } from '../../kit/icons.js';
import { tile, toast, toastError, openMenu, modal, copyText, feedback, enterCards } from '../../kit/ui.js';
import { call } from '../../../shared/client.js';
import { domainOf, formatWhen, makeMatcher, coerceUrl, isWebUrl, splitTitle } from '../../../shared/util.js';
import { syncSummary } from '../store.js';

const PAGE_SIZE = 240;

export default {
  title: '收藏',
  mount(root, ctx) {
    const { store } = ctx;
    const state = {
      q: '',
      selectMode: false,
      selected: new Set(),
      limit: PAGE_SIZE,
      dragFav: null,
      importing: false,
      importErr: '',
    };
    const render = scheduler(draw);
    let entered = false;

    function groupFilter() {
      return ctx.route.query.get('group') || '';
    }

    function visibleItems() {
      const g = groupFilter();
      const match = makeMatcher(state.q);
      const groupNames = new Map(store.groups.map((x) => [x.id, x.name]));
      let items = store.bookmarks.filter((b) => {
        if (g === 'fav' && !b.favorite) return false;
        if (g === 'none' && b.groupId && groupNames.has(b.groupId)) return false;
        if (g && g !== 'fav' && g !== 'none' && b.groupId !== g) return false;
        return match(b.title, b.url, b.note, groupNames.get(b.groupId));
      });
      const sort = store.settings.sort;
      if (sort === 'name') items.sort((a, b) => a.title.localeCompare(b.title, 'zh-CN'));
      else if (sort === 'group') items.sort((a, b) => (groupNames.get(a.groupId) || '￿').localeCompare(groupNames.get(b.groupId) || '￿', 'zh-CN') || b.createdAt - a.createdAt);
      else if (sort === 'opened') items.sort((a, b) => (b.openedAt || 0) - (a.openedAt || 0) || b.createdAt - a.createdAt);
      else items.sort((a, b) => b.createdAt - a.createdAt);
      if (g === 'fav') items.sort((a, b) => (a.favOrder || 0) - (b.favOrder || 0));
      return items;
    }

    function titleText() {
      const g = groupFilter();
      if (state.q) return '搜索结果';
      if (g === 'fav') return '星标';
      if (g === 'none') return '未分类';
      if (g) return store.groups.find((x) => x.id === g)?.name || '分组';
      return '全部收藏';
    }

    function groupIndex(id) {
      return store.groups.findIndex((x) => x.id === id);
    }

    function card(b) {
      const gi = groupIndex(b.groupId);
      const sel = state.selected.has(b.id);
      const target = store.settings.openIn === 'current' ? '' : '_blank';
      const t = splitTitle(b.title, b.url);
      // 卡片右上角只放星标（标题第一行留出一个按钮的位置）；「更多」在底部，悬停时代替时间出现。紧凑模式没有底部，两个按钮都在右边。
      const compact = store.settings.view === 'compact';
      const moreBtn = html`<button type="button" class="icon-btn sm more-btn" data-click="more" data-id="${b.id}" aria-label="${b.title} 的更多操作">${icon('more', 16)}</button>`;
      return html`<article class="bm-card ${sel ? 'selected' : ''}" data-key="${b.id}" draggable="true" data-dragstart="dragCard" data-id="${b.id}">
        <div class="top">
          ${state.selectMode ? html`<span class="check-wrap"><input type="checkbox" ${sel ? 'checked' : ''} data-change="toggleSel" data-id="${b.id}" aria-label="选择 ${b.title}"></span>` : ''}
          ${tile(b.title, b.url, 34, store.settings.favicons)}
          <div class="grow">
            <a class="title" href="${b.url}" ${target ? html`target="_blank" rel="noopener"` : ''} data-click="open" data-id="${b.id}" title="${b.title}">${t.main}</a>
            ${t.sub ? html`<div class="subtitle">${t.sub}</div>` : ''}
            <div class="domain">${domainOf(b.url)}</div>
          </div>
          <div class="actions">
            <button type="button" class="icon-btn sm star-btn" data-click="star" data-id="${b.id}" aria-pressed="${b.favorite ? 'true' : 'false'}" aria-label="${b.favorite ? '取消星标' : '设为星标'}" title="${b.favorite ? '取消星标' : '设为星标'}">${icon('star', 16)}</button>
            ${compact ? moreBtn : ''}
          </div>
        </div>
        ${b.note ? html`<p class="note">${b.note}</p>` : ''}
        <div class="meta">
          ${gi >= 0 ? html`<span class="gtag"><span class="sub-dot t${gi % 8}"></span>${store.groups[gi].name}</span>` : html`<span class="gtag is-none" aria-hidden="true">未分类</span>`}
          <span class="grow"></span><span class="meta-end"><span class="when">${formatWhen(b.createdAt)}</span>${compact ? '' : moreBtn}</span>
        </div>
      </article>`;
    }

    function row(b) {
      const gi = groupIndex(b.groupId);
      const sel = state.selected.has(b.id);
      const target = store.settings.openIn === 'current' ? '' : '_blank';
      const t = splitTitle(b.title, b.url);
      return html`<div class="bm-row ${sel ? 'selected' : ''}" data-key="${b.id}" draggable="true" data-dragstart="dragCard" data-id="${b.id}">
        ${state.selectMode ? html`<span class="check-wrap"><input type="checkbox" ${sel ? 'checked' : ''} data-change="toggleSel" data-id="${b.id}" aria-label="选择 ${b.title}"></span>` : html`<span class="no-check"></span>`}
        ${tile(b.title, b.url, 26, store.settings.favicons)}
        <a class="title" href="${b.url}" ${target ? html`target="_blank" rel="noopener"` : ''} data-click="open" data-id="${b.id}" title="${b.note || b.title}">${t.main}${t.sub ? html`<span class="t-sub">${t.sub}</span>` : ''}</a>
        <span class="domain">${domainOf(b.url)}</span>
        <span class="gtag ${gi >= 0 ? '' : 'is-none'}" ${gi >= 0 ? '' : 'aria-hidden="true"'}>${gi >= 0 ? html`<span class="row" style="gap:6px"><span class="sub-dot t${gi % 8}"></span>${store.groups[gi].name}</span>` : '未分类'}</span>
        <span class="when">${formatWhen(b.createdAt)}</span>
        <span class="actions">
          <button type="button" class="icon-btn sm star-btn" data-click="star" data-id="${b.id}" aria-pressed="${b.favorite ? 'true' : 'false'}" aria-label="${b.favorite ? '取消星标' : '设为星标'}">${icon('star', 15)}</button>
          <button type="button" class="icon-btn sm more-btn" data-click="more" data-id="${b.id}" aria-label="${b.title} 的更多操作">${icon('more', 15)}</button>
        </span>
      </div>`;
    }

    function shelfLabel(b) {
      const t = splitTitle(b.title, b.url);
      return html`<span class="label ${t.sub ? 'has-sub' : ''}"><span class="l-main">${t.main}</span>${t.sub ? html`<span class="l-sub">${t.sub}</span>` : ''}</span>`;
    }

    function shelf() {
      const favs = store.bookmarks.filter((b) => b.favorite).sort((a, b) => (a.favOrder || 0) - (b.favOrder || 0));
      if (!favs.length || state.q || groupFilter()) return '';
      const target = store.settings.openIn === 'current' ? '' : '_blank';
      return html`<section class="shelf" aria-labelledby="shelf-h">
        <div class="shelf-head"><h2 id="shelf-h">星标</h2><span class="small muted">点星标加入，拖动排序</span></div>
        <div class="shelf-grid">
          ${favs.slice(0, 24).map(
            (b) => html`<a class="shelf-item" data-key="f-${b.id}" href="${b.url}" ${target ? html`target="_blank" rel="noopener"` : ''} title="${b.title}" draggable="true"
              data-id="${b.id}" data-click="open" data-dragstart="favDragStart" data-dragover="favDragOver" data-drop="favDrop" data-dragend="favDragEnd" data-dragleave="favDragLeave">
              ${tile(b.title, b.url, 36, store.settings.favicons)}${shelfLabel(b)}</a>`,
          )}
        </div>
      </section>`;
    }

    function emptyState(total, items) {
      if (!store.bookmarks.length) {
        return html`<div class="empty">
          <h2>还没有收藏</h2>
          <p>在任何网页点浏览器工具栏上的书签图标（或按 Alt+Shift+S），当前网页就存好了。也可以先把 Chrome 里已有的书签导进来。</p>
          ${state.importErr ? html`<p class="error-text" role="alert">${state.importErr}</p>` : ''}
          <div class="row wrap"><button type="button" class="btn pri" data-click="importChrome" ${state.importing ? 'disabled' : ''}>${state.importing ? html`<span class="spinner"></span>正在导入…` : html`${icon('download', 16)}导入 Chrome 书签`}</button><button type="button" class="btn" data-click="add">${icon('plus', 16)}添加链接</button></div>
        </div>`;
      }
      if (!items.length) {
        if (state.q) {
          return html`<div class="empty"><h2>没有找到「${state.q}」</h2><p>试试网址里的词，或者换个分组。收藏的标题、网址和备注都能搜到。</p>
            <div class="row wrap"><button type="button" class="btn" data-click="clearSearch">清除搜索</button><button type="button" class="btn ghost" data-click="searchAll">在笔记和保险箱里找</button></div></div>`;
        }
          return html`<div class="empty"><h2>这里还是空的</h2><p>${groupFilter() === 'fav' ? '在收藏上点星标，就会出现在星标里。' : '把收藏拖到左边的分组上，或者在收藏的菜单里选「移动到分组」。'}</p>${groupFilter() ? html`<a href="#/bookmarks" data-click="allBookmarks">返回全部收藏</a>` : ''}</div>`;
      }
      return '';
    }

    function draw() {
      if (!store.ready) return;
      const items = visibleItems();
      const shown = items.slice(0, state.limit);
      const view = store.settings.view;
      const sum = syncSummary(store.sync);
      const selCount = state.selected.size;
      morph(
        root,
        html`<div class="page">
          <div class="bm-top">
            <label class="search-box">${icon('search', 16)}<span class="sr">搜索${titleText()}</span>
              <input type="search" id="bm-search" value="${state.q}" data-input="search" data-keydown="searchKey" placeholder="搜索${titleText()}：名称、网址或备注" autocomplete="off"></label>
            <div class="top-actions">
              <button type="button" class="btn ghost search-all" data-click="searchAll" title="搜索收藏、笔记和保险箱"><kbd>Ctrl</kbd><kbd>K</kbd><span>搜索全部</span></button>
              <span class="top-sep" aria-hidden="true"></span>
              <button type="button" class="btn ghost sync-btn" data-syncing="${store.sync?.syncing ? 'true' : 'false'}" data-click="sync" title="${sum.detail || sum.text}"><span class="dot ${sum.dot}"></span>${sum.text}</button>
              <button type="button" class="btn pri add-btn" data-click="add">${icon('plus', 16)}添加链接</button>
            </div>
            <span class="spacer"></span>
            <button type="button" class="btn appearance-btn" data-key="appearance" data-click="appearance" aria-haspopup="dialog" title="明暗、材质、动效和显示方式">${icon('palette', 16)}外观</button>
          </div>
          ${shelf()}
          <section class="col" style="gap:16px" aria-labelledby="list-h">
            <div class="list-head">
              <h1 id="list-h">${titleText()}</h1><span class="muted">${items.length} 条</span>
              <span class="grow"></span>
              <div class="seg" role="group" aria-label="显示方式">
                <button type="button" data-click="view" data-v="card" aria-pressed="${view === 'card' ? 'true' : 'false'}">${icon('grid', 14)}卡片</button>
                <button type="button" data-click="view" data-v="list" aria-pressed="${view === 'list' ? 'true' : 'false'}">${icon('list', 14)}列表</button>
                <button type="button" data-click="view" data-v="compact" aria-pressed="${view === 'compact' ? 'true' : 'false'}">紧凑</button>
              </div>
              <label class="inline-select">排序
                <select class="select" data-change="sort">
                  ${[['recent', '最近添加'], ['opened', '最近打开'], ['name', '名称'], ['group', '分组']].map(([v, t]) => html`<option value="${v}" ${store.settings.sort === v ? 'selected' : ''}>${t}</option>`)}
                </select></label>
              <button type="button" class="btn sm ${state.selectMode ? 'outline' : ''}" data-click="toggleSelect" aria-pressed="${state.selectMode ? 'true' : 'false'}">${icon('checkSquare', 14)}${state.selectMode ? '完成整理' : '整理'}</button>
            </div>
            ${emptyState(store.bookmarks.length, items)}
            ${shown.length
              ? view === 'list'
                ? html`<div class="bm-list">${shown.map(row)}</div>`
                : html`<div class="bm-grid ${view === 'compact' ? 'compact' : ''}">${shown.map((b) => card(b))}</div>`
              : ''}
            ${items.length > shown.length ? html`<button type="button" class="btn load-more" data-click="more-items">再显示 ${Math.min(PAGE_SIZE, items.length - shown.length)} 条（共 ${items.length} 条）</button>` : ''}
          </section>
          ${state.selectMode
            ? html`<div class="batch-bar" role="region" aria-label="批量操作">
                <span class="count">已选 ${selCount} 项</span>
                <button type="button" class="btn sm" data-click="selectAll">全选当前结果</button>
                <label class="sr" for="bm-move">移动到分组</label>
                <select id="bm-move" class="select" style="height:var(--h-sm);width:auto;font-size:var(--fs-sub)" data-change="moveSel" ${selCount ? '' : 'disabled'}>
                  <option value="__" selected>移动到…</option>
                  ${store.groups.map((g) => html`<option value="${g.id}">${g.name}</option>`)}
                  <option value="">未分类</option>
                </select>
                <button type="button" class="btn sm" data-click="favSel" ${selCount ? '' : 'disabled'}>${icon('star', 14)}设为星标</button>
                <button type="button" class="btn sm danger" data-click="deleteSel" ${selCount ? '' : 'disabled'}>${icon('trash', 14)}删除</button>
                <button type="button" class="btn sm pri" data-click="toggleSelect">完成</button>
              </div>`
            : ''}
        </div>`,
      );
      if (!entered) { entered = true; requestAnimationFrame(() => enterCards(root, 'bookmarks')); }
    }

    // ───────── 操作 ─────────

    const byId = (id) => store.bookmarks.find((b) => b.id === id);

    async function removeWithUndo(ids) {
      try {
        const r = await call('bookmarks.remove', { ids });
        state.selected.clear();
        render();
        toast(r.removed === 1 ? '已删除 1 条收藏' : `已删除 ${r.removed} 条收藏`, {
          action: { label: '撤销', run: () => call('bookmarks.restore', { ids: r.ids }).then(() => toast('已恢复')).catch(toastError) },
        });
      } catch (e) {
        toastError(e);
      }
    }

    function editDialog(b) {
      const isNew = !b;
      const groups = store.groups;
      const current = groupFilter();
      const defGroup = b ? b.groupId : current && current !== 'fav' && current !== 'none' ? current : '';
      modal({
        title: isNew ? '添加链接' : '编辑收藏',
        body: html`<form class="col" style="gap:14px" data-x="form" novalidate>
          <div class="field"><label for="ed-url">网址</label><input id="ed-url" class="input" name="url" value="${b?.url || ''}" placeholder="https://" autocomplete="off" ${isNew ? 'autofocus' : ''}></div>
          <div class="field"><label for="ed-title">名称</label><input id="ed-title" class="input" name="title" value="${b?.title || ''}" placeholder="${isNew ? '留空就用网站名' : ''}" autocomplete="off" ${isNew ? '' : 'autofocus'}>
            <span class="hint">改成以后自己会搜的词，更容易找回来。</span></div>
          <div class="field"><label for="ed-group">分组</label>
            <select id="ed-group" class="select" name="groupId"><option value="">未分类</option>${groups.map((g) => html`<option value="${g.id}" ${defGroup === g.id ? 'selected' : ''}>${g.name}</option>`)}</select></div>
          <div class="field"><label for="ed-note">备注</label><textarea id="ed-note" class="textarea" name="note" rows="3" placeholder="写一句以后搜得到的话（可选）">${b?.note || ''}</textarea></div>
          <label class="check"><input type="checkbox" name="favorite" ${b?.favorite ? 'checked' : ''}>设为星标</label>
          <p class="error-text" data-x="err" hidden></p>
          <div class="modal-foot"><button type="button" class="btn" data-x="cancel">取消</button><button type="submit" class="btn pri">${isNew ? '添加' : '保存'}</button></div>
        </form>`,
        onMount(box, close) {
          const form = box.querySelector('[data-x=form]');
          const err = box.querySelector('[data-x=err]');
          box.querySelector('[data-x=cancel]').addEventListener('click', () => close());
          form.addEventListener('submit', async (e) => {
            e.preventDefault();
            const fd = new FormData(form);
            const url = coerceUrl(fd.get('url'));
            if (!isWebUrl(url)) {
              err.textContent = '请填写以 http 或 https 开头的网址';
              err.hidden = false;
              form.url.focus();
              return;
            }
            const data = { url, title: String(fd.get('title') || '').trim(), groupId: fd.get('groupId') || null, note: fd.get('note'), favorite: !!fd.get('favorite') };
            try {
              if (isNew) {
                const r = await call('bookmarks.save', data);
                if (r.status === 'exists') {
                  err.textContent = '这个网址已经收藏过了：' + r.bookmark.title;
                  err.hidden = false;
                  return;
                }
                toast('已添加');
              } else {
                await call('bookmarks.update', { id: b.id, patch: data });
                toast('已保存');
              }
              close();
            } catch (e2) {
              err.textContent = e2.message;
              err.hidden = false;
            }
          });
        },
      });
    }

    function moveMenu(anchor, ids) {
      openMenu(anchor, [
        { label: '移动到', heading: true },
        ...store.groups.map((g) => ({ label: g.name, icon: 'folder', run: () => moveTo(ids, g.id) })),
        { label: '未分类', icon: 'folder', run: () => moveTo(ids, null) },
      ]);
    }

    async function moveTo(ids, groupId) {
      try {
        const r = await call('bookmarks.move', { ids, groupId });
        const name = groupId ? store.groups.find((g) => g.id === groupId)?.name : '未分类';
        toast(r.moved ? `已移动到「${name}」` : '已经在这个分组里了');
      } catch (e) {
        toastError(e);
      }
    }

    const setQ = debounce((v) => {
      state.q = v;
      state.limit = PAGE_SIZE;
      render();
    }, 120);

    bind(root, {
      search: (e) => setQ(e.target.value),
      searchKey(e) {
        if (e.key === 'Escape' && e.target.value) {
          e.preventDefault();
          e.target.value = '';
          setQ.flush('');
        }
      },
      clearSearch() {
        state.q = '';
        render();
        root.querySelector('#bm-search')?.focus();
      },
      searchAll: () => ctx.openSearch(state.q),
      appearance: (e, el) => ctx.openAppearance(el),
      sync: (e, el) => ctx.openSyncPanel(el),
      add: () => editDialog(null),
      async importChrome() {
        if (state.importing) return;
        state.importing = true;
        state.importErr = '';
        render();
        try {
          const r = await call('chrome.import', { foldersAsGroups: true });
          toast(`已导入 ${r.added} 条${r.skipped ? `，${r.skipped} 条已存在` : ''}`);
        } catch (e) {
          state.importErr = e?.message || '导入失败，请重试。';
        } finally {
          state.importing = false;
          render();
        }
      },
      allBookmarks(e) {
        e.preventDefault();
        ctx.go('#/bookmarks');
      },
      open(e, el) {
        if (state.selectMode) {
          e.preventDefault();
          const id = el.getAttribute('data-id');
          state.selected.has(id) ? state.selected.delete(id) : state.selected.add(id);
          render();
          return;
        }
        call('bookmarks.opened', { id: el.getAttribute('data-id') }).catch(() => {});
      },
      star(e, el) {
        const b = byId(el.getAttribute('data-id'));
        if (!b) return;
        const next = !b.favorite;
        // 先变再确认：后台休眠唤醒时也不用等；失败就退回原样并提示。成功反馈仍在确认后才播。
        el.setAttribute('aria-pressed', next ? 'true' : 'false');
        call('bookmarks.favorite', { ids: [b.id], value: next }).then(() => {
          if (!next) return;
          const pop = getComputedStyle(document.documentElement).getPropertyValue('--ease-pop').trim() || 'ease-out';
          feedback(el, [{ transform: 'scale(1)' }, { transform: 'scale(1.18)' }, { transform: 'scale(1)' }], { duration: 220, easing: pop });
        }).catch((err) => {
          if (el.isConnected) el.setAttribute('aria-pressed', next ? 'false' : 'true');
          toastError(err);
        });
      },
      more(e, el) {
        const b = byId(el.getAttribute('data-id'));
        if (!b) return;
        openMenu(el, [
          { label: '编辑', icon: 'edit', run: () => editDialog(b) },
          { label: '移动到分组', icon: 'move', run: () => moveMenu(el, [b.id]) },
          { label: b.favorite ? '取消星标' : '设为星标', icon: 'star', run: () => call('bookmarks.favorite', { ids: [b.id], value: !b.favorite }).catch(toastError) },
          { label: '复制网址', icon: 'copy', run: () => copyText(b.url).then(() => toast('已复制网址')) },
          { label: '加入签到', icon: 'calendarCheck', run: () => ctx.go('#/tools/checkin?new=' + encodeURIComponent(b.url) + '&name=' + encodeURIComponent(b.title)) },
          '-',
          { label: '删除', icon: 'trash', danger: true, run: () => removeWithUndo([b.id]) },
        ]);
      },
      view(e, el) {
        call('settings.update', { view: el.getAttribute('data-v') }).catch(toastError);
      },
      sort(e) {
        call('settings.update', { sort: e.target.value }).catch(toastError);
      },
      toggleSelect() {
        state.selectMode = !state.selectMode;
        state.selected.clear();
        render();
      },
      toggleSel(e, el) {
        const id = el.getAttribute('data-id');
        if (e.target.checked) state.selected.add(id);
        else state.selected.delete(id);
        render();
      },
      selectAll() {
        for (const b of visibleItems()) state.selected.add(b.id);
        render();
      },
      moveSel(e) {
        const v = e.target.value;
        if (v === '__') return;
        moveTo([...state.selected], v || null);
        e.target.value = '__';
      },
      async favSel() {
        const r = await call('bookmarks.favorite', { ids: [...state.selected], value: true }).catch(toastError);
        if (r) toast(r.changed ? `已把 ${r.changed} 条设为星标` : '都已经是星标了');
      },
      deleteSel: () => removeWithUndo([...state.selected]),
      'more-items'() {
        state.limit += PAGE_SIZE;
        render();
      },
      dragCard(e, el) {
        const id = el.getAttribute('data-id');
        const ids = state.selectMode && state.selected.has(id) ? [...state.selected] : [id];
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/x-sq-bookmarks', JSON.stringify(ids));
        const b = byId(id);
        if (b) e.dataTransfer.setData('text/uri-list', b.url);
      },
      favDragStart(e, el) {
        state.dragFav = el.getAttribute('data-id');
        el.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/x-sq-fav', state.dragFav);
      },
      favDragOver(e, el) {
        if (!state.dragFav) return;
        e.preventDefault();
        el.classList.add('drop-before');
      },
      favDragLeave(e, el) {
        el.classList.remove('drop-before');
      },
      favDrop(e, el) {
        e.preventDefault();
        el.classList.remove('drop-before');
        const target = el.getAttribute('data-id');
        const moving = state.dragFav;
        state.dragFav = null;
        if (!moving || moving === target) return;
        const order = store.bookmarks.filter((b) => b.favorite).sort((a, b) => (a.favOrder || 0) - (b.favOrder || 0)).map((b) => b.id).filter((id) => id !== moving);
        order.splice(order.indexOf(target), 0, moving);
        call('bookmarks.reorderFavorites', { ids: order }).catch(toastError);
      },
      favDragEnd(e, el) {
        state.dragFav = null;
        el.classList.remove('dragging');
      },
    });

    const unsub = ctx.subscribe(() => {
      // 被删掉的不再算作已选。
      for (const id of [...state.selected]) if (!byId(id)) state.selected.delete(id);
      render();
    });
    draw();

    return {
      update() {
        state.selected.clear();
        state.limit = PAGE_SIZE;
        render();
      },
      unmount() {
        unsub();
      },
      focusSearch() {
        root.querySelector('#bm-search')?.focus();
      },
    };
  },
};
