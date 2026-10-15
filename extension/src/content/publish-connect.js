(() => {
  const ID = '__mibox_publish_connect__';
  try { window.__miboxPublishConnectCleanup?.(); } catch {}
  const oldHost = document.getElementById(ID);
  if (oldHost) oldHost.remove();

  const opts = window.__miboxPublishConnect;
  try { delete window.__miboxPublishConnect; } catch {}
  if (!opts || !['github', 'cloudflare'].includes(opts.provider) || typeof opts.nonce !== 'string' ||
      !Number.isFinite(opts.expiresAt) || opts.expiresAt <= Date.now() || window.top !== window) return;
  const provider = opts.provider;
  const allowed = () => provider === 'github'
    ? location.origin === 'https://github.com' && /^\/settings\/personal-access-tokens(?:\/|$)/.test(location.pathname)
    : location.origin === 'https://dash.cloudflare.com' && /^\/profile\/api-tokens(?:\/|$)/.test(location.pathname);
  if (!allowed()) return;
  const nonce = opts.nonce;
  const expiresAt = opts.expiresAt;
  const valid = provider === 'github'
    ? (s) => /^(?:github_pat_[A-Za-z0-9_]{20,240}|ghp_[A-Za-z0-9]{36})$/.test(s)
    : (s) => /^[A-Za-z0-9_-]{40}$/.test(s);
  const host = document.createElement('div');
  host.id = ID;
  host.style.cssText = 'all:initial;position:fixed;right:16px;bottom:16px;z-index:2147483647;display:block;';
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = `<style>
    .bar{width:min(360px,calc(100vw - 32px));max-height:calc(100vh - 32px);box-sizing:border-box;overflow:auto;padding:12px 14px;background:#17201d;color:#fff;border:1px solid #53645d;border-radius:12px;box-shadow:0 8px 28px #0004;font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
    .title{font-weight:650;margin-bottom:5px}.msg{color:#d7e0dc;overflow-wrap:anywhere}.actions{display:flex;gap:8px;margin-top:9px;flex-wrap:wrap}
    .guide{margin:9px 0;padding:9px 10px;border:1px solid #40534b;border-radius:9px;background:#202a25}.guide[hidden]{display:none}.guide ol{margin:0;padding-left:21px}.guide li+li{margin-top:6px}.guide strong{color:#fff}.guide .path{color:#b8d5c8}.guide details{margin-top:8px;color:#c5d0ca}.guide summary{cursor:pointer;color:#d7e0dc}.guide p{margin:5px 0 0;color:#b9c5be}
    button{font:inherit;color:#fff;background:#245c4d;border:1px solid #6b8c7e;border-radius:7px;padding:5px 9px;cursor:pointer}button.secondary{background:transparent}
  </style><section class="bar" role="status" aria-live="polite"><div class="title">谜盒 · 安全保存令牌</div><div class="msg"></div><div class="guide" ${provider === 'cloudflare' ? '' : 'hidden'}><ol><li>在 <strong>Permissions</strong> 中添加第 1 行：<span class="path">Account → Cloudflare Pages → Edit</span>。列表按字母排序；如果当前看到 A 开头的 Access 项，请继续向下找到 C 开头的 Cloudflare Pages。</li><li>点 <strong>Add more</strong> 添加第 2 行：<span class="path">Account → Account Settings → Read</span>。</li><li>在 <strong>Account Resources</strong> 选择 <span class="path">Include → Specific account</span>，再选你自己的 Cloudflare 账号。</li><li>点 <strong>Continue to summary</strong>，再点 <strong>Create token</strong>。完成后令牌会自动加密保存到谜盒。</li></ol><details><summary>可选设置</summary><p>IP 过滤可以留空；令牌有效期按需设置。</p></details></div><div class="actions"><button class="retry" type="button">重新扫描</button><button class="save" type="button" hidden>保存所选令牌</button><button class="secondary close" type="button">关闭</button></div></section>`;
  const msg = root.querySelector('.msg');
  const retry = root.querySelector('.retry');
  const save = root.querySelector('.save');
  let observer;
  let stopped = false;
  let busy = false;
  let timer;
  let scanTimer;
  const attempted = new Set();
  const title = provider === 'github'
    ? '权限已预填。要新建网站，请选择 All repositories；只更新已有网站可选目标仓库，然后点击 Generate token。'
    : '按右侧步骤创建 Cloudflare 自定义令牌；创建完成后会自动加密保存到谜盒。';

  function cleanup() {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    clearTimeout(scanTimer);
    observer?.disconnect();
    host.remove();
    window.removeEventListener('beforeunload', cleanup);
    if (window.__miboxPublishConnectCleanup === cleanup) delete window.__miboxPublishConnectCleanup;
  }
  window.__miboxPublishConnectCleanup = cleanup;
  function failText(code) {
    if (code === 'FORBIDDEN') return '后台拒绝了此连接，请返回谜盒重新发起。';
    if (code === 'FLOW_EXPIRED') return '连接已过期，请返回谜盒重新发起。';
    if (Date.now() >= expiresAt) return '连接已过期，请返回谜盒重新发起。';
    return '暂时无法验证或保存，请检查谜盒状态后点“重新扫描”重试。';
  }
  function candidates() {
    const found = new Set();
    const visible = (el) => el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden' && getComputedStyle(el).display !== 'none';
    const add = (value) => {
      const s = String(value || '').trim();
      if (valid(s)) found.add(s);
    };
    for (const el of document.querySelectorAll('input[readonly],textarea[readonly]')) {
      if (el.type === 'password' || el.type === 'hidden' || !el.getClientRects().length) continue;
      const style = getComputedStyle(el);
      if (style.visibility === 'hidden' || style.display === 'none') continue;
      add(el.value);
    }
    for (const el of document.querySelectorAll('clipboard-copy[value],[data-clipboard-text]')) if (visible(el)) add(el.getAttribute('value') || el.getAttribute('data-clipboard-text'));
    for (const el of document.querySelectorAll('code,pre')) {
      if (!visible(el)) continue;
      const text = el.textContent || '';
      if (provider === 'cloudflare' && /curl\b/i.test(text) && /api\.cloudflare\.com\/client\/v4\/user\/tokens\/verify/i.test(text)) {
        const match = text.match(/Authorization\s*:\s*Bearer\s+([A-Za-z0-9_-]{40})(?![A-Za-z0-9_-])/i);
        if (match) add(match[1]);
      }
      add(text);
    }
    return [...found];
  }
  function send(token) {
    if (!allowed()) { cleanup(); return; }
    if (stopped || busy || Date.now() >= expiresAt || !valid(token)) return;
    busy = true;
    save.hidden = true;
    msg.textContent = '正在请求后台验证并安全保存…';
    chrome.runtime.sendMessage({ sq: 1, type: 'publish.connect.capture', payload: { nonce, token } }).then((res) => {
      if (stopped) return;
      if (res?.ok === true && res.data?.saved === true) {
        msg.textContent = '已保存，将返回谜盒。';
        observer?.disconnect();
        retry.hidden = true;
        save.hidden = true;
        setTimeout(cleanup, 1800);
        return;
      }
      if (res?.code === 'FORBIDDEN' || res?.code === 'FLOW_EXPIRED') { msg.textContent = failText(res.code); cleanup(); return; }
      msg.textContent = failText(res?.code);
      retry.hidden = false;
    }).catch(() => { if (!stopped) { msg.textContent = failText(); retry.hidden = false; } })
      .finally(() => { busy = false; });
  }
  function scan(manual = false) {
    if (stopped || Date.now() >= expiresAt || !allowed()) { cleanup(); return; }
    const found = candidates();
    if (found.length === 1) {
      const token = found[0];
      if (!attempted.has(token)) { attempted.add(token); send(token); }
      else if (manual) { attempted.delete(token); send(token); }
      return;
    }
    if (found.length > 1) {
      msg.textContent = '检测到多个令牌。请在官网选择令牌文本，再点“保存所选令牌”；不会自动发送。';
      save.hidden = false;
    } else {
      msg.textContent = title;
      save.hidden = true;
      if (manual) msg.textContent += ' 当前未找到符合格式的令牌。';
    }
  }
  retry.addEventListener('click', () => scan(true));
  save.addEventListener('click', () => {
    const selected = String(window.getSelection()?.toString() || '').trim();
    if (!valid(selected)) { msg.textContent = '所选文本不符合此平台令牌格式，请只选择完整令牌。'; return; }
    attempted.delete(selected);
    send(selected);
  });
  root.querySelector('.close').addEventListener('click', cleanup);
  document.documentElement.appendChild(host);
  msg.textContent = title;
  observer = new MutationObserver(() => {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(() => scan(), 250);
  });
  observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['value', 'readonly', 'data-clipboard-text'] });
  timer = setTimeout(cleanup, Math.max(0, expiresAt - Date.now()));
  window.addEventListener('beforeunload', cleanup, { once: true });
  scan();
})();
