// 在页面画出来之前套用主题，避免闪一下白屏。（普通脚本，放在 <head> 里同步加载）
(function () {
  var root = document.documentElement;
  try {
    var t = localStorage.getItem('sq.theme');
    if (t === 'light' || t === 'dark') root.setAttribute('data-theme', t);
    var s = localStorage.getItem('sq.skin');
    var m = localStorage.getItem('sq.motion');
    var w = localStorage.getItem('sq.sidebarWidth');
    root.setAttribute('data-skin', s || 'emboss');
    // 用户关掉轻动效或系统要求减少动态效果时，CSS 统一按 reduced 处理。
    var sysReduce = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
    root.setAttribute('data-motion', m === 'off' || sysReduce ? 'reduced' : 'on');
    if (w && /^\d+$/.test(w)) root.style.setProperty('--sidebar-width', w + 'px');
  } catch (e) {
    root.setAttribute('data-skin', 'emboss');
    root.setAttribute('data-motion', 'on');
  }
})();
