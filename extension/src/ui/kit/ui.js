// 界面里反复用到的小部件：字母图标、提示条、确认框、下拉菜单、下载、站点授权。

import { html, raw, escapeHtml } from './dom.js';
import { icon } from './icons.js';
import { tileIndex, tileLetter, domainOf, originOf } from '../../shared/util.js';
import { call, onChange, getWorkspaceEpoch } from '../../shared/client.js';

// ───────────── 主题 ─────────────

export function applyTheme(theme) {
  const t = theme === 'light' || theme === 'dark' ? theme : '';
  if (t) document.documentElement.setAttribute('data-theme', t);
  else document.documentElement.removeAttribute('data-theme');
  try {
    if (t) localStorage.setItem('sq.theme', t);
    else localStorage.removeItem('sq.theme');
  } catch {}
}

export const UI_SKINS = ['emboss', 'neo-apple', 'ivory-cobalt', 'mist-slate', 'liquid', 'dusk-widgets', 'cardiology', 'cream-paper', 'smoked-glass'];

const animationSets = new Set();
let motionMedia = null;
let motionListenersInstalled = false;
const activePressed = new Set();
const liveToasts = new Set();
let appearanceGeneration = 0;
let userMotion = 'on';
// 最近一次输入是键盘还是指针：键盘打开的菜单不播展开动画。
let lastInput = 'pointer';

function systemReducesMotion() {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** 用户关掉「轻动效」或系统要求减少动态效果时都写 reduced，CSS 只认这一个状态。 */
function syncMotion() {
  if (typeof document === 'undefined') return;
  document.documentElement.dataset.motion = userMotion === 'off' || systemReducesMotion() ? 'reduced' : 'on';
}

export function motionAllowed() {
  return typeof document !== 'undefined' && document.documentElement.dataset.motion === 'on' && !systemReducesMotion();
}

function cancelAnimations() {
  for (const set of animationSets) set.cancel();
}

function clearPressed() {
  for (const el of activePressed) el.removeAttribute('data-pressing');
  activePressed.clear();
}

function installMotionListeners() {
  if (motionListenersInstalled || typeof document === 'undefined') return;
  motionListenersInstalled = true;
  motionMedia = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
  motionMedia?.addEventListener?.('change', () => { syncMotion(); cancelAnimations(); clearPressed(); });
  document.addEventListener('visibilitychange', () => {
    document.documentElement.dataset.uiHidden = document.hidden ? 'true' : 'false';
    if (document.hidden) cancelAnimations();
    clearPressed();
  });
  document.addEventListener('keydown', () => { lastInput = 'keyboard'; }, true);
  document.addEventListener('pointerdown', () => { lastInput = 'pointer'; }, true);
  document.addEventListener('pointerdown', (e) => {
    const el = e.target.closest?.('.btn, .icon-btn, .link-btn, .chip');
    if (!el || !motionAllowed() || e.pointerType === 'touch' && el.closest('.dense-list')) return;
    el.dataset.pressing = 'true';
    activePressed.add(el);
  }, { passive: true });
  document.addEventListener('pointerup', clearPressed, true);
  document.addEventListener('pointercancel', clearPressed, true);
}

/** Apply account-local appearance without changing the independent theme setting. */
export function applyAppearance({ skin = 'emboss', motion = true, sidebarWidth = 248 } = {}) {
  const root = document.documentElement;
  const useSkin = UI_SKINS.includes(skin) ? skin : 'emboss';
  const useMotion = motion === false ? 'off' : 'on';
  userMotion = useMotion;
  root.dataset.skin = useSkin;
  syncMotion();
  root.style.setProperty('--sidebar-width', `${Number.isInteger(sidebarWidth) && sidebarWidth >= 224 && sidebarWidth <= 304 ? sidebarWidth : 248}px`);
  // 和主题一样镜像到 localStorage：下次打开时 theme-boot 能提前套上，不用先闪一帧默认外观。
  try {
    localStorage.setItem('sq.skin', useSkin);
    localStorage.setItem('sq.motion', useMotion);
    localStorage.setItem('sq.sidebarWidth', String(sidebarWidth));
  } catch {}
  installMotionListeners();
  if (!motionAllowed()) { cancelAnimations(); clearPressed(); }
}

/** 外观或明暗切换：支持 View Transitions 时整页交叉淡入 200ms（只有透明度变化，减少动态时也可以保留）。 */
export function withViewTransition(fn) {
  if (typeof document === 'undefined' || typeof document.startViewTransition !== 'function' || document.hidden) return fn();
  try {
    document.startViewTransition(fn);
  } catch {
    fn();
  }
}

/** 播放一段短动画并记下来，用户改动效设置时可以安全地中途取消。 */
export function feedback(element, frames, options = {}) {
  if (!element || !motionAllowed() || typeof element.animate !== 'function') return null;
  const animation = element.animate(frames, { duration: 180, easing: EASE_OUT, fill: 'both', ...options });
  const set = { cancel() { try { animation.cancel(); } catch {} animationSets.delete(set); } };
  animationSets.add(set);
  animation.finished.catch(() => {}).finally(() => { try { animation.cancel(); } catch {} animationSets.delete(set); });
  return animation;
}

/** 和 base.css 的 --ease-out 同一条曲线；WAAPI 读不到 CSS 变量，这里写成常量。 */
export const EASE_OUT = 'cubic-bezier(0.23, 1, 0.32, 1)';
const enteredPages = new Set();

/** 入场只给前六张卡，并且同一个页面在本次打开完整页期间只播一次：来回切换页面时不再重复入场。 */
export function enterCards(root, key = '') {
  if (!root || !motionAllowed()) return;
  if (key) {
    if (enteredPages.has(key)) return;
    enteredPages.add(key);
  }
  const cards = [...root.querySelectorAll('.card, .bookmark-card, .bm-card, .home-item, .shelf-item, [data-card]')].slice(0, 6);
  cards.forEach((el, i) => feedback(el, [{ opacity: 0, transform: 'translateY(4px)' }, { opacity: 1, transform: 'none' }], { duration: 180, delay: i * 30 }));
}

async function bootstrapAppearance() {
  const generation = ++appearanceGeneration;
  const epoch = getWorkspaceEpoch();
  try {
    const prefs = await call('home.uiGet');
    if (generation !== appearanceGeneration || (epoch !== null && getWorkspaceEpoch() !== epoch)) return;
    if (document.documentElement.dataset.pendingAppearance === 'true') return;
    applyAppearance(prefs || {});
  } catch {}
}

if (typeof document !== 'undefined') {
  bootstrapAppearance();
  onChange(['settings', 'appearance'], () => bootstrapAppearance());
  window.addEventListener('workspace-changed', () => {
    appearanceGeneration++;
    cancelAnimations();
    clearPressed();
  });
}

// ───────────── 字母图标 ─────────────

export function faviconUrl(pageUrl, size = 32) {
  return chrome.runtime.getURL('/_favicon/') + '?pageUrl=' + encodeURIComponent(pageUrl) + '&size=' + size;
}

// Chrome 没缓存某个网站的图标时会返回一个默认的地球图标。用它的样子做对比，
// 遇到默认图标就不显示，保留字母。
const favState = new Map(); // src -> 'ok' | 'none'
const favTone = new Map(); // src -> 'black' | 'white' | 'color' | 'unknown'
const defaultSigs = new Map(); // size -> Promise<string|null>

export function faviconTone(data) {
  const pixels = data?.data || data;
  if (!pixels || typeof pixels.length !== 'number' || pixels.length < 4) return 'unknown';
  let visible = 0;
  let dark = 0;
  let light = 0;
  let colorful = 0;
  for (let i = 0; i + 3 < pixels.length; i += 4) {
    const a = pixels[i + 3];
    if (a < 32) continue;
    visible++;
    const r = pixels[i], g = pixels[i + 1], b = pixels[i + 2];
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    if (max - min > 28) colorful++;
    const y = (r * 299 + g * 587 + b * 114) / 1000;
    if (y < 72) dark++;
    if (y > 210) light++;
  }
  if (!visible) return 'unknown';
  if (colorful / visible > 0.08) return 'color';
  if (dark / visible > 0.72) return 'black';
  if (light / visible > 0.72) return 'white';
  return 'color';
}

function signature(img) {
  const c = document.createElement('canvas');
  c.width = c.height = 16;
  const g = c.getContext('2d');
  g.drawImage(img, 0, 0, 16, 16);
  return c.toDataURL();
}

function loadDefaultSignature(size) {
  if (!defaultSigs.has(size)) {
    defaultSigs.set(
      size,
      new Promise((resolve) => {
        const im = new Image();
        im.onload = () => {
          let sig = null;
          try {
            sig = signature(im);
          } catch {}
          resolve(sig);
        };
        im.onerror = () => resolve(null);
        im.src = faviconUrl('https://no-favicon.invalid/', size);
      }),
    );
  }
  return defaultSigs.get(size);
}

if (typeof document !== 'undefined') {
  document.addEventListener(
    'load',
    async (e) => {
      const img = e.target;
      if (!(img instanceof HTMLImageElement) || !img.classList.contains('fav')) return;
      const src = img.getAttribute('src');
      const cached = favState.get(src);
      const size = Number(new URL(src, location.href).searchParams.get('size')) || 32;
      const sig = cached ? null : await loadDefaultSignature(size);
      if (!img.isConnected || img.getAttribute('src') !== src) return;
      let state = cached || 'ok';
      let tone = favTone.get(src) || 'unknown';
      try {
        if (sig && signature(img) === sig) state = 'none';
        if (state === 'ok' && !favTone.has(src)) {
          const c = document.createElement('canvas');
          c.width = c.height = 32;
          const g = c.getContext('2d', { willReadFrequently: true });
          g.drawImage(img, 0, 0, 32, 32);
          tone = faviconTone(g.getImageData(0, 0, 32, 32));
        }
      } catch {}
      if (favState.size > 600) { favState.clear(); favTone.clear(); }
      favState.set(src, state);
      favTone.set(src, tone);
      if (state === 'none') img.remove();
      else {
        img.classList.add('ok', `tone-${tone}`);
        img.parentElement?.classList.add('has-fav', `fav-tone-${tone}`);
      }
    },
    true,
  );
  document.addEventListener(
    'error',
    (e) => {
      const img = e.target;
      if (img instanceof HTMLImageElement && img.classList.contains('fav')) {
        favState.set(img.getAttribute('src'), 'none');
        favTone.delete(img.getAttribute('src'));
        img.parentElement?.classList.remove('has-fav', 'fav-tone-black', 'fav-tone-white', 'fav-tone-color', 'fav-tone-unknown');
        img.remove();
      }
    },
    true,
  );
}

/** 网站图标：字母底 + 可选的网站 favicon（有真图标时才盖上去）。 */
export function tile(title, url, size = 30, favicons = false) {
  const idx = tileIndex(domainOf(url) || title);
  const letter = tileLetter(title, url);
  let fav = '';
  let cls = '';
  if (favicons && url) {
    const src = faviconUrl(url, size > 32 ? 64 : 32);
    const st = favState.get(src);
    const tone = favTone.get(src);
    if (st !== 'none') fav = raw(`<img class="fav${st === 'ok' ? ` ok tone-${tone || 'unknown'}` : ''}" src="${escapeHtml(src)}" alt="" loading="lazy" decoding="async">`);
    if (st === 'ok') cls = ` has-fav fav-tone-${tone || 'unknown'}`;
  }
  return html`<span class="tile t${idx}${cls}" style="--s:${size}px" aria-hidden="true">${letter}${fav}</span>`;
}

// ───────────── 提示条 ─────────────

let toastHost = null;
function host() {
  if (!toastHost) {
    toastHost = document.createElement('div');
    toastHost.className = 'toasts';
    toastHost.setAttribute('role', 'status');
    toastHost.setAttribute('aria-live', 'polite');
    document.body.appendChild(toastHost);
  }
  return toastHost;
}

/**
 * toast('已删除', { action: { label: '撤销', run: fn }, timeout: 6000, error: false })
 */
export function toast(message, opts = {}) {
  const el = document.createElement('div');
  el.className = 'toast' + (opts.error ? ' error' : '');
  const span = document.createElement('span');
  span.textContent = message;
  el.appendChild(span);
  let timer = null;
  let remaining = opts.timeout ?? (opts.action ? 7000 : 3200);
  let startedAt = 0;
  let paused = 0; // 悬停、聚焦和页面隐藏都会暂停，全部恢复后才继续计时
  const start = () => { clearTimeout(timer); startedAt = Date.now(); timer = setTimeout(close, Math.max(remaining, 600)); };
  const pause = () => { if (paused++ === 0) { clearTimeout(timer); remaining -= Date.now() - startedAt; } };
  const resume = () => { if (paused > 0 && --paused === 0) start(); };
  const handle = { pause, resume };
  const close = () => {
    if (el.dataset.leaving) return;
    clearTimeout(timer);
    liveToasts.delete(handle);
    // 先播退场再移除；退场比进场快
    el.dataset.leaving = 'true';
    const done = () => el.remove();
    el.addEventListener('transitionend', done, { once: true });
    setTimeout(done, 220);
  };
  el.__close = close;
  el.addEventListener('pointerenter', pause);
  el.addEventListener('pointerleave', resume);
  el.addEventListener('focusin', pause);
  el.addEventListener('focusout', resume);
  if (opts.action) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = opts.action.label;
    b.addEventListener('click', () => {
      close();
      opts.action.run();
    });
    el.appendChild(b);
  }
  const x = document.createElement('button');
  x.type = 'button';
  x.className = 'close';
  x.setAttribute('aria-label', '关闭提示');
  x.innerHTML = String(icon('x', 14));
  x.addEventListener('click', close);
  el.appendChild(x);
  const h = host();
  // 超过三条时让最旧的一条退场，而不是直接删掉
  const live = () => h.querySelectorAll('.toast:not([data-leaving])');
  while (live().length >= 3) live()[0].__close();
  h.appendChild(el);
  liveToasts.add(handle);
  start();
  if (typeof document !== 'undefined' && document.hidden) pause();
  return close;
}

// 切到别的标签页时提示条暂停计时，回来还能看到带「撤销」的提示。
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    for (const t of liveToasts) document.hidden ? t.pause() : t.resume();
  });
}

export function toastError(e, fallback = '操作失败') {
  toast(e?.message || fallback, { error: true, timeout: 5000 });
}

// ───────────── 对话框 ─────────────

/**
 * 打开一个对话框。build(close) 返回 HTML，onMount(root, close) 绑定事件。返回 close。
 */
/**
 * 把 Tab 循环限制在一个浮层里，并返回解绑函数。浮层打开时读屏和键盘都不会跑到后面的页面。
 */
// 单选框组（role=radiogroup）按方向键切换、整组只占一个 Tab 停靠点，和原生 radio 一致。
if (typeof document !== 'undefined') {
  document.addEventListener('keydown', (e) => {
    const group = e.target instanceof Element ? e.target.closest('[role="radiogroup"]') : null;
    if (!group || group.dataset.roving === 'off') return;
    const items = [...group.querySelectorAll('[role="radio"]:not(:disabled)')];
    if (items.length < 2) return;
    const i = items.indexOf(e.target);
    if (i < 0) return;
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    let next = null;
    if (step) next = items[(i + step + items.length) % items.length];
    else if (e.key === 'Home') next = items[0];
    else if (e.key === 'End') next = items[items.length - 1];
    if (!next) return;
    e.preventDefault();
    for (const it of items) it.tabIndex = it === next ? 0 : -1;
    next.focus();
    next.click();
  }, true);
}

export function trapFocus(box) {
  const onKey = (e) => {
    if (e.key !== 'Tab') return;
    const items = [...box.querySelectorAll('button,a[href],input,select,textarea,[tabindex]:not([tabindex="-1"])')].filter((el) => !el.disabled && el.offsetParent !== null);
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };
  document.addEventListener('keydown', onKey, true);
  return () => document.removeEventListener('keydown', onKey, true);
}

export function modal({ title, body, wide = false, onMount, onClose, labelledBy }) {
  const scrim = document.createElement('div');
  scrim.className = 'modal-scrim';
  const box = document.createElement('div');
  box.className = 'modal' + (wide ? ' wide' : '');
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-modal', 'true');
  const titleId = labelledBy || 'm-' + Math.random().toString(36).slice(2);
  box.setAttribute('aria-labelledby', titleId);
  box.innerHTML = String(html`<div class="modal-head"><h2 id="${titleId}">${title}</h2><button type="button" class="icon-btn" data-modal-close aria-label="关闭">${icon('x', 18)}</button></div>`) + String(body);
  scrim.appendChild(box);
  const previous = document.activeElement;
  let closed = false;
  const close = (result) => {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKey, true);
    releaseTrap();
    scrim.dataset.leaving = 'true';
    const done = () => scrim.remove();
    scrim.addEventListener('transitionend', (e) => { if (e.target === scrim) done(); });
    setTimeout(done, 220);
    try {
      previous?.focus?.();
    } catch {}
    onClose?.(result);
  };
  const onKey = (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close(null);
    }
  };
  document.addEventListener('keydown', onKey, true);
  const releaseTrap = trapFocus(box);
  scrim.addEventListener('mousedown', (e) => {
    if (e.target === scrim) close(null);
  });
  box.querySelector('[data-modal-close]').addEventListener('click', () => close(null));
  document.body.appendChild(scrim);
  onMount?.(box, close);
  const focusTarget = box.querySelector('[autofocus]') || box.querySelector('input,textarea,select') || box.querySelector('.modal-foot .btn.pri') || box.querySelector('button');
  setTimeout(() => focusTarget?.focus(), 0);
  return close;
}

/** 确认框，返回 Promise<boolean>。 */
export function confirmBox({ title, text, ok = '确定', cancel = '取消', danger = false }) {
  return new Promise((resolve) => {
    modal({
      title,
      body: html`<p class="muted" style="line-height:1.7">${text}</p>
        <div class="modal-foot"><button type="button" class="btn" data-x="cancel">${cancel}</button><button type="button" class="btn ${danger ? 'danger-fill' : 'pri'}" data-x="ok" autofocus>${ok}</button></div>`,
      onMount(box, close) {
        box.querySelector('[data-x=cancel]').addEventListener('click', () => close(false));
        box.querySelector('[data-x=ok]').addEventListener('click', () => close(true));
      },
      onClose: (r) => resolve(r === true),
    });
  });
}

/** 一个输入框的对话框，返回输入的文字或 null。 */
export function promptBox({ title, label, value = '', ok = '保存', placeholder = '', type = 'text', hint = '' }) {
  return new Promise((resolve) => {
    modal({
      title,
      body: html`<form class="col" style="gap:14px" data-x="form">
        <div class="field"><label for="pb-in">${label}</label><input id="pb-in" class="input" type="${type}" value="${value}" placeholder="${placeholder}" autocomplete="off" autofocus>
        ${hint ? html`<span class="hint">${hint}</span>` : ''}</div>
        <div class="modal-foot"><button type="button" class="btn" data-x="cancel">取消</button><button type="submit" class="btn pri">${ok}</button></div></form>`,
      onMount(box, close) {
        const input = box.querySelector('#pb-in');
        input.select();
        box.querySelector('[data-x=cancel]').addEventListener('click', () => close(null));
        box.querySelector('[data-x=form]').addEventListener('submit', (e) => {
          e.preventDefault();
          close(input.value);
        });
      },
      onClose: (r) => resolve(typeof r === 'string' ? r : null),
    });
  });
}

// ───────────── 下拉菜单 ─────────────

let openMenuEl = null;
export function closeMenu() {
  if (openMenuEl) {
    openMenuEl.__close();
  }
}

/**
 * openMenu(anchorEl, [{ label, icon, run, danger }, '-', { label: '分组', heading: true }])
 */
export function openMenu(anchor, items, opts = {}) {
  closeMenu();
  const menu = document.createElement('div');
  menu.className = 'menu';
  menu.setAttribute('role', 'menu');
  for (const it of items) {
    if (it === '-') {
      menu.appendChild(document.createElement('hr'));
      continue;
    }
    if (it.heading) {
      const h = document.createElement('div');
      h.className = 'menu-label';
      h.textContent = it.label;
      menu.appendChild(h);
      continue;
    }
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('role', 'menuitem');
    if (it.danger) b.className = 'danger';
    b.innerHTML = (it.icon ? String(icon(it.icon, 16)) : '') + `<span>${escapeHtml(it.label)}</span>` + (it.checked ? String(icon('check', 14, { cls: 'menu-check' })) : '');
    b.addEventListener('click', () => {
      close();
      it.run?.();
    });
    menu.appendChild(b);
  }
  document.body.appendChild(menu);
  const r = anchor.getBoundingClientRect();
  const mw = menu.offsetWidth;
  const mh = menu.offsetHeight;
  let left = opts.alignLeft ? r.left : r.right - mw;
  let top = r.bottom + 6;
  if (left < 8) left = 8;
  if (left + mw > innerWidth - 8) left = innerWidth - mw - 8;
  if (top + mh > innerHeight - 8) top = Math.max(8, r.top - mh - 6);
  menu.style.left = left + 'px';
  menu.style.top = top + 'px';
  // 展开原点落在触发按钮上：菜单在按钮下方就从顶边展开，翻到上方就从底边展开
  const ox = Math.min(Math.max(r.left + r.width / 2 - left, 0), mw);
  const oy = top >= r.bottom ? 0 : mh;
  menu.style.transformOrigin = `${Math.round(ox)}px ${oy}px`;
  if (lastInput === 'keyboard') menu.dataset.instant = 'true';
  const onDoc = (e) => {
    if (!menu.contains(e.target) && e.target !== anchor && !anchor.contains(e.target)) close();
  };
  const onKey = (e) => {
    const btns = [...menu.querySelectorAll('button')];
    const i = btns.indexOf(document.activeElement);
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
      anchor.focus?.();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      btns[(i + 1) % btns.length]?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      btns[(i - 1 + btns.length) % btns.length]?.focus();
    }
  };
  function close() {
    document.removeEventListener('mousedown', onDoc, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('blur', close);
    window.removeEventListener('resize', close);
    menu.remove();
    if (openMenuEl === menu) openMenuEl = null;
  }
  menu.__close = close;
  openMenuEl = menu;
  setTimeout(() => {
    document.addEventListener('mousedown', onDoc, true);
    window.addEventListener('blur', close);
    window.addEventListener('resize', close);
  }, 0);
  document.addEventListener('keydown', onKey, true);
  if (opts.focusFirst !== false) setTimeout(() => menu.querySelector('button')?.focus(), 0);
  return close;
}

// ───────────── 杂项 ─────────────

export function downloadText(filename, text, type = 'text/plain') {
  const blob = new Blob([text], { type: type + ';charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function pickFile(accept) {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.addEventListener('change', () => resolve(input.files?.[0] || null));
    // 有的环境会先报一次「取消」再送来文件：稍等一下，文件到了就用文件
    input.addEventListener('cancel', () => setTimeout(() => resolve(input.files?.[0] || null), 400));
    input.click();
  });
}

/** 是否已经拿到访问某个网站的权限。 */
export function hasSite(url) {
  const origin = originOf(url);
  if (!origin) return Promise.resolve(false);
  return chrome.permissions.contains({ origins: [origin + '/*'] }).catch(() => false);
}

export async function copyText(text, { secret = false } = {}) {
  await navigator.clipboard.writeText(text);
  if (secret) call('clipboard.scheduleClear').catch(() => {});
}

export function appUrl(hash = '') {
  return chrome.runtime.getURL('src/ui/app/app.html') + (hash ? '#' + hash.replace(/^#/, '') : '');
}

/** 打开完整页（已经开着就切过去）。 */
export async function openApp(hash = '/home') {
  const base = chrome.runtime.getURL('src/ui/app/app.html');
  const url = appUrl(hash);
  try {
    const tabs = await chrome.tabs.query({ url: base + '*' });
    if (tabs.length) {
      const t = tabs[0];
      await chrome.tabs.update(t.id, { active: true, url });
      await chrome.windows.update(t.windowId, { focused: true });
      return;
    }
  } catch {}
  await chrome.tabs.create({ url });
}
