// 极简的界面工具：html`` 模板（自动转义）、morph（只改变化的部分，保留焦点和输入）、事件委托。

export class Safe {
  constructor(text) {
    this.text = text;
  }
  toString() {
    return this.text;
  }
}

/** 不转义（只给自己写的 SVG 和已转义的片段用）。 */
export const raw = (text) => new Safe(String(text ?? ''));

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' };
export function escapeHtml(value) {
  return String(value).replace(/[&<>"'`]/g, (c) => ESC[c]);
}

function piece(value) {
  if (value === null || value === undefined || value === false || value === true) return '';
  if (value instanceof Safe) return value.text;
  if (Array.isArray(value)) return value.map(piece).join('');
  return escapeHtml(value);
}

export function html(strings, ...values) {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) out += piece(values[i]) + strings[i + 1];
  return new Safe(out);
}

/** 把容器内容更新成新的 HTML，只改有变化的节点。带 data-key 的元素按 key 对应。 */
export function morph(container, content) {
  const tpl = document.createElement('template');
  tpl.innerHTML = content instanceof Safe ? content.text : String(content ?? '');
  patchChildren(container, tpl.content);
}

function keyOf(node) {
  return node.nodeType === 1 ? node.getAttribute('data-key') : null;
}

function sameKind(a, b) {
  return a.nodeType === b.nodeType && (a.nodeType !== 1 || (a.tagName === b.tagName && keyOf(a) === keyOf(b)));
}

function patchChildren(parent, next) {
  const oldNodes = [...parent.childNodes];
  const keyed = new Map();
  for (const n of oldNodes) {
    const k = keyOf(n);
    if (k !== null) keyed.set(n.tagName + '\u0000' + k, n);
  }
  const used = new Set();
  let cursor = 0;
  let ref = parent.firstChild;
  for (const nn of [...next.childNodes]) {
    let match = null;
    const k = keyOf(nn);
    if (k !== null) {
      const cand = keyed.get(nn.tagName + '\u0000' + k);
      if (cand && !used.has(cand)) match = cand;
    } else {
      while (cursor < oldNodes.length && (used.has(oldNodes[cursor]) || keyOf(oldNodes[cursor]) !== null)) cursor++;
      if (cursor < oldNodes.length && sameKind(oldNodes[cursor], nn)) {
        match = oldNodes[cursor];
        cursor++;
      }
    }
    if (match) {
      used.add(match);
      patchNode(match, nn);
      if (match !== ref) parent.insertBefore(match, ref);
      ref = match.nextSibling;
    } else {
      parent.insertBefore(nn, ref);
      ref = nn.nextSibling;
    }
  }
  for (const n of oldNodes) if (!used.has(n) && n.parentNode === parent) n.remove();
}

function patchNode(old, next) {
  if (old.nodeType !== 1) {
    if (old.nodeValue !== next.nodeValue) old.nodeValue = next.nodeValue;
    return;
  }
  const tag = old.tagName;
  for (const attr of [...next.attributes]) {
    if (tag === 'DETAILS' && attr.name === 'open') continue;
    if (old.getAttribute(attr.name) !== attr.value) old.setAttribute(attr.name, attr.value);
  }
  for (const attr of [...old.attributes]) {
    if (tag === 'DETAILS' && attr.name === 'open') continue;
    if (!next.hasAttribute(attr.name)) old.removeAttribute(attr.name);
  }
  const uncontrolled = old.hasAttribute('data-uncontrolled');
  if (tag === 'INPUT') {
    const type = (old.getAttribute('type') || 'text').toLowerCase();
    if (type === 'checkbox' || type === 'radio') {
      old.checked = next.hasAttribute('checked');
    } else if (!uncontrolled && document.activeElement !== old) {
      const v = next.getAttribute('value') ?? '';
      if (old.value !== v) old.value = v;
    }
    return;
  }
  if (tag === 'TEXTAREA') {
    if (!uncontrolled && document.activeElement !== old) {
      const v = next.textContent;
      if (old.value !== v) old.value = v;
    }
    return;
  }
  if (old.hasAttribute('data-morph-skip')) return;
  patchChildren(old, next);
  if (tag === 'SELECT') {
    const sel = next.querySelector('option[selected]');
    const v = sel ? sel.getAttribute('value') ?? sel.textContent : old.options[0]?.value;
    if (v !== undefined && old.value !== v) old.value = v;
  }
}

/**
 * 事件委托：元素上写 data-click="save"、data-input="search"、data-change、data-submit、data-keydown、data-blur。
 * handlers.save(event, element)
 */
export function bind(root, handlers) {
  const types = { click: 'click', input: 'input', change: 'change', submit: 'submit', keydown: 'keydown', blur: 'focusout', dragstart: 'dragstart', dragover: 'dragover', drop: 'drop', dragend: 'dragend', dragleave: 'dragleave', contextmenu: 'contextmenu' };
  const added = [];
  for (const [name, type] of Object.entries(types)) {
    const listener = (e) => {
      const el = e.target?.closest?.(`[data-${name}]`);
      if (!el || !root.contains(el)) return;
      const fn = handlers[el.getAttribute(`data-${name}`)];
      if (!fn) return;
      if (name === 'submit') e.preventDefault();
      // 处理函数返回 Promise 时接住异常，否则一处漏 catch 就会让整个页面卡住没有反馈。
      const r = fn(e, el);
      if (r && typeof r.then === 'function') r.catch((err) => console.error('[谜盒] 操作失败', err));
    };
    root.addEventListener(type, listener);
    added.push([type, listener]);
  }
  return () => {
    for (const [type, listener] of added) root.removeEventListener(type, listener);
  };
}

/** 合并多次 setState，下一帧渲染一次。 */
export function scheduler(render) {
  let queued = false;
  return () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      render();
    });
  };
}

export const $ = (sel, root = document) => root.querySelector(sel);

export function debounce(fn, ms) {
  let t = null;
  const wrapped = (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
  wrapped.flush = (...args) => {
    clearTimeout(t);
    return fn(...args);
  };
  wrapped.cancel = () => clearTimeout(t);
  return wrapped;
}
