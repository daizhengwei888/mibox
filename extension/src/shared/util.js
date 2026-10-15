// 通用工具：网址规范化、时间格式、图标颜色等。后台和界面共用。

const TRACKING_PARAMS = new Set([
  'fbclid', 'gclid', 'dclid', 'msclkid', 'yclid', 'igshid', 'mc_cid', 'mc_eid',
  'spm', '_hsenc', '_hsmi', 'ref_src', 'vd_source', 'share_source', 'share_medium',
]);

/** 只接受 http(s) 网页地址，且不能带用户名密码。 */
export function isWebUrl(value) {
  if (typeof value !== 'string') return false;
  const text = value.trim();
  if (!/^https?:\/\//i.test(text)) return false;
  try {
    const u = new URL(text);
    return (u.protocol === 'http:' || u.protocol === 'https:') && !u.username && !u.password && !!u.hostname;
  } catch {
    return false;
  }
}

/** 用户输入的网址补上 https://。 */
export function coerceUrl(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  if (/^https?:\/\//i.test(text)) return text;
  if (/^[\w-]+(\.[\w-]+)+(:\d+)?(\/.*)?$/.test(text)) return 'https://' + text;
  return text;
}

/**
 * 去重用的网址键：忽略协议、www.、末尾斜杠、跟踪参数和普通锚点。
 * 单页应用的 #/ 和 #! 路由会保留。
 */
export function normalizeUrl(value) {
  const u = new URL(String(value).trim());
  let host = u.hostname.toLowerCase().replace(/^www\./, '');
  if (u.port && !((u.protocol === 'http:' && u.port === '80') || (u.protocol === 'https:' && u.port === '443'))) {
    host += ':' + u.port;
  }
  let path = u.pathname || '/';
  if (path.length > 1) path = path.replace(/\/+$/, '');
  if (path === '/') path = '';
  const params = [];
  for (const [k, v] of u.searchParams) {
    const key = k.toLowerCase();
    if (key.startsWith('utm_') || TRACKING_PARAMS.has(key)) continue;
    params.push([k, v]);
  }
  params.sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1));
  const query = params.length ? '?' + params.map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v)).join('&') : '';
  const hash = /^#[!/]/.test(u.hash) ? u.hash : '';
  return host + path + query + hash;
}

/** 查找「只差参数」的重复：只看域名和路径。 */
export function looseUrlKey(value) {
  try {
    const u = new URL(value);
    let path = u.pathname.length > 1 ? u.pathname.replace(/\/+$/, '') : '';
    return u.hostname.toLowerCase().replace(/^www\./, '') + path;
  } catch {
    return String(value);
  }
}

export function domainOf(value) {
  try {
    return new URL(value).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

// 网页标题里常见的「名称 - 简介」分隔符。只按第一个分隔符拆一次。
const TITLE_SEPARATORS = [' - ', ' – ', ' — ', ' | ', '｜', ' · ', ' _ ', '——'];

/**
 * 把「LINUX SB - 更新的技术社区」拆成主名称和简介，界面上分两行显示，不再一长串挤在一起。
 * 「GitHub - owner/repo: 说明」这类站名在前的内页标题，主名称取后半段、站名放到简介里；
 * 站点首页保持站名在前。拆不出来时 sub 为空，原样显示。
 */
export function splitTitle(title, url = '') {
  const t = String(title || '').trim();
  let at = -1;
  let sep = '';
  for (const s of TITLE_SEPARATORS) {
    const i = t.indexOf(s);
    if (i > 0 && (at < 0 || i < at)) { at = i; sep = s; }
  }
  if (at < 0) {
    // 「owner/repo: 说明」这种没有站名的标题：冒号前是仓库名、包名时拆开
    const c = t.indexOf(': ');
    if (c > 0 && /^[\w.@/-]{3,40}$/.test(t.slice(0, c)) && /[/@.]/.test(t.slice(0, c)) && t.slice(c + 2).trim()) return { main: t.slice(0, c), sub: t.slice(c + 2).trim() };
    return { main: t, sub: '' };
  }
  const main = t.slice(0, at).trim();
  const sub = t.slice(at + sep.length).trim();
  if ([...main].length < 2 || !sub) return { main: t, sub: '' };
  try {
    const u = new URL(url);
    const labels = u.hostname.replace(/^www\./, '').split('.');
    const brand = (labels.length > 1 ? labels[labels.length - 2] : labels[0]) || '';
    const deep = u.pathname.replace(/\/+$/, '') !== '' || u.search !== '';
    if (deep && brand && main.toLowerCase().replace(/[^a-z0-9]/g, '') === brand.toLowerCase().replace(/[^a-z0-9]/g, '')) {
      // 「GitHub - owner/repo: 说明」：仓库名做主名称，说明和站名放进简介
      const colon = sub.indexOf(': ');
      if (colon > 1) return { main: sub.slice(0, colon).trim(), sub: `${sub.slice(colon + 2).trim()} · ${main}` };
      return { main: sub, sub: main };
    }
  } catch {}
  // 「owner/repo: 说明 · GitHub」：冒号前是仓库名、包名这类标识时，说明挪进简介
  const colon = main.indexOf(': ');
  if (colon > 0 && /^[\w.@/-]{3,40}$/.test(main.slice(0, colon)) && /[/@.]/.test(main.slice(0, colon))) return { main: main.slice(0, colon), sub: `${main.slice(colon + 2).trim()} · ${sub}` };
  return { main, sub };
}

export function originOf(value) {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

/** 站点匹配：同一个可注册域名的子域名也算（a.example.com 匹配 example.com）。 */
export function siteMatches(site, url) {
  const host = domainOf(url);
  const s = String(site || '').toLowerCase().replace(/^www\./, '').replace(/^https?:\/\//, '').split('/')[0];
  if (!host || !s) return false;
  return host === s || host.endsWith('.' + s) || s.endsWith('.' + host);
}

export function uid() {
  return crypto.randomUUID();
}

export function clampText(value, max) {
  const text = String(value ?? '');
  return text.length > max ? text.slice(0, max) : text;
}

const TILE_COUNT = 8;
/** 由域名决定的字母图标颜色序号（0-7），同一网站颜色固定。 */
export function tileIndex(key) {
  let h = 0;
  const s = String(key || '');
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % TILE_COUNT;
}

/** 字母图标上显示的字：中文标题取第一个汉字，否则取域名首字母。 */
export function tileLetter(title, url) {
  const t = String(title || '').trim();
  const first = t ? [...t][0] : '';
  if (first && /[㐀-鿿]/.test(first)) return first;
  const fromTitle = t.match(/[a-z0-9]/i);
  if (fromTitle) return fromTitle[0].toUpperCase();
  const d = domainOf(url);
  const c = (d || '?').replace(/^[^a-z0-9]+/i, '')[0] || '?';
  return c.toUpperCase();
}

const DAY = 86400000;
function sameDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}
function hm(d) {
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

/** 「刚刚」「5 分钟前」「今天 08:00」「昨天」「10月6日」「2024年3月2日」 */
export function formatWhen(ts, now = Date.now()) {
  if (!ts) return '';
  const diff = now - ts;
  const d = new Date(ts);
  const n = new Date(now);
  if (diff >= 0 && diff < 60000) return '刚刚';
  if (diff >= 0 && diff < 3600000) return Math.floor(diff / 60000) + ' 分钟前';
  if (sameDay(d, n)) return '今天 ' + hm(d);
  if (sameDay(d, new Date(now - DAY))) return '昨天';
  if (d.getFullYear() === n.getFullYear()) return d.getMonth() + 1 + '月' + d.getDate() + '日';
  return d.getFullYear() + '年' + (d.getMonth() + 1) + '月' + d.getDate() + '日';
}

export function formatClock(ts) {
  return ts ? hm(new Date(ts)) : '';
}

export function todayKey(ts = Date.now()) {
  const d = new Date(ts);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

/** 文本搜索：空格分隔的每个词都要出现（不区分大小写）。 */
export function makeMatcher(query) {
  const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return () => true;
  return (...fields) => {
    const hay = fields.map((f) => String(f ?? '')).join('\n').toLowerCase();
    return words.every((w) => hay.includes(w));
  };
}

/** 找到第一个词在文本里的位置，用于高亮。返回 [前, 命中, 后]。 */
export function splitHit(text, query) {
  const s = String(text ?? '');
  const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  const lower = s.toLowerCase();
  for (const w of words) {
    const i = lower.indexOf(w);
    if (i >= 0) return [s.slice(0, i), s.slice(i, i + w.length), s.slice(i + w.length)];
  }
  return [s, '', ''];
}

/** 去掉 Markdown 标记，给列表摘要用。 */
export function plainText(md) {
  return String(md ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+/gm, '')
    .replace(/\[( |x|X)\]\s+/g, '')
    .replace(/(\*\*|__|~~|`)/g, '')
    .replace(/(^|\s)[*_]([^*_\s][^*_]*)[*_](?=\s|$)/g, '$1$2');
}

/** 摘要：命中词附近的一段。 */
export function excerpt(text, query, size = 90) {
  const s = plainText(text).replace(/\s+/g, ' ').trim();
  const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  const lower = s.toLowerCase();
  let at = -1;
  for (const w of words) {
    at = lower.indexOf(w);
    if (at >= 0) break;
  }
  if (at < 0 || s.length <= size) return s.slice(0, size) + (s.length > size ? '…' : '');
  const start = Math.max(0, at - Math.floor(size / 3));
  return (start > 0 ? '…' : '') + s.slice(start, start + size) + (start + size < s.length ? '…' : '');
}

export function noteTitle(note) {
  const t = String(note?.title || '').trim();
  if (t) return t;
  const firstLine = plainText(note?.body || '').split('\n').map((l) => l.trim()).find(Boolean);
  return firstLine ? clampText(firstLine, 60) : '无标题';
}

export function byteLength(text) {
  return new TextEncoder().encode(String(text ?? '')).length;
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export function base64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function fromBase64url(text) {
  const padded = text + '='.repeat((4 - (text.length % 4)) % 4);
  const bin = atob(padded.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}
