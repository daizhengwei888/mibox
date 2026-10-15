// 快速搜索页入口：网页浮层（iframe）或独立小窗口。
import { mountSearch } from './search-core.js';
import { setOverlayToken } from '../../shared/client.js';

const params = new URLSearchParams(location.search);
const mode = params.get('mode') === 'window' ? 'window' : 'overlay';
if (mode === 'window') document.documentElement.classList.add('qs-window');
else {
  // iframe 的配色方案必须和外面一致，否则浏览器会给整个浮层铺一层不透明底色。
  document.documentElement.style.colorScheme = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}
if (mode === 'overlay') {
  // 浮层嵌在网页里，必须带一次性令牌才能调后台；没有令牌说明是别人嵌的，什么都不做。
  const token = params.get('t') || '';
  if (!token) {
    document.body.textContent = '请在谜盒里按快捷键打开搜索';
    throw new Error('overlay without token');
  }
  setOverlayToken(token);
}

const scrim = document.getElementById('scrim');
const holder = document.getElementById('holder');

function close() {
  if (mode === 'window') window.close();
  else window.parent.postMessage({ sq: 'close' }, '*');
}

mountSearch(holder, {
  mode,
  pageUrl: params.get('url') || '',
  pageTitle: params.get('title') || '',
  onClose: close,
});

scrim.addEventListener('mousedown', (e) => {
  if (e.target === scrim && mode === 'overlay') close();
});
