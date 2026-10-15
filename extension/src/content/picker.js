// 「到页面上点选」：鼠标移到元素上高亮，点一下就记下它的选择器和文字，发回插件。
// 由后台注入，参数放在 window.__sqPicker 里（{ token, mode, hint }）。
(() => {
  const opts = window.__sqPicker || {};
  if (window.__sqPickerActive) return;
  window.__sqPickerActive = true;

  const host = document.createElement('div');
  host.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none;';
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = `
    <style>
      .box{position:fixed;border:2px solid #0B6B57;background:rgba(11,107,87,.12);border-radius:4px;pointer-events:none;transition:all .06s;display:none}
      .bar{position:fixed;left:50%;top:16px;transform:translateX(-50%);display:flex;align-items:center;gap:12px;padding:10px 14px;
        background:#17201D;color:#fff;border-radius:10px;font:14px/1.5 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif;
        box-shadow:0 10px 30px rgba(0,0,0,.3);pointer-events:auto;max-width:90vw}
      .bar b{font-weight:600}
      .bar button{font:inherit;height:30px;padding:0 12px;border-radius:7px;border:1px solid #5B6A64;background:transparent;color:#fff;cursor:pointer}
      .tip{position:fixed;padding:3px 8px;background:#0B6B57;color:#fff;border-radius:6px;font:12px/1.5 -apple-system,"PingFang SC",sans-serif;display:none;max-width:320px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    </style>
    <div class="box"></div>
    <div class="tip"></div>
    <div class="bar" role="dialog" aria-label="点选元素"><span><b>谜盒</b> · ${opts.mode === 'success' ? '点一下签到成功后会出现的那个地方' : '把鼠标移到签到按钮上，点一下就选好了'}</span><button type="button">取消（Esc）</button></div>`;
  const box = root.querySelector('.box');
  const tip = root.querySelector('.tip');
  const bar = root.querySelector('.bar');
  document.documentElement.appendChild(host);

  let current = null;
  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const textOf = (el) => norm(el.innerText || el.value || el.getAttribute('aria-label') || el.title || el.alt).slice(0, 60);

  // 点到按钮里的图标或文字时，选外面那个可点的元素。
  function clickable(el) {
    let n = el;
    for (let i = 0; i < 4 && n && n !== document.body; i++) {
      if (n.matches && n.matches('button,a,input,[role=button],[onclick],label,summary')) return n;
      n = n.parentElement;
    }
    return el;
  }

  const looksGenerated = (s) => /\d{3,}|[a-z0-9]{10,}|^css-|^sc-|__|--[a-z0-9]{5,}/i.test(s);
  const esc = (s) => (window.CSS && CSS.escape ? CSS.escape(s) : s.replace(/([^\w-])/g, '\\$1'));
  const unique = (sel) => {
    try {
      return document.querySelectorAll(sel).length === 1;
    } catch {
      return false;
    }
  };

  function selectorFor(el) {
    if (el.id && !looksGenerated(el.id) && unique('#' + esc(el.id))) return '#' + esc(el.id);
    for (const attr of ['data-testid', 'data-action', 'name', 'aria-label', 'title']) {
      const v = el.getAttribute(attr);
      if (v && v.length < 60) {
        const sel = `${el.tagName.toLowerCase()}[${attr}="${v.replace(/"/g, '\\"')}"]`;
        if (unique(sel)) return sel;
      }
    }
    const parts = [];
    let n = el;
    for (let depth = 0; n && n.nodeType === 1 && n !== document.documentElement && depth < 6; depth++) {
      let part = n.tagName.toLowerCase();
      if (n.id && !looksGenerated(n.id)) {
        parts.unshift('#' + esc(n.id) + (parts.length ? '' : ''));
        const sel = parts.join(' > ');
        if (unique(sel)) return sel;
        break;
      }
      const classes = [...n.classList].filter((c) => !looksGenerated(c)).slice(0, 2);
      if (classes.length) part += '.' + classes.map(esc).join('.');
      const parent = n.parentElement;
      if (parent) {
        const same = [...parent.children].filter((c) => c.tagName === n.tagName);
        if (same.length > 1) part += `:nth-of-type(${same.indexOf(n) + 1})`;
      }
      parts.unshift(part);
      const sel = parts.join(' > ');
      if (unique(sel)) return sel;
      n = parent;
    }
    return parts.join(' > ');
  }

  function place(el) {
    const r = el.getBoundingClientRect();
    box.style.display = 'block';
    box.style.left = r.left - 2 + 'px';
    box.style.top = r.top - 2 + 'px';
    box.style.width = r.width + 4 + 'px';
    box.style.height = r.height + 4 + 'px';
    const t = textOf(el);
    tip.textContent = t ? `「${t}」` : el.tagName.toLowerCase();
    tip.style.display = 'block';
    tip.style.left = Math.max(4, r.left) + 'px';
    tip.style.top = (r.top > 30 ? r.top - 26 : r.bottom + 6) + 'px';
  }

  function onMove(e) {
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || el === host) return;
    current = clickable(el);
    place(current);
  }

  function finish(result) {
    window.removeEventListener('mousemove', onMove, true);
    window.removeEventListener('click', onClick, true);
    window.removeEventListener('mousedown', block, true);
    window.removeEventListener('mouseup', block, true);
    window.removeEventListener('keydown', onKey, true);
    host.remove();
    window.__sqPickerActive = false;
    chrome.runtime.sendMessage({ sq: 1, type: result ? 'picker.result' : 'picker.cancel', payload: { token: opts.token, ...(result || {}) } }).catch(() => {});
  }

  function block(e) {
    if (e.target === host) return;
    e.preventDefault();
    e.stopPropagation();
  }

  function onClick(e) {
    if (e.target === host) return;
    e.preventDefault();
    e.stopPropagation();
    const el = current || clickable(e.target);
    if (!el) return;
    finish({ selector: selectorFor(el), text: textOf(el), tag: el.tagName.toLowerCase(), url: location.href });
  }

  function onKey(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      finish(null);
    }
  }

  bar.querySelector('button').addEventListener('click', () => finish(null));
  window.addEventListener('mousemove', onMove, true);
  window.addEventListener('click', onClick, true);
  window.addEventListener('mousedown', block, true);
  window.addEventListener('mouseup', block, true);
  window.addEventListener('keydown', onKey, true);
})();
