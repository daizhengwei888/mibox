// 快速搜索浮层：在网页上盖一层，里面是插件自己的搜索页（iframe，网页读不到里面的内容）。
// 再按一次快捷键或按 Esc 关闭。
(() => {
  const ID = '__shuqian_quick_search__';
  const existing = document.getElementById(ID);
  if (existing) {
    existing.__sqClose ? existing.__sqClose() : existing.remove();
    return;
  }
  const host = document.createElement('div');
  host.id = ID;
  host.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483647;display:block;';
  const shadow = host.attachShadow({ mode: 'closed' });
  const frame = document.createElement('iframe');
  // 令牌由后台注入，只有真的从快捷键打开的浮层才拿得到；网页自己嵌的拿不到。
  const token = typeof window.__sqOverlayToken === 'string' ? window.__sqOverlayToken : '';
  try {
    delete window.__sqOverlayToken;
  } catch {}
  const params = new URLSearchParams({ mode: 'overlay', url: location.href, title: document.title.slice(0, 300), t: token });
  frame.src = chrome.runtime.getURL('src/ui/search/search.html') + '?' + params.toString();
  frame.allow = 'clipboard-write';
  frame.setAttribute('title', '谜盒快速搜索');
  frame.style.cssText = 'all:initial;display:block;border:0;width:100%;height:100%;background:transparent;color-scheme:light dark;';
  shadow.appendChild(frame);
  const previous = document.activeElement;
  const prevOverflow = document.documentElement.style.overflow;

  function close() {
    window.removeEventListener('message', onMessage, true);
    host.remove();
    document.documentElement.style.overflow = prevOverflow;
    try {
      if (previous && previous.focus) previous.focus();
    } catch {}
  }
  function onMessage(e) {
    if (e.source !== frame.contentWindow) return;
    const data = e.data || {};
    if (data.sq === 'close') close();
    if (data.sq === 'navigate' && typeof data.url === 'string' && /^https?:\/\//.test(data.url)) {
      close();
      location.href = data.url;
    }
  }
  host.__sqClose = close;
  window.addEventListener('message', onMessage, true);
  document.documentElement.appendChild(host);
  document.documentElement.style.overflow = 'hidden';
  frame.addEventListener('load', () => frame.focus());
})();
