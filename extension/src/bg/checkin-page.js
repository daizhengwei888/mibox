// 自动签到注入到网页里执行的函数。和 pageops.js 一样，每个函数必须自成一体（不能引用外部变量）。
// 思路参考 alibaba/page-agent 与 browser-use：把页面压成「带编号的可点元素」，规则先找，找不到再交给 AI。

/**
 * 在网页主环境（MAIN world）里接管 alert / confirm / prompt。
 * 后台标签页里弹窗会卡住页面；签到成功的提示也常常是一个 alert。确认框一律按「确定」。
 */
export function hookDialogsInPage() {
  if (window.__sqDialogs) return true;
  window.__sqDialogs = [];
  const push = (kind, m) => {
    try {
      window.__sqDialogs.push(kind + ':' + String(m ?? '').slice(0, 200));
    } catch {}
  };
  window.alert = (m) => push('alert', m);
  window.confirm = (m) => {
    push('confirm', m);
    return true;
  };
  window.prompt = (m, d) => {
    push('prompt', m);
    return d ?? '';
  };
  return true;
}

/** 读出并清空弹窗记录（MAIN world）。 */
export function readDialogsInPage() {
  const list = Array.isArray(window.__sqDialogs) ? window.__sqDialogs.slice() : [];
  if (window.__sqDialogs) window.__sqDialogs.length = 0;
  return list;
}

/**
 * 找签到入口：返回「今天已签」的迹象、候选按钮（按得分排序）、是否要求登录、可以直接打开的平台签到页。
 * tried：已经点过、不要再推荐的选择器。
 */
export function scanCheckinInPage(tried) {
  const skip = new Set(Array.isArray(tried) ? tried : []);
  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const st = getComputedStyle(el);
    return st.visibility !== 'hidden' && st.display !== 'none' && Number(st.opacity) > 0.05;
  };
  const label = (el) => norm(el.innerText || el.value || el.getAttribute('aria-label') || el.title || el.getAttribute('alt') || '').slice(0, 80);
  const cssPath = (el) => {
    const okId = (id) => id && /^[A-Za-z][\w-]*$/.test(id) && document.querySelectorAll('#' + CSS.escape(id)).length === 1;
    if (okId(el.id)) return '#' + CSS.escape(el.id);
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && node !== document.body && node !== document.documentElement && parts.length < 7) {
      if (okId(node.id)) {
        parts.unshift('#' + CSS.escape(node.id));
        return parts.join(' > ');
      }
      let part = node.tagName.toLowerCase();
      const parent = node.parentElement;
      if (parent) {
        const same = [...parent.children].filter((c) => c.tagName === node.tagName);
        if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(node) + 1) + ')';
      }
      parts.unshift(part);
      node = parent;
    }
    return 'body > ' + parts.join(' > ');
  };
  const POS = [
    [/^(每日|今日|立即|马上|点击|点我|快速|开始|我要)?(签\s*到|打\s*卡|报\s*到)\s*[!！]?$/i, 100],
    [/^(每日|今日|立即|马上|点击|点我|开始|我要)(签\s*到|打\s*卡|报\s*到)/, 92],
    [/领取今日的登录奖励/, 92],
    [/签到(领|得|赚|送|有礼|拿)|签到.{0,4}(奖励|积分|魔力|金币|铜币|硬币|经验)/, 86],
    [/^(领取|领)(今日|每日|今天)?的?(登录)?(奖励|积分|铜币|金币|魔力|福利)/, 82],
    [/^领取\s*\d+\s*(铜币|金币|积分|魔力|硬币|经验|点)/, 88],
    [/^daily\s*(check[\s-]*in|sign[\s-]*in|bonus|reward|login)$/i, 86],
    [/^(check[\s-]*in|claim(\s+daily)?(\s+reward)?)$/i, 80],
    [/签\s*到|打\s*卡|check[\s-]*in/i, 52],
  ];
  const NEG = /(签到|打卡)(记录|规则|说明|排行|排名|榜|日历|历史|统计|设置|奖励说明|提醒)|补签|^登\s*录$|登入|注册|退出|注销|sign\s*(up|out)|log\s*(in|out)|register|logout|删除|购买|充值|支付/i;
  const ALREADY = /(今日|今天|本日)已(经)?(签到|打卡|领取|签)|已(经)?签到|已打卡|^已签$|明[日天]再来|签到过了|您今天已经|already\s+(checked|signed)\s*in|come back tomorrow|已完成签到|每日登录奖励已领取|today.{0,12}(checked|signed)\s*in/i;
  const PLATFORM_LINK = /attendance\.php|dsu_paulsign(:|%3A)sign|k_misign(:|%3A)sign|mission\/daily|plugin\.php\?id=[\w]*sign|\/(check-?in|sign-?in\/daily|daily-?sign)\b/i;

  // 先用便宜的条件（子元素少、文字短）筛掉大部分节点，再看鼠标样式，避免大页面上逐个算样式。
  const shortPointer = [];
  for (const el of document.querySelectorAll('span,div,li,em,i,b,strong,label,p')) {
    if (el.childElementCount > 3) continue;
    const raw = (el.textContent || '').trim();
    if (!raw || raw.length > 16) continue;
    if (getComputedStyle(el).cursor === 'pointer' || el.hasAttribute('tabindex')) shortPointer.push(el);
    if (shortPointer.length > 600) break;
  }
  const pool = new Set([...document.querySelectorAll('button,a,input[type=button],input[type=submit],[role=button],[onclick]'), ...shortPointer]);
  const candidates = [];
  for (const el of pool) {
    if (!visible(el)) continue;
    if (el.closest('input[type=password],textarea,select')) continue;
    const text = label(el);
    const href = el.tagName === 'A' ? el.getAttribute('href') || '' : '';
    const onclick = el.getAttribute('onclick') || '';
    let score = 0;
    for (const [re, w] of POS) if (re.test(text)) { score = w; break; }
    if (PLATFORM_LINK.test(href) || PLATFORM_LINK.test(onclick)) score = Math.max(score, 60) + 25;
    if (!score || text.length > 30) continue;
    if (NEG.test(text)) continue;
    const tag = el.tagName.toLowerCase();
    if (tag === 'button' || tag === 'input' || el.getAttribute('role') === 'button') score += 8;
    else if (tag === 'a') score += 4;
    const disabled = !!(el.disabled || el.getAttribute('aria-disabled') === 'true' || /\bdisabled\b/.test(el.className || ''));
    if (ALREADY.test(text)) continue;
    const selector = cssPath(el);
    if (skip.has(selector)) continue;
    // 同一个按钮里的子元素和它自己都可能命中：留得分高、层级靠外的那个
    candidates.push({ el, selector, text, score, tag, disabled, href: href.slice(0, 200) });
  }
  const kept = candidates.filter((c) => !candidates.some((o) => o !== c && o.el.contains(c.el) && o.score >= c.score));
  kept.sort((a, b) => b.score - a.score);

  // 「今天已签」：在短文字和变灰的签到按钮里找
  let already = '';
  let looked = 0;
  for (const el of document.querySelectorAll('button,a,span,div,p,li,td,em,strong,b,font,input[type=button],input[type=submit]')) {
    if (++looked > 5000) break;
    const leafish = el.childElementCount === 0 || el.tagName === 'BUTTON' || el.tagName === 'A';
    if (!leafish) continue;
    const raw = (el.textContent || el.value || '').trim();
    if (!raw || raw.length > 60) continue;
    const t = label(el);
    if (t && t.length <= 40 && ALREADY.test(t) && visible(el)) {
      already = t;
      break;
    }
  }
  if (!already) {
    const grey = kept.find((c) => c.disabled && c.score >= 80);
    if (grey) already = grey.text + '（按钮已变灰）';
  }

  const hasPassword = [...document.querySelectorAll('input[type=password]')].some(visible);
  const bodyText = norm(document.body ? document.body.innerText : '').slice(0, 6000);
  const loginWall = hasPassword || /请先登录|您需要登录|登录后(才能|即可|再)|please (log|sign) in|login required/i.test(bodyText);

  // 常见论坛程序的签到页
  let recipeUrl = '';
  const html = document.documentElement.innerHTML.slice(0, 300000);
  const gen = (document.querySelector('meta[name=generator]') || {}).content || '';
  const path = location.pathname;
  if (/NexusPHP/i.test(html) && !/attendance\.php/.test(path)) recipeUrl = location.origin + '/attendance.php';
  else if (/(^|\.)v2ex\.com$/.test(location.hostname) && !/^\/mission\/daily/.test(path)) recipeUrl = location.origin + '/mission/daily';
  else if (/discuz/i.test(gen) || /discuz_uid|Discuz!/i.test(html)) {
    if (/dsu_paulsign/i.test(html) && !/dsu_paulsign/.test(location.search)) recipeUrl = location.origin + '/plugin.php?id=dsu_paulsign:sign';
    else if (/k_misign/i.test(html) && !/k_misign/.test(location.search)) recipeUrl = location.origin + '/plugin.php?id=k_misign:sign';
  }

  return {
    url: location.href,
    title: document.title,
    already,
    loginWall,
    hasPassword,
    recipeUrl,
    candidates: kept.slice(0, 8).map(({ el, ...c }) => c),
  };
}

/** 页面快照：点之前记下文字和网址，点之后对比有没有出现成功的迹象。 */
export function snapshotInPage() {
  return { text: String(document.body ? document.body.innerText : '').replace(/\s+/g, ' ').slice(0, 60000), url: location.href };
}

/** 按选择器（失效时按文字）点一个元素，用接近真人的事件顺序；带 target=_blank 的链接改在当前页打开。 */
export function clickSelectorInPage(selector, text) {
  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const visible = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none';
  };
  const label = (el) => norm(el.innerText || el.value || el.getAttribute('aria-label') || el.title);
  let el = null;
  try {
    if (selector) el = document.querySelector(selector);
  } catch {}
  if (el && !visible(el)) el = null;
  if (el && text) {
    const t = label(el);
    if (t && !t.includes(norm(text)) && !norm(text).includes(t)) el = null;
  }
  if (!el && text) {
    // 按文字找：先找一字不差的；包含关系只在不是「签到规则 / 签到记录 / 退出」这类入口时才算
    const NEG = /(签到|打卡)(记录|规则|说明|排行|排名|榜|日历|历史|统计|设置|奖励说明|提醒)|补签|^登\s*录$|注册|退出|注销|sign\s*(up|out)|log\s*(in|out)|register|删除|购买|充值|支付/i;
    const want = norm(text);
    const clickable = [...document.querySelectorAll('button,a,input[type=button],input[type=submit],[role=button],[onclick]')].filter(visible);
    el = clickable.find((c) => label(c) === want) || clickable.find((c) => label(c).includes(want) && label(c).length < want.length + 10 && (NEG.test(want) || !NEG.test(label(c)))) || null;
    if (!el) {
      // 普通元素只认一字不差的，并且取最里层的那个（不点外面的整块）
      const plain = [...document.querySelectorAll('span,div,li,em,b,strong,label,p')].filter(visible).filter((c) => label(c) === want);
      el = plain.find((c) => ![...c.children].some((k) => label(k) === want)) || null;
    }
  }
  if (!el) return { found: false };
  if (el.disabled || el.getAttribute('aria-disabled') === 'true') return { found: true, disabled: true, text: label(el) };
  const link = el.closest('a[target]');
  if (link && link.target !== '_self') link.target = '_self';
  el.scrollIntoView({ block: 'center', inline: 'center' });
  const r = el.getBoundingClientRect();
  const x = r.left + r.width / 2;
  const y = r.top + r.height / 2;
  const opts = { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 };
  try {
    el.dispatchEvent(new PointerEvent('pointerover', { ...opts, pointerType: 'mouse' }));
    el.dispatchEvent(new MouseEvent('mouseover', opts));
    el.dispatchEvent(new PointerEvent('pointerdown', { ...opts, pointerType: 'mouse' }));
    el.dispatchEvent(new MouseEvent('mousedown', opts));
    if (typeof el.focus === 'function') el.focus({ preventScroll: true });
    el.dispatchEvent(new PointerEvent('pointerup', { ...opts, pointerType: 'mouse' }));
    el.dispatchEvent(new MouseEvent('mouseup', opts));
  } catch {}
  const before = label(el);
  const a = el.closest('a[href]');
  const href = a ? a.getAttribute('href') || '' : '';
  const isLink = !!a && !/^(javascript:|#$)/i.test(href.trim()) && !a.hasAttribute('onclick') && !el.hasAttribute('onclick');
  const at = location.href.split('#')[0];
  el.click();
  return { found: true, text: before, link: isLink, at };
}

/**
 * 点完之后判断：页面上新出现了「签到成功 / 已签到 / +5 积分」之类的文字，
 * 或者点过的按钮消失、变灰、变成「已签到」。baseline 是点之前的快照。
 */
export function checkAutoSuccessInPage(baseline, selector) {
  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const SUCCESS = /签到成功|打卡成功|领取成功|已成功领取|成功签到|签到完成|今日已签|今天已签|已经签到|已签到|已打卡|已领取|明[日天]再来|获得\s*\d+|奖励\s*\d+|[+＋]\s*\d+\s*(积分|金币|铜币|魔力|经验|硬币|分|点|天|魔力值|银币)|连续签到\s*\d+|第\s*\d+\s*次签到|恭喜|check(ed)?[\s-]*in\s*(success|successful|successfully|complete|completed)|already\s+(checked|signed)|you('ve| have) (checked|signed) in/gi;
  const ALREADY = /(今日|今天)?已(经)?(签到|打卡|领取|签)|明[日天]再来|already/i;
  const FAIL = /(签到|打卡|领取|操作)失败[^。！!\s]{0,16}|请稍后再试|操作(过于|太)频繁|系统繁忙|服务器(错误|繁忙)|check[\s-]*in failed/gi;
  const now = norm(document.body ? document.body.innerText : '').slice(0, 60000);
  const before = (baseline && baseline.text) || '';
  // 点之后新出现的字样：同一句话出现的次数比点之前多
  const fresh = (re) => {
    const was = new Map();
    for (const x of before.matchAll(re)) was.set(x[0], (was.get(x[0]) || 0) + 1);
    for (const x of now.matchAll(re)) {
      const n = was.get(x[0]) || 0;
      if (n > 0) was.set(x[0], n - 1);
      else return x;
    }
    return null;
  };
  const good = fresh(SUCCESS);
  const bad = fresh(FAIL);
  if (bad && !good) return { ok: false, failed: bad[0].slice(0, 40) };
  if (good) {
    const at = good.index;
    return { ok: true, evidence: now.slice(Math.max(0, at - 12), at + good[0].length + 16) };
  }
  const samePage = baseline && baseline.url && baseline.url.split('#')[0] === location.href.split('#')[0];
  if (selector && samePage) {
    let el = null;
    try {
      el = document.querySelector(selector);
    } catch {}
    if (!el) return { ok: true, evidence: '签到按钮消失了' };
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return { ok: true, evidence: '签到按钮消失了' };
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') return { ok: true, evidence: '签到按钮变灰了' };
    const t = norm(el.innerText || el.value);
    if (ALREADY.test(t)) return { ok: true, evidence: '按钮变成「' + t.slice(0, 20) + '」' };
  }
  return { ok: false };
}

/**
 * 给 AI 看的页面：可交互元素编上号（格式参考 page-agent / browser-use），再附上和签到有关的短提示文字。
 * 不包含任何输入框里的内容；密码框直接跳过。
 */
export function dehydrateInPage(maxItems) {
  const limit = Math.max(20, Math.min(200, Number(maxItems) || 120));
  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const st = getComputedStyle(el);
    return st.visibility !== 'hidden' && st.display !== 'none' && Number(st.opacity) > 0.05;
  };
  const base = [...document.querySelectorAll('a,button,input,select,[role=button],[role=link],[role=tab],[role=menuitem],[onclick],summary,label[for]')];
  const pointer = [...document.querySelectorAll('span,div,li,em,i,b,strong,p')].filter((el) => {
    const t = norm(el.innerText);
    return t && t.length <= 24 && getComputedStyle(el).cursor === 'pointer';
  });
  const seen = new Set();
  const els = [];
  for (const el of [...base, ...pointer]) {
    if (seen.has(el) || !visible(el)) continue;
    if (el.matches('input[type=password],input[type=hidden]')) continue;
    if (els.some((p) => p.contains(el) && norm(p.innerText) === norm(el.innerText))) continue;
    seen.add(el);
    els.push(el);
    if (els.length >= limit) break;
  }
  window.__sqAiEls = els;
  const lines = els.map((el, i) => {
    const tag = el.tagName.toLowerCase();
    const attrs = [];
    const add = (k, v) => {
      v = norm(v);
      if (v) attrs.push(`${k}=${v.slice(0, 40)}`);
    };
    if (tag === 'input') add('type', el.type);
    add('role', el.getAttribute('role'));
    add('title', el.getAttribute('title'));
    add('aria-label', el.getAttribute('aria-label'));
    if (tag === 'input' && /^(button|submit)$/.test(el.type)) add('value', el.value);
    if (tag === 'input' && !/^(button|submit)$/.test(el.type)) add('placeholder', el.getAttribute('placeholder'));
    if (tag === 'a') {
      try {
        const u = new URL(el.href, location.href);
        add('href', u.origin === location.origin ? u.pathname + (u.search ? '?' + u.search.slice(1, 40) : '') : u.hostname);
      } catch {}
    }
    if (el.disabled) attrs.push('disabled');
    const text = tag === 'input' ? '' : norm(el.innerText).slice(0, 40);
    return `[${i}]<${tag}${attrs.length ? ' ' + attrs.join(' ') : ''}>${text}`;
  });
  const HINT = /签|到|领|奖|积分|金币|铜币|魔力|已|成功|失败|登录|今日|今天|每日|连续|check|daily|reward|bonus|point|claim/i;
  const hints = [];
  for (const el of document.querySelectorAll('h1,h2,h3,p,span,div,li,td,font,strong,em')) {
    if (hints.length >= 30) break;
    if (el.children.length > 0 || !visible(el)) continue;
    const t = norm(el.innerText);
    if (t && t.length <= 60 && HINT.test(t) && !hints.includes(t)) hints.push(t);
  }
  return { url: location.origin + location.pathname, title: document.title.slice(0, 80), elements: lines.join('\n').slice(0, 9000), hints };
}

/** 点 AI 选中的编号；拒绝退出、删除、付款这类危险按钮。返回能下次直接点的选择器。 */
export function aiClickInPage(index) {
  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const els = window.__sqAiEls || [];
  const el = els[index];
  if (!el || !el.isConnected) return { found: false };
  const text = norm(el.innerText || el.value || el.getAttribute('aria-label') || el.title).slice(0, 60);
  if (/退出|注销|删除|付款|支付|购买|充值|下单|注册|发帖|回复|logout|log\s*out|sign\s*out|delete|remove|pay|buy|purchase|unsubscribe/i.test(text)) return { found: true, refused: true, text };
  if (el.disabled) return { found: true, disabled: true, text };
  const okId = (id) => id && /^[A-Za-z][\w-]*$/.test(id) && document.querySelectorAll('#' + CSS.escape(id)).length === 1;
  const cssPath = (node0) => {
    if (okId(node0.id)) return '#' + CSS.escape(node0.id);
    const parts = [];
    let node = node0;
    while (node && node.nodeType === 1 && node !== document.body && node !== document.documentElement && parts.length < 7) {
      if (okId(node.id)) {
        parts.unshift('#' + CSS.escape(node.id));
        return parts.join(' > ');
      }
      let part = node.tagName.toLowerCase();
      const parent = node.parentElement;
      if (parent) {
        const same = [...parent.children].filter((c) => c.tagName === node.tagName);
        if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(node) + 1) + ')';
      }
      parts.unshift(part);
      node = parent;
    }
    return 'body > ' + parts.join(' > ');
  };
  const selector = cssPath(el);
  const link = el.closest('a[target]');
  if (link && link.target !== '_self') link.target = '_self';
  const a = el.closest('a[href]');
  const href = a ? a.getAttribute('href') || '' : '';
  const isLink = !!a && !/^(javascript:|#$)/i.test(href.trim()) && !a.hasAttribute('onclick') && !el.hasAttribute('onclick');
  const at = location.href.split('#')[0];
  el.scrollIntoView({ block: 'center', inline: 'center' });
  const r = el.getBoundingClientRect();
  const opts = { bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0 };
  try {
    el.dispatchEvent(new PointerEvent('pointerdown', { ...opts, pointerType: 'mouse' }));
    el.dispatchEvent(new MouseEvent('mousedown', opts));
    el.dispatchEvent(new PointerEvent('pointerup', { ...opts, pointerType: 'mouse' }));
    el.dispatchEvent(new MouseEvent('mouseup', opts));
  } catch {}
  el.click();
  return { found: true, selector, text, link: isLink, at };
}

/**
 * Discuz! 的 dsu_paulsign 签到页：先选心情、填一句话，再提交。
 * 页面不是这个插件时什么也不做。
 */
export function discuzPaulsignInPage() {
  const form = document.querySelector('form#qiandao, form[name=qiandao]');
  if (!form) return { handled: false };
  const mood = document.querySelector('ul.qdsmile li, #kx, .qdsmile li');
  if (mood) mood.click();
  const say = form.querySelector('#todaysay, input[name=todaysay], textarea[name=todaysay]');
  if (say && !say.value) say.value = '每日签到';
  const btn = [...document.querySelectorAll('a,button,input[type=button],input[type=submit]')].find((b) => /qiandao/i.test(b.getAttribute('onclick') || '') || /点我签到|开始签到|^签到$/.test(String(b.innerText || b.value || '').trim()));
  if (btn) btn.click();
  else if (form.requestSubmit) form.requestSubmit();
  else form.submit();
  return { handled: true };
}
