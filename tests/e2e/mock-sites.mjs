// 签到助手端到端测试用：50 个模拟网站 + 一个 OpenAI 兼容的模拟 AI 接口。
// 浏览器用 --host-resolver-rules 把 *.test 指到 127.0.0.1，按 Host 区分网站。
// 单独运行：node tests/e2e/mock-sites.mjs（默认端口 8800），管理接口：/list /state /reset /ai
import http from 'node:http';

let PORT = Number(process.env.PORT || 8800);
const state = new Map(); // host -> { signed, count, login }
const aiLog = [];
const st = (h) => {
  if (!state.has(h)) state.set(h, { signed: false, count: 0, loggedIn: false });
  return state.get(h);
};

const page = (title, body, { head = '', script = '' } = {}) => `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${title}</title>${head}
<style>body{font:14px system-ui;margin:0;color:#222}header{display:flex;gap:16px;padding:12px 20px;background:#f3f4f6}header a{color:#333}main{display:flex;gap:24px;padding:20px}aside{width:240px}.box{border:1px solid #ddd;border-radius:8px;padding:14px;margin-bottom:12px}button,.btn{padding:6px 14px;border-radius:6px;border:1px solid #888;background:#fff;cursor:pointer;display:inline-block}.sign{cursor:pointer;background:#fe8;padding:6px 12px;display:inline-block}.menu{display:none;position:absolute;background:#fff;border:1px solid #ccc;padding:8px}.menu.open{display:block}</style></head>
<body><header><a href="/">首页</a><a href="/forum">论坛</a><a href="/rules">签到规则</a><a href="/rank">签到排行</a><a href="/logout">退出</a></header>
<main><section style="flex:1"><h1>${title}</h1><div class="box">欢迎回来，今天也要加油。</div>${'<p>帖子列表 · 示例内容</p>'.repeat(3)}</section><aside>${body}</aside></main>
<footer style="padding:20px;color:#888">示例站点 · 仅供测试</footer>
<script>${script}</script></body></html>`;

// 通用：点击后调用 /api/sign，按返回结果更新页面
const signScript = (sel, how = 'replace') => `
const el = document.querySelector(${JSON.stringify(sel)});
if (el) el.addEventListener('click', (e) => { e.preventDefault(); fetch('/api/sign', { method: 'POST' }).then(r => r.json()).then(d => {
  ${how === 'replace' ? `const s = document.createElement('span'); s.className='done'; s.textContent = d.msg; el.replaceWith(s);` : ''}
  ${how === 'disable' ? `el.disabled = true; el.style.opacity = .5;` : ''}
  ${how === 'disable-text' ? `el.disabled = true; el.textContent = '已签到';` : ''}
  ${how === 'toast' ? `el.remove(); const t = document.createElement('div'); t.textContent = d.msg; t.style.cssText='position:fixed;top:20px;left:40%;background:#333;color:#fff;padding:10px'; document.body.append(t); setTimeout(() => t.remove(), 3000);` : ''}
  ${how === 'modal' ? `setTimeout(() => { const t = document.createElement('div'); t.className='modal'; t.textContent = d.msg; document.body.append(t); }, 1500);` : ''}
  ${how === 'alert' ? `alert(d.msg);` : ''}
}); });`;

const SITES = [];
const add = (host, kind, name, expect, opts = {}) => SITES.push({ host, kind, name, expect, ...opts });

// 1. 首页上直接有签到按钮
add('b01.test', 'button', '按钮签到', 'ok', { html: '<div class="box"><button id="qd">签到</button></div>', sel: '#qd', msg: '签到成功，获得 5 积分' });
add('b02.test', 'button', '链接每日签到', 'ok', { html: '<div class="box"><a href="javascript:;" class="qd">每日签到</a></div>', sel: '.qd', msg: '签到成功 +3 金币' });
add('b03.test', 'button', 'div 立即签到', 'ok', { html: '<div class="box"><div class="sign">立即签到</div></div>', sel: '.sign', msg: '签到成功' });
add('b04.test', 'button', '打卡', 'ok', { html: '<div class="box"><button>打卡</button></div>', sel: 'aside button', msg: '打卡成功，已连续打卡 3 天' });
add('b05.test', 'button', '签到领积分', 'ok', { html: '<div class="box"><span role="button" tabindex="0" class="r">签到领积分</span></div>', sel: '.r', msg: '+10 积分' });
add('b06.test', 'button', 'input 签 到', 'ok', { html: '<div class="box"><input type="button" id="b" value="签 到"></div>', sel: '#b', msg: '恭喜你签到成功' });
add('b07.test', 'button', '图标按钮变已签到', 'ok', { html: '<div class="box"><button id="x"><svg width="12" height="12"><circle cx="6" cy="6" r="5"/></svg> <span>签到</span></button></div>', sel: '#x', how: 'disable-text' });
add('b08.test', 'button', '有签到规则干扰', 'ok', { html: '<div class="box"><a href="/rules">签到说明</a> · <a href="/history">签到记录</a></div><div class="box"><button class="go">签到</button></div>', sel: '.go', msg: '签到成功，获得 2 经验' });
add('b09.test', 'button', 'English check-in', 'ok', { html: '<div class="box"><button class="btn">Daily Check-in</button></div>', sel: '.btn', msg: 'Checked in successfully! +10 points' });
add('b10.test', 'button', '提示条 3 秒消失', 'ok', { html: '<div class="box"><a class="btn" href="#">点击签到</a></div>', sel: 'aside .btn', how: 'toast', msg: '签到成功' });
add('b11.test', 'button', '只变灰', 'ok', { html: '<div class="box"><button id="g">签到</button></div>', sel: '#g', how: 'disable' });
add('b12.test', 'button', '服务器说失败', 'failed', { html: '<div class="box"><button id="f">签到</button></div>', sel: '#f', how: 'keep', msg: '签到失败，请稍后再试', fail: true });
add('b13.test', 'button', '签到有礼', 'ok', { html: '<div class="box"><a href="#" class="gift">签到有礼</a></div>', sel: '.gift', msg: '领取成功，获得 1 张优惠券' });
add('b14.test', 'button', '领取今日奖励', 'ok', { html: '<div class="box"><button id="claim">领取今日奖励</button></div>', sel: '#claim', msg: '已领取' });
add('b15.test', 'button', 'li onclick', 'ok', { html: '<ul class="box"><li>个人中心</li><li id="li" onclick="window.__go()">签到</li></ul>', sel: '#li', msg: '签到成功 连续签到 7 天', inline: true });
add('b16.test', 'button', '1.5 秒后弹层', 'ok', { html: '<div class="box"><button id="m">签到</button></div>', sel: '#m', how: 'modal', msg: '签到成功，+5 积分' });
add('b17.test', 'button', '只响应 mousedown', 'ok', { html: '<div class="box"><div class="sign" id="md">签到</div></div>', md: true, msg: '签到成功' });
add('b18.test', 'button', '开始签到', 'ok', { html: '<div class="box"><button id="s">开始签到</button></div>', sel: '#s', msg: '签到成功' });

// 2. 先进签到页再点
add('l01.test', 'link', '首页链接到签到页', 'ok', { link: '<a href="/sign">签到</a>', path: '/sign' });
add('l02.test', 'link', '新标签页打开签到页', 'ok', { link: '<a href="/checkin" target="_blank">每日签到</a>', path: '/checkin' });
add('l03.test', 'link', '插件签到页', 'ok', { link: '<a href="/plugin.php?id=dc_sign">打卡中心</a>', path: '/plugin.php', btn: '开始打卡' });

// 3. 论坛程序
add('v2a.test', 'v2ex', 'V2EX 风格（首页）', 'ok', { start: '/' });
add('v2b.test', 'v2ex', 'V2EX 风格（任务页）', 'ok', { start: '/mission/daily' });
add('n01.test', 'nexus', 'NexusPHP 有链接', 'ok', { link: true });
add('n02.test', 'nexus', 'NexusPHP 无链接', 'ok', { link: false });
add('d01.test', 'discuz', 'Discuz 签到链接', 'ok', { link: true });
add('d02.test', 'discuz', 'Discuz 无链接', 'ok', { link: false });
add('d03.test', 'kmisign', 'Discuz k_misign', 'ok', {});

// 4. 今天已经签过
add('a01.test', 'static', '已签文字', 'already', { html: '<div class="box"><span>今日已签到</span></div>' });
add('a02.test', 'static', '按钮变灰', 'already', { html: '<div class="box"><button disabled>签到</button></div>' });
add('a03.test', 'static', '明日再来', 'already', { html: '<div class="box"><span class="x">签到成功，明日再来</span></div>' });
add('a04.test', 'static', '按钮文字是已签', 'already', { html: '<div class="box"><button>已签到</button></div>' });

// 5. 登录
add('lg1.test', 'login', '要求登录（没有账号）', 'need-login', {});
add('lg2.test', 'login', '要求登录（保险箱有账号）', 'ok', {});
add('lg3.test', 'static', '提示先登录', 'need-login', { html: '<div class="box">您需要登录后才能签到 <a href="/login">登录</a> <a href="/reg">注册</a></div>' });

// 6. 人机验证
add('c01.test', 'challenge', 'Cloudflare 等待页', 'challenge', { title: 'Just a moment...', html: '<p>Checking your browser before accessing</p>' });
add('c02.test', 'challenge', 'Turnstile', 'challenge', { title: '登录', html: '<p>Verify you are human by completing the action below.</p><iframe src="https://challenges.cloudflare.com/x" height="80"></iframe>' });
add('c03.test', 'challenge', 'reCAPTCHA', 'challenge', { title: '签到', html: '<script src="https://www.google.com/recaptcha/api.js"></script><iframe src="https://www.google.com/recaptcha/api2/anchor" width="300" height="78"></iframe><button>签到</button>' });

// 7. 弹窗
add('dl1.test', 'button', 'alert 提示成功', 'ok', { html: '<div class="box"><button id="al">签到</button></div>', sel: '#al', how: 'alert', msg: '签到成功！获得 5 积分' });
add('dl2.test', 'confirm', 'confirm 确认后签到', 'ok', {});
add('dl3.test', 'button', 'alert 请先登录', 'need-login', { html: '<div class="box"><button id="al">签到</button></div>', sel: '#al', how: 'alert', msg: '请先登录', fail: true });

// 8. 交给 AI
add('ai1.test', 'button', 'AI：今日份惊喜', 'ok', { html: '<div class="box"><button id="sp">🎁 今日份惊喜</button></div>', sel: '#sp', msg: '惊喜已收下 +3 积分' });
add('ai2.test', 'button', 'AI：只有图标', 'ok', { html: '<div class="box"><button id="ic" aria-label="今日好运"><svg width="16" height="16"><rect width="16" height="16"/></svg></button></div>', sel: '#ic', msg: '好运 +1 经验' });
add('ai3.test', 'aimulti', 'AI：菜单里的每日任务', 'ok', {});
add('ai4.test', 'button', 'AI：English gift', 'ok', { html: '<div class="box"><button id="gift">Claim your daily gift</button></div>', sel: '#gift', msg: 'Gift claimed' });
add('ai5.test', 'static', 'AI：真的没有', 'not-found', { html: '<div class="box"><a href="/shop">商城</a> <a href="/help">帮助</a></div>' });

// 9. 其他
add('s01.test', 'late', '3 秒后才出现按钮', 'ok', {});
add('s02.test', 'button', '服务器慢 4 秒', 'ok', { html: '<div class="box"><button id="sl">签到</button></div>', sel: '#sl', msg: '签到成功', delay: 4000 });
add('spa.test', 'spa', '单页应用切到签到页', 'ok', {});
add('dead.test', 'dead', '网站打不开', 'error', { deadPort: true });

function json(res, obj, code = 200) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}
function send(res, body, code = 200, headers = {}) {
  res.writeHead(code, { 'content-type': 'text/html; charset=utf-8', ...headers });
  res.end(body);
}
const readBody = (req) => new Promise((r) => {
  let b = '';
  req.on('data', (c) => (b += c));
  req.on('end', () => r(b));
});

function signNow(s, site) {
  if (site.fail) return { ok: false, msg: site.msg || '签到失败' };
  if (s.signed) return { ok: true, msg: '今天已经签到过了' };
  s.signed = true;
  s.count++;
  return { ok: true, msg: site.msg || '签到成功' };
}

// ── 模拟 AI：只看「可点元素」，按几个关键词挑一个 ──
function fakeAi(body) {
  const user = body.messages?.find((m) => m.role === 'user')?.content || '';
  aiLog.push(user);
  const els = [...user.matchAll(/^\[(\d+)\]<([^>]*)>(.*)$/gm)].map((m) => ({ i: Number(m[1]), attrs: m[2], text: m[3] }));
  const done = [...user.matchAll(/点了「([^」]*)」/g)].map((m) => m[1]);
  const hints = (user.split('页面上和签到有关的文字：')[1] || '').split('\n\n')[0];
  if (/已完成|已领取|已签到|明天再来/.test(hints)) return { action: 'done', result: 'already', why: '页面写着已完成' };
  const words = ['惊喜', '好运', '领取', 'gift', '每日任务', '我的'];
  for (const w of words) {
    const e = els.find((x) => (x.text + ' ' + x.attrs).toLowerCase().includes(w.toLowerCase()) && !done.some((d) => d && (x.text.includes(d) || d.includes(x.text) && x.text)));
    if (e) return { action: 'click', index: e.i, why: '像是签到入口' };
  }
  return { action: 'fail', why: '页面上没有签到入口' };
}

const server = http.createServer(async (req, res) => {
  const host = (req.headers.host || '').split(':')[0];
  const url = new URL(req.url, 'http://' + host);
  // 管理接口
  if (host === 'admin.test' || host === '127.0.0.1') {
    if (url.pathname === '/reset') {
      for (const s of state.values()) s.signed = false;
      return json(res, { ok: true });
    }
    if (url.pathname === '/state') return json(res, { state: Object.fromEntries(state), sites: SITES.map(({ host, name, expect, kind }) => ({ host, name, expect, kind })), aiCalls: aiLog.length });
    if (url.pathname === '/ai') return json(res, aiLog);
    if (url.pathname === '/list') return send(res, SITES.map((s) => `${s.name} http://${s.host}:${s.deadPort ? PORT + 1 : PORT}${s.start || (s.kind === 'login' ? '/' : '/')}`).join('\n'), 200, { 'content-type': 'text/plain; charset=utf-8' });
    return json(res, { ok: true });
  }
  if (host === 'ai.test') {
    if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
      if (req.headers.authorization !== 'Bearer sk-test') return json(res, { error: 'bad key' }, 401);
      const body = JSON.parse((await readBody(req)) || '{}');
      const d = fakeAi(body);
      const content = aiLog.length % 2 ? '```json\n' + JSON.stringify(d) + '\n```' : JSON.stringify(d);
      return json(res, { choices: [{ message: { role: 'assistant', content } }] });
    }
    return json(res, { error: 'not found' }, 404);
  }
  const site = SITES.find((s) => s.host === host);
  if (!site) return send(res, 'no site', 404);
  const s = st(host);
  if (site.delay && url.pathname === '/') await new Promise((r) => setTimeout(r, site.delay));
  if (url.pathname === '/favicon.ico') return send(res, '', 204);
  if (req.method === 'POST' && url.pathname === '/api/sign') {
    if (site.kind === 'login' && !s.loggedIn) return json(res, { ok: false, msg: '请先登录' });
    return json(res, signNow(s, site));
  }

  switch (site.kind) {
    case 'button': {
      if (s.signed) return send(res, page(site.name, '<div class="box"><span>今日已签到</span></div>'));
      let script = site.md
        ? `document.querySelector('#md').addEventListener('mousedown', () => fetch('/api/sign',{method:'POST'}).then(r=>r.json()).then(d=>{document.querySelector('#md').outerHTML='<span>'+d.msg+'</span>'}));`
        : site.inline
          ? `window.__go = () => fetch('/api/sign',{method:'POST'}).then(r=>r.json()).then(d=>{document.querySelector('${site.sel}').outerHTML='<li>'+d.msg+'</li>'});`
          : signScript(site.sel, site.how || 'replace');
      if (site.how === 'keep') script = `document.querySelector('${site.sel}').addEventListener('click',()=>fetch('/api/sign',{method:'POST'}).then(r=>r.json()).then(d=>{const p=document.createElement('p');p.textContent=d.msg;document.querySelector('aside').append(p)}))`;
      return send(res, page(site.name, site.html, { script }));
    }
    case 'static':
      return send(res, page(site.name, site.html));
    case 'challenge':
      return send(res, `<!doctype html><html><head><meta charset="utf-8"><title>${site.title}</title></head><body>${site.html}</body></html>`);
    case 'link': {
      if (url.pathname === site.path) {
        if (s.signed) return send(res, page(site.name + ' · 签到', '<div class="box">今日已签到，明天再来</div>'));
        return send(res, page(site.name + ' · 签到', `<div class="box">已连续签到 3 天</div><div class="box"><button id="go">${site.btn || '立即签到'}</button></div>`, { script: signScript('#go') }));
      }
      return send(res, page(site.name, `<div class="box">${site.link}</div>`));
    }
    case 'v2ex': {
      if (url.pathname === '/mission/daily/redeem') {
        signNow(s, site);
        return send(res, '', 302, { location: '/mission/daily' });
      }
      if (url.pathname === '/mission/daily') {
        return send(res, page('日常任务', s.signed ? '<div class="box"><span class="gray">每日登录奖励已领取</span></div><div class="box">已连续登录 5 天</div>' : `<div class="box"><input type="button" class="super normal button" value="领取 ${20 + s.count} 铜币" onclick="location.href = '/mission/daily/redeem?once=12345';"></div>`));
      }
      return send(res, page('V2EX 风格', s.signed ? '<div class="box">今日奖励已领取</div>' : '<div class="box"><a href="/mission/daily">领取今日的登录奖励</a></div>'));
    }
    case 'nexus': {
      const foot = '<p style="font-size:11px">Powered by NexusPHP</p>';
      if (url.pathname === '/attendance.php') {
        if (s.signed) return send(res, page('签到', '<div class="box">您今天已经签到过了，请勿重复刷新。</div>' + foot));
        signNow(s, site);
        return send(res, page('签到', `<div class="box">签到成功 这是您的第 ${s.count} 次签到，已连续签到 ${s.count} 天，本次签到获得 100 个魔力值。</div>` + foot));
      }
      return send(res, page('NexusPHP 站点', (site.link ? '<div class="box"><a href="attendance.php" class="faqlink">[签到得魔力]</a></div>' : '<div class="box">魔力值: 1234</div>') + foot));
    }
    case 'discuz': {
      const head = '<meta name="generator" content="Discuz! X3.4">';
      if (url.pathname === '/plugin.php' && url.searchParams.get('id') === 'dsu_paulsign:sign') {
        if (req.method === 'POST') {
          await readBody(req);
          signNow(s, site);
          return send(res, page('签到', '<div class="box">恭喜你签到成功!获得随机奖励 金钱 3.</div>', { head }));
        }
        if (s.signed) return send(res, page('签到', '<div class="box">您今天已经签到过了或者签到时间还未开始</div>', { head }));
        return send(res, page('每日签到', `<form id="qiandao" name="qiandao" method="post" action="plugin.php?id=dsu_paulsign:sign&operation=qiandao&infloat=0"><ul class="qdsmile"><li id="kx">开心</li><li id="ng">难过</li></ul><input id="todaysay" name="todaysay"><input type="hidden" name="qdxq" value=""></form><div class="box"><a href="javascript:;" onclick="document.getElementById('qiandao').submit()">点我签到!</a></div>`, { head }));
      }
      const extra = site.link ? '<div class="box"><a href="plugin.php?id=dsu_paulsign:sign">签到</a></div>' : '<script src="source/plugin/dsu_paulsign/js/x.js"></script><div class="box">积分: 99</div>';
      return send(res, page('Discuz 论坛', extra, { head }));
    }
    case 'kmisign': {
      const head = '<meta name="generator" content="Discuz! X3.4">';
      if (url.pathname === '/plugin.php' && url.searchParams.get('id') === 'k_misign:sign') {
        if (s.signed) return send(res, page('签到', '<div class="box"><span class="btnvisted">已签到</span></div>', { head }));
        return send(res, page('签到', '<div class="box">连续签到 4 天</div><div class="box"><a id="JD_sign" href="javascript:;">签到</a></div>', { head, script: signScript('#JD_sign') }));
      }
      return send(res, page('Discuz 论坛', '<script>var k_misign = 1;</script><div class="box">积分: 99</div>', { head }));
    }
    case 'login': {
      if (url.pathname === '/login' && req.method === 'POST') {
        const b = new URLSearchParams(await readBody(req));
        if (b.get('username') === 'tester' && b.get('password') === 'pw-123456') {
          s.loggedIn = true;
          return send(res, '', 302, { location: '/', 'set-cookie': 'sid=1; Path=/' });
        }
        return send(res, page('登录', '<div class="box">用户名或密码错误</div>'));
      }
      if (!s.loggedIn) return send(res, page('登录', '<div class="box">请先登录</div><form class="box" method="post" action="/login"><input name="username" placeholder="用户名"><input type="password" name="password" placeholder="密码"><button>登录</button></form>'));
      if (s.signed) return send(res, page('已登录', '<div class="box">今日已签到</div>'));
      return send(res, page('已登录', '<div class="box"><button id="q">签到</button></div>', { script: signScript('#q') }));
    }
    case 'confirm': {
      if (s.signed) return send(res, page(site.name, '<div class="box">今日已签到</div>'));
      return send(res, page(site.name, '<div class="box"><button id="c">签到</button></div>', { script: `document.querySelector('#c').onclick=()=>{ if(confirm('确定要签到吗？')) fetch('/api/sign',{method:'POST'}).then(r=>r.json()).then(d=>{document.querySelector('#c').outerHTML='<b>'+d.msg+'</b>'}) }` }));
    }
    case 'aimulti': {
      if (url.pathname === '/tasks') {
        if (s.signed) return send(res, page('任务中心', '<div class="box">每日登录 · 已完成</div>'));
        return send(res, page('任务中心', '<div class="box">每日登录 <button id="lq">领取</button></div><div class="box">发一个帖子 <button disabled>未完成</button></div>', { script: signScript('#lq') }));
      }
      return send(res, page('社区', '<div class="box" style="position:relative"><div id="me" style="cursor:pointer">我的</div><div class="menu" id="menu"><a href="/profile">个人资料</a><br><a href="/tasks">每日任务</a><br><a href="/logout">退出登录</a></div></div>', { script: `document.querySelector('#me').onclick=()=>document.querySelector('#menu').classList.toggle('open')` }));
    }
    case 'late': {
      if (s.signed) return send(res, page(site.name, '<div class="box">今日已签到</div>'));
      return send(res, page(site.name, '<div class="box" id="slot">加载中…</div>', { script: `setTimeout(()=>{document.querySelector('#slot').innerHTML='<button id="lt">签到</button>';document.querySelector('#lt').onclick=()=>fetch('/api/sign',{method:'POST'}).then(r=>r.json()).then(d=>{document.querySelector('#slot').textContent=d.msg})},3000)` }));
    }
    case 'spa': {
      return send(res, page(site.name, '<div class="box"><a href="#/home">首页</a> <a href="#/sign">每日签到</a></div><div class="box" id="view"></div>', { script: `
const signed = ${s.signed};
function route(){ const v=document.querySelector('#view'); if(location.hash==='#/sign'){ v.innerHTML = signed ? '今日已签到' : '<p>已连续签到 2 天</p><button id="sg">立即签到</button>'; const b=document.querySelector('#sg'); if(b) b.onclick=()=>fetch('/api/sign',{method:'POST'}).then(r=>r.json()).then(d=>{v.textContent=d.msg}); } else v.textContent='动态'; }
addEventListener('hashchange', route); route();` }));
    }
    default:
      return send(res, 'unknown', 500);
  }
});

/** 启动模拟网站；port+1 故意不监听，用来模拟「网站打不开」。 */
export function startMockSites({ port = PORT } = {}) {
  PORT = port;
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve({ port, close: () => new Promise((r) => server.close(r)) }));
  });
}

export { SITES };

if (import.meta.url === `file://${process.argv[1]}`) {
  startMockSites().then(({ port }) => console.log('模拟网站已启动：', port, SITES.length, '个'));
}
