// 首页：根据当前 Chrome 个人资料的近期历史，展示收藏中最常使用的链接。

import { html, morph, bind, scheduler } from '../../kit/dom.js';
import { icon } from '../../kit/icons.js';
import { toast, tile, modal, enterCards } from '../../kit/ui.js';
import { call } from '../../../shared/client.js';
import { domainOf, formatWhen, splitTitle } from '../../../shared/util.js';

const PREVIEW_SIZE = 16;
const MONTH_LIMIT = 50;
const MONTH_MS = 30 * 86400000;

export default {
  title: '首页',
  mount(root, ctx) {
    const state = { items: [], monthTotal: 0, total: 0, hasMore: false, permissionGranted: false, loading: true, skeleton: false, busy: '', error: '', stage: 'preview', stale: false, partial: false, cached: false, computedAt: 0, hovered: false, focused: false, pressed: false, pending: null };
    let disposed = false;
    const render = scheduler(() => { if (!disposed) draw(); });
    let requestSeq = 0;
    let entered = false;
    let skeletonTimer = null;

    function target() {
      return ctx.store.settings?.openIn === 'current' ? '' : '_blank';
    }

    function itemView(item) {
      const t = splitTitle(item.title, item.url);
      return html`<article class="home-item" data-key="${item.id}"><a class="home-item-link grow" href="${item.url}" ${target() ? html`target="_blank" rel="noopener"` : ''} title="${item.title}">
        ${tile(item.title, item.url, 32, ctx.store.settings?.favicons)}
        <span class="home-item-main"><span class="home-item-title">${t.main}</span>${t.sub ? html`<span class="home-item-sub">${t.sub}</span>` : ''}<span class="home-item-url">${domainOf(item.url)}</span></span></a>
        <div class="home-item-meta">${item.lastVisitTime ? html`<span>${formatWhen(item.lastVisitTime)}</span>` : ''}${item.bookmarkCount > 1 ? html`<button type="button" class="btn sm" data-click="other-bookmarks" data-id="${item.id}">该站其他 ${item.bookmarkCount - 1} 条收藏</button>` : ''}${state.permissionGranted ? html`<button type="button" class="icon-btn sm" data-click="hide-origin" data-origin="${item.origin}" aria-label="隐藏 ${item.origin}">${icon('eyeOff', 14)}</button>` : ''}</div>
      </article>`;
    }

    function applyTop(top) {
      state.items = Array.isArray(top?.items) ? top.items : [];
      state.monthTotal = Number.isFinite(top?.monthTotal) ? top.monthTotal : state.items.length;
      state.total = Number.isFinite(top?.total) ? top.total : state.items.length;
      state.hasMore = !!top?.hasMore;
      state.permissionGranted = !!top?.permissionGranted;
      state.stale = !!top?.stale;
      state.partial = !!top?.partial;
      state.cached = !!top?.cached;
      state.computedAt = top?.computedAt || 0;
    }

    function receiveTop(top) {
      if (top?.permissionGranted && state.permissionGranted && (state.hovered || state.focused || state.pressed)) state.pending = top;
      else applyTop(top);
    }

    function unfreeze() {
      if (!state.hovered && !state.focused && !state.pressed && state.pending) { applyTop(state.pending); state.pending = null; render(); }
    }

    function showOther(item) {
      if (!item) return;
      const bookmarks = ctx.store.bookmarks.filter((b) => b.id !== item.id && (item.bookmarkIds || []).includes(b.id));
      modal({ title: `${item.title} 的其他收藏`, body: html`<div class="col" style="gap:8px">${bookmarks.length ? bookmarks.map((b) => html`<a class="nav-preview" href="${b.url}" target="_blank" rel="noopener" title="${b.title}">${tile(b.title, b.url, 22, ctx.store.settings?.favicons)}<span class="ellipsis">${b.title}</span></a>`) : html`<p class="muted">本机收藏中没有更多可显示的链接。</p>`}</div>` });
    }

    /** 没有排行可显示时用的兜底卡片，让首页在任何状态下都像首页。 */
    function fallbackSection(title, scope, items) {
      if (!items.length) return '';
      return html`<section class="home-section" aria-labelledby="home-fb-${scope}">
        <div class="home-section-head"><h2 id="home-fb-${scope}">${title}</h2><span class="small muted">${scope === 'recent' ? '按收藏时间' : '在收藏上点星标加入'}</span></div>
        <div class="home-list">${items.map(itemView)}</div>
      </section>`;
    }

    function groupOverview() {
      const groups = ctx.store.groups.map((g) => ({ g, items: ctx.store.bookmarks.filter((b) => b.groupId === g.id).slice(0, 3) })).filter((x) => x.items.length);
      if (!groups.length) return '';
      return html`<section class="home-section" aria-labelledby="home-fb-groups">
        <div class="home-section-head"><h2 id="home-fb-groups">分组速览</h2><span class="small muted">每组最新 3 条</span></div>
        <div class="home-overview">${groups.map(({ g, items }) => html`<div class="ov-group" data-key="${g.id}">
          <a class="ov-head" href="#/bookmarks?group=${g.id}"><span class="sub-dot"></span><span class="grow ellipsis">${g.name}</span><span class="muted small">${items.length >= 3 ? '更多' : items.length + ' 条'}</span></a>
          <div class="home-list">${items.map(itemView)}</div>
        </div>`)}</div>
      </section>`;
    }

    function permissionPrompt() {
      return html`<div class="home-permission notice">
        ${icon('clock', 20)}<div class="grow"><strong>授权查看最常使用</strong><p class="small muted">按当前 Chrome 个人资料的近期记录在本机估算，不上传；浏览器会先询问一次。</p></div>
        <button type="button" class="btn pri" data-click="requestHistory" ${state.busy ? 'disabled' : ''}>${state.busy === 'request' ? html`<span class="spinner"></span>请求中…` : '授权查看'}</button>
      </div>`;
    }

    function draw() {
      const owned = new Map(ctx.store.bookmarks.map((b) => [b.id, b]));
      const hidden = new Set(ctx.homeUi?.hiddenOrigins || []);
      const items = state.items.filter((item) => !hidden.has(item.origin)).filter((item) => owned.get(item.id)?.url === item.url).map((item) => ({ ...item, title: owned.get(item.id).title }));
      // 未授权历史时的兜底池：先按最近打开，没有打开记录再按收藏时间，保证首页始终有内容。
      const fallbackSource = state.permissionGranted
        ? []
        : [...ctx.store.bookmarks].sort((a, b) => (b.openedAt || 0) - (a.openedAt || 0) || (b.createdAt || 0) - (a.createdAt || 0));
      const toFallback = (b) => ({ id: b.id, title: b.title, url: b.url, lastVisitTime: b.openedAt || 0, origin: domainOf(b.url) });
      const fallbackItems = fallbackSource.map(toFallback);
      const starredItems = fallbackSource.filter((b) => b.favorite).slice(0, 8).map(toFallback);
      const monthItems = state.permissionGranted ? items : fallbackItems.filter((item) => item.lastVisitTime >= Date.now() - MONTH_MS);
      const displayItems = state.permissionGranted ? items : state.stage === 'all' ? fallbackItems : monthItems.slice(0, state.stage === 'month' ? MONTH_LIMIT : PREVIEW_SIZE);
      const monthTotal = state.permissionGranted ? state.monthTotal : monthItems.length;
      const total = state.permissionGranted ? state.total : fallbackItems.length;
      const nextStage = state.stage === 'preview' && state.permissionGranted ? (state.hasMore ? 'month' : total > displayItems.length ? 'all' : '') : state.stage === 'preview' && monthTotal > PREVIEW_SIZE ? 'month' : state.stage !== 'all' && total > displayItems.length ? 'all' : '';
      const scope = state.stage === 'all' ? '全部排行 · 近90天' : '近一个月 · 最近30天';
      morph(root, html`<div class="page home-page">
        <div class="page-head"><div class="home-heading"><h1>首页</h1><p class="page-sub">从你的收藏里找出近期最常使用的链接。</p></div>
          <div class="home-head-actions" data-key="home-controls">
            <button type="button" class="btn appearance-btn" data-key="appearance" data-click="appearance" aria-haspopup="dialog" title="明暗、材质、动效和显示方式">${icon('palette', 16)}外观</button>
          </div>
        </div>
        ${state.error ? html`<div class="notice danger" role="alert">${icon('alert', 16)}<span>${state.error}</span><button type="button" class="btn sm" data-click="retry" ${state.busy ? 'disabled' : ''}>重试</button></div>` : ''}
        ${!state.permissionGranted && !state.loading ? permissionPrompt() : ''}
        <section class="home-section" aria-labelledby="home-top-title" ${!state.permissionGranted ? 'hidden' : ''}>
          <div class="home-section-head"><h2 id="home-top-title">${state.permissionGranted ? '最近活跃' : '星标与最近打开'}</h2><span class="small muted">${state.permissionGranted ? '按综合活跃度排序' : '未授权历史时显示本机已有记录'}</span></div>
          ${displayItems.length ? html`<div class="home-list" id="home-results" aria-busy="${state.loading ? 'true' : 'false'}">${displayItems.map(itemView)}</div>` : state.loading ? state.skeleton ? html`<div class="home-list home-skeleton" aria-busy="true" aria-label="正在准备常用网站">${Array.from({ length: 4 }, () => html`<div class="home-item"><span class="skeleton tile"></span><span class="skeleton grow"></span></div>`)}</div>` : html`<p class="small muted" role="status">正在准备常用网站…</p>` : state.permissionGranted ? html`<div class="empty"><h2>${total > 0 ? '近一个月没有访问记录' : '还没有足够的访问记录'}</h2><p>${total > 0 ? '可以加载全部，查看更早访问过的收藏站点。' : '这里会逐渐出现已收藏的常用网站。'}</p><a class="btn sm" href="#/bookmarks">查看全部收藏</a></div>` : ''}
          ${!state.loading && total > 0 ? html`<div class="home-results-foot" data-key="home-results-foot"><span class="small muted" role="status">${scope} · 已显示 ${displayItems.length} 个${state.stage === 'all' && monthTotal && total > monthTotal ? ' · 近一个月优先' : ''}</span>${nextStage ? html`<button type="button" class="btn load-more" data-key="more-items" data-click="more-items" data-stage="${nextStage}" ${displayItems.length ? html`aria-controls="home-results"` : ''}>${nextStage === 'month' ? html`加载更多 · 近一个月（最多 ${MONTH_LIMIT} 个）` : html`加载更多 · 全部（${total} 个）`}</button>` : ''}</div>` : ''}
          ${state.permissionGranted && state.computedAt ? html`<div class="row wrap small muted"><span>更新于 ${formatWhen(state.computedAt)}</span>${state.loading ? html`<span role="status">正在更新…</span>` : html`<button type="button" class="btn sm" data-click="refresh" ${state.busy ? 'disabled' : ''}>更新排行</button>`}</div>` : ''}
          ${state.partial ? html`<p class="small muted">本次只覆盖部分历史，顺序可能不完整。</p>` : ''}
          ${ctx.homeUi?.hiddenOrigins?.length ? html`<div class="row wrap"><span class="small muted">已隐藏 ${ctx.homeUi.hiddenOrigins.length} 个站点</span><button type="button" class="btn sm" data-click="restore-origins">恢复隐藏站点</button></div>` : ''}
        </section>
        ${!state.permissionGranted && !state.loading ? html`${fallbackSection('最近添加', 'recent', fallbackItems.slice(0, 8))}${fallbackSection('星标', 'fav', starredItems)}${groupOverview()}` : ''}
      </div>`);
      if (!entered && displayItems.length) { entered = true; requestAnimationFrame(() => { if (!disposed) enterCards(root, 'home'); }); }
    }

    function beginLoading() {
      state.loading = true;
      state.skeleton = false;
      clearTimeout(skeletonTimer);
      skeletonTimer = setTimeout(() => { if (!disposed && state.loading) { state.skeleton = true; render(); } }, 150);
      render();
    }

    async function load() {
      const seq = ++requestSeq;
      beginLoading();
      state.error = '';
      render();
      try {
        // 后台按当前展开阶段筛选并限制返回数量。
        const top = await call('home.top', { stage: state.stage });
        if (disposed || seq !== requestSeq) return;
        receiveTop(top);
        if (top?.stale) queueMicrotask(() => { if (!disposed && seq === requestSeq) refreshTop(true); });
      } catch (e) {
        if (disposed || seq !== requestSeq) return;
        state.error = e?.message || '读取最常使用失败，请重试。';
      } finally {
        if (disposed || seq !== requestSeq) return;
        state.loading = false;
        clearTimeout(skeletonTimer);
        render();
        ctx.refreshHomeNav?.();
        if (pendingRefresh) { pendingRefresh = false; refreshTop(); }
      }
    }

    async function refreshTop(force = false) {
      const seq = ++requestSeq;
      beginLoading();
      try {
        const top = await call('home.top', { stage: state.stage, ...(force ? { refresh: true } : {}) });
        if (disposed || seq !== requestSeq) return false;
        receiveTop(top);
        state.error = '';
        return true;
      } catch (e) {
        if (disposed || seq !== requestSeq) return false;
        state.error = e?.message || '读取最常使用失败，请重试。';
        return false;
      }
      finally {
        if (!disposed && seq === requestSeq) {
          state.loading = false;
          clearTimeout(skeletonTimer);
          render();
          ctx.refreshHomeNav?.();
          if (pendingRefresh) {
            pendingRefresh = false;
            refreshTop();
          }
        }
      }
    }

    let pendingRefresh = false;
    const unwatch = ctx.subscribe((topics = []) => {
      if (disposed) return;
      if (topics.includes('appearance')) render();
      if (!topics.some((t) => ['bookmarks', 'groups', 'settings', 'home'].includes(t))) return;
      // 排行计算要几秒，这期间新增的收藏先记下来，算完再补跑一次，不然要等下一次无关变更才进榜。
      if (state.loading) { pendingRefresh = true; return; }
      render();
      refreshTop();
    });

    const onPermissionRemoved = (change) => {
      const permissions = Array.isArray(change) ? change : change?.permissions;
      if (disposed || !permissions?.includes?.('history')) return;
      requestSeq++;
      state.permissionGranted = false;
      state.items = [];
      state.pending = null;
      state.hovered = state.focused = state.pressed = false;
      state.loading = false;
      state.error = '';
      render();
      ctx.refreshHomeNav?.();
    };
    const onPermissionAdded = (change) => {
      const permissions = Array.isArray(change) ? change : change?.permissions;
      if (disposed || !permissions?.includes?.('history')) return;
      if (state.busy !== 'request') refreshTop();
    };
    if (typeof chrome !== 'undefined' && chrome.permissions) {
      chrome.permissions.onRemoved?.addListener(onPermissionRemoved);
      chrome.permissions.onAdded?.addListener(onPermissionAdded);
      chrome.history?.onVisitRemoved?.addListener?.(onHistoryRemoved);
    }

    function onHistoryRemoved() { requestSeq++; state.items = []; state.pending = null; state.hovered = state.focused = state.pressed = false; state.loading = true; render(); load(); }

    root.addEventListener('pointerover', (e) => { if (e.target.closest('.home-item')) state.hovered = true; }, true);
    root.addEventListener('pointerout', (e) => { if (e.target.closest('.home-item') && !e.relatedTarget?.closest?.('.home-item')) { state.hovered = false; unfreeze(); } }, true);
    root.addEventListener('focusin', (e) => { if (e.target.closest('.home-item')) state.focused = true; }, true);
    root.addEventListener('focusout', (e) => { if (e.target.closest('.home-item') && !e.relatedTarget?.closest?.('.home-item')) { state.focused = false; unfreeze(); } }, true);
    root.addEventListener('pointerdown', (e) => { if (e.target.closest('.home-item')) state.pressed = true; }, true);
    const release = () => { state.pressed = false; unfreeze(); };
    document.addEventListener('pointerup', release, true);
    document.addEventListener('pointercancel', release, true);

    const unbind = bind(root, {
      async requestHistory() {
        if (state.busy) return;
        state.busy = 'request';
        state.error = '';
        render();
        try {
          const granted = await chrome.permissions.request({ permissions: ['history'] });
          if (!granted) {
            state.permissionGranted = false;
            state.error = '你拒绝了浏览历史权限，仍可正常查看收藏；需要时可以重试。';
            return;
          }
          if (await refreshTop()) toast('已开启最常使用');
        } catch (e) {
          state.error = e?.message || '请求浏览历史权限失败，请重试。';
        } finally {
          state.busy = '';
          render();
        }
      },
      appearance: (e, el) => ctx.openAppearance(el),
      retry: () => refreshTop(true),
      refresh: () => refreshTop(true),
      'more-items': (e, el) => {
        const next = el.dataset.stage;
        if (next !== 'month' && next !== 'all') return;
        const needFetch = next !== state.stage;
        state.stage = next;
        render();
        if (needFetch) refreshTop();
      },
      'other-bookmarks': (e, el) => { e.preventDefault(); e.stopPropagation(); showOther(state.items.find((x) => x.id === el.getAttribute('data-id'))); },
      'hide-origin': (e, el) => { e.preventDefault(); e.stopPropagation(); const origin = el.getAttribute('data-origin'); const next = [...new Set([...(ctx.homeUi.hiddenOrigins || []), origin])]; state.hovered = state.focused = state.pressed = false; state.pending = null; const save = ctx.setHomeUi({ hiddenOrigins: next }); render(); save.then(() => refreshTop()).catch(() => render()); },
      'restore-origins': () => { const save = ctx.setHomeUi({ hiddenOrigins: [] }); render(); save.then(() => refreshTop()).catch(() => render()); },
    });

    load();
    return {
      unmount() {
        disposed = true;
        requestSeq++;
        clearTimeout(skeletonTimer);
        document.removeEventListener('pointerup', release, true);
        document.removeEventListener('pointercancel', release, true);
        unwatch();
        unbind();
        if (typeof chrome !== 'undefined' && chrome.permissions) {
          chrome.permissions.onRemoved?.removeListener(onPermissionRemoved);
          chrome.permissions.onAdded?.removeListener(onPermissionAdded);
          chrome.history?.onVisitRemoved?.removeListener?.(onHistoryRemoved);
        }
      },
    };
  },
};
