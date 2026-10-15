// 注入到网页里执行的函数。每个函数必须自成一体（不能引用外部变量），由 chrome.scripting.executeScript 调用。

/** 填入账号。submit=true 时顺便点登录按钮。 */
export function fillLoginInPage(username, password, submit) {
  const visible = (el) => {
    if (!el || el.disabled || el.readOnly) return false;
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none' && Number(st.opacity) !== 0;
  };
  const setValue = (el, v) => {
    el.focus();
    const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
    desc.set.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const pw = [...document.querySelectorAll('input[type=password]')].find(visible) || null;
  const scope = (pw && pw.form) || document;
  const candidates = [...scope.querySelectorAll('input:not([type]),input[type=text],input[type=email],input[type=tel]')].filter(visible);
  let user = null;
  if (pw) {
    for (const c of candidates) if (c.compareDocumentPosition(pw) & Node.DOCUMENT_POSITION_FOLLOWING) user = c;
  } else {
    user = candidates.find((c) => /user|email|login|account|mail|phone|name/i.test([c.name, c.id, c.autocomplete, c.placeholder, c.getAttribute('aria-label')].join(' '))) || candidates[0] || null;
  }
  if (user && username) setValue(user, username);
  if (pw && password) setValue(pw, password);
  let submitted = false;
  if (submit && (pw || user)) {
    const field = pw || user;
    const root = field.form || document;
    const buttons = [...root.querySelectorAll('button,input[type=submit],input[type=button],[role=button]')].filter(visible);
    const btn =
      buttons.find((b) => b.type === 'submit') ||
      buttons.find((b) => /登录|登入|登陆|sign\s*in|log\s*in|continue|next|下一步|确定|提交/i.test((b.innerText || b.value || '').trim()));
    if (btn) {
      btn.click();
      submitted = true;
    } else if (field.form) {
      if (field.form.requestSubmit) field.form.requestSubmit();
      else field.form.submit();
      submitted = true;
    }
  }
  return { user: !!(user && username), password: !!(pw && password), hasPasswordField: !!pw, submitted };
}

/** 页面上是否有可见的密码框（说明需要登录）。 */
export function hasLoginFormInPage() {
  return [...document.querySelectorAll('input[type=password]')].some((el) => {
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none';
  });
}

/** 是否被 Cloudflare / 验证码拦住了。 */
export function detectChallengeInPage() {
  const title = (document.title || '').toLowerCase();
  const body = (document.body ? document.body.innerText : '').slice(0, 4000).toLowerCase();
  const html = document.documentElement.innerHTML.slice(0, 200000);
  if (/just a moment|attention required|checking your browser|请稍候/.test(title)) return { challenged: true, reason: 'Cloudflare 验证' };
  if (/checking your browser before accessing|needs to review the security of your connection|enable javascript and cookies to continue|performing security verification|verify you are human/.test(body)) {
    return { challenged: true, reason: '人机验证' };
  }
  if (location.pathname.includes('/cdn-cgi/challenge') || /challenges\.cloudflare\.com/.test(html)) return { challenged: true, reason: 'Cloudflare 验证' };
  if (/www\.google\.com\/recaptcha|recaptcha\/api|hcaptcha\.com/.test(html)) {
    const visibleCaptcha = [...document.querySelectorAll('iframe')].some((f) => /recaptcha|hcaptcha|turnstile/.test(f.src) && f.getBoundingClientRect().height > 30);
    if (visibleCaptcha) return { challenged: true, reason: '验证码' };
  }
  return { challenged: false };
}

/** 找到签到按钮并点一下。target = { selector, text } */
export function clickTargetInPage(target) {
  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const visible = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none';
  };
  let el = null;
  let how = '';
  try {
    if (target.selector) el = document.querySelector(target.selector);
  } catch {}
  if (el && !visible(el)) el = null;
  if (el && target.text) {
    // 选择器找到了，但文字完全不一样，可能是页面改版后指向了别的东西。
    const t = norm(el.innerText || el.value || el.getAttribute('aria-label'));
    if (t && !t.includes(norm(target.text)) && !norm(target.text).includes(t)) el = null;
  }
  if (el) how = 'selector';
  if (!el && target.text) {
    const want = norm(target.text);
    const text = (c) => norm(c.innerText || c.value || c.getAttribute('aria-label'));
    // 先找真正可点的元素；找不到再看普通元素，并且取最里层的那个。
    const clickable = [...document.querySelectorAll('button,a,input[type=button],input[type=submit],[role=button],[onclick]')].filter(visible);
    // 包含关系只在不是「签到规则 / 签到记录 / 退出」这类入口时才算
    const NEG = /(签到|打卡)(记录|规则|说明|排行|排名|榜|日历|历史|统计|设置|奖励说明|提醒)|补签|注册|退出|注销|sign\s*(up|out)|log\s*out|register|删除|购买|充值|支付/i;
    el = clickable.find((c) => text(c) === want) || clickable.find((c) => text(c).includes(want) && text(c).length < want.length + 12 && (NEG.test(want) || !NEG.test(text(c)))) || null;
    if (!el) {
      const plain = [...document.querySelectorAll('span,div,li,label,p')].filter(visible).filter((c) => text(c) === want);
      el = plain.find((c) => ![...c.children].some((k) => text(k) === want)) || null;
    }
    if (el) how = 'text';
  }
  if (!el) return { found: false };
  if (el.disabled) return { found: true, disabled: true, text: norm(el.innerText || el.value) };
  el.scrollIntoView({ block: 'center', inline: 'center' });
  const before = norm(el.innerText || el.value);
  el.click();
  return { found: true, how, before };
}

/** 检查签到是否成功。rule = { type: 'text'|'gone'|'element'|'url', value, selector }，target 用于 gone。 */
export function checkSuccessInPage(rule, target, beforeText) {
  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const visible = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none';
  };
  const q = (sel) => {
    try {
      return sel ? document.querySelector(sel) : null;
    } catch {
      return null;
    }
  };
  switch (rule && rule.type) {
    case 'text':
      return !!(document.body && rule.value && norm(document.body.innerText).includes(norm(rule.value)));
    case 'element':
      return visible(q(rule.selector));
    case 'url':
      return !!rule.value && location.href.includes(rule.value);
    case 'gone':
    default: {
      const el = q(target && target.selector);
      if (!el || !visible(el)) return true;
      if (el.disabled || el.getAttribute('aria-disabled') === 'true') return true;
      const now = norm(el.innerText || el.value);
      return !!beforeText && now !== beforeText;
    }
  }
}

/** 技能包里的「检查文字」「等待元素」步骤。 */
export function pageHasTextInPage(text) {
  return !!(document.body && String(document.body.innerText).replace(/\s+/g, ' ').includes(String(text).replace(/\s+/g, ' ').trim()));
}

export function pageHasElementInPage(selector) {
  try {
    const el = document.querySelector(selector);
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  } catch {
    return false;
  }
}

/** 侧栏读取网页上选中的文字。 */
export function readSelectionInPage() {
  const sel = String(window.getSelection ? window.getSelection() : '').trim();
  return { text: sel.slice(0, 5000), url: location.href, title: document.title };
}

