// 保险箱页：设置主密码、解锁、浏览和编辑条目。

import { html, morph, bind, scheduler, debounce } from '../../kit/dom.js';
import { icon } from '../../kit/icons.js';
import { tile, toast, toastError, modal, confirmBox, promptBox, copyText, downloadText } from '../../kit/ui.js';
import { call, onChange } from '../../../shared/client.js';
import { formatWhen, makeMatcher, domainOf, coerceUrl, originOf } from '../../../shared/util.js';

const KIND_NAME = { login: '网站登录', key: '密钥和令牌', note: '私密笔记' };

export function passwordScore(pw) {
  const s = String(pw || '');
  const n = [...s].length;
  if (!n) return { pct: 0, text: '', color: 'var(--line)' };
  let classes = 0;
  if (/[a-z]/.test(s)) classes++;
  if (/[A-Z]/.test(s)) classes++;
  if (/\d/.test(s)) classes++;
  if (/[^A-Za-z0-9]/.test(s)) classes++;
  if (/[㐀-鿿]/.test(s)) classes++;
  if (n < 12) return { pct: Math.min(30, n * 2.5), text: `还差 ${12 - n} 个字符`, color: 'var(--danger)' };
  const score = n + classes * 3;
  if (score < 20) return { pct: 50, text: '可以用，再长一点更好', color: 'var(--warn)' };
  if (score < 28) return { pct: 75, text: '不错', color: 'var(--ok)' };
  return { pct: 100, text: '很强', color: 'var(--ok)' };
}

export function generatePassword(len = 20) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*-_=+?';
  const out = [];
  const buf = new Uint32Array(len);
  crypto.getRandomValues(buf);
  for (const v of buf) out.push(chars[v % chars.length]);
  return out.join('');
}

export default {
  title: '保险箱',
  mount(root, ctx) {
    const state = {
      status: null,
      items: [],
      kind: 'all',
      q: '',
      currentId: ctx.route.query.get('id') || null,
      secrets: new Map(),
      shown: new Set(),
      busy: false,
      err: '',
      pw: '',
      pw2: '',
      recoveryMode: false,
      recoveryKey: '',
      creating: null, // { recoveryKey }
      savedKey: false,
    };
    const render = scheduler(draw);
    let tick = null;

    async function load() {
      const [status, items] = await Promise.all([call('vault.status'), call('vault.list')]);
      if (!status.unlocked) {
        state.secrets.clear();
        state.shown.clear();
      }
      state.status = status;
      state.items = items;
      if (status.unlocked && (!state.currentId || !items.some((i) => i.id === state.currentId))) state.currentId = items[0]?.id || null;
      render();
      if (status.unlocked && state.currentId) ensureSecret(state.currentId);
    }

    async function ensureSecret(id) {
      if (state.secrets.has(id)) return;
      try {
        const full = await call('vault.reveal', { id });
        state.secrets.set(id, full.secret);
        render();
      } catch (e) {
        if (e.code === 'LOCKED') load();
        else state.secrets.set(id, { __error: e.message });
        render();
      }
    }

    function remaining() {
      const s = state.status;
      if (!s?.unlocked || !s.expiresAt) return '';
      const ms = Math.max(0, s.expiresAt - Date.now());
      const m = Math.floor(ms / 60000);
      const sec = Math.floor((ms % 60000) / 1000);
      return `${m}:${String(sec).padStart(2, '0')} 后自动锁定`;
    }

    // ───────── 页面 ─────────

    function createView() {
      if (state.creating) {
        return html`<div class="vault-lock card">
          <div class="big-icon">${icon('key', 26)}</div>
          <h1 style="font-size:22px">保存恢复密钥</h1>
          <p class="page-sub">忘记主密码时，只有它能打开保险箱。它只显示这一次，请抄下来、打印，或者存进另一个密码管理器。</p>
          <div class="recovery-box" id="recovery-key">${state.creating.recoveryKey}</div>
          <div class="row wrap"><button type="button" class="btn sm" data-click="copyKey">${icon('copy', 14)}复制</button>
            <button type="button" class="btn sm" data-click="downloadKey">${icon('download', 14)}下载成文本文件</button></div>
          <label class="check"><input type="checkbox" data-change="savedKey" ${state.savedKey ? 'checked' : ''}>我已经把恢复密钥存到安全的地方</label>
          <div class="row"><button type="button" class="btn pri" data-click="commit" ${state.savedKey && !state.busy ? '' : 'disabled'}>完成，打开保险箱</button>
            <button type="button" class="btn ghost" data-click="cancelCreate">取消</button></div>
        </div>`;
      }
      const sc = passwordScore(state.pw);
      const signedIn = ctx.store.sync?.signedIn;
      return html`<form class="vault-lock card" data-submit="prepare" novalidate>
        <div class="big-icon">${icon('shield', 26)}</div>
        <h1 style="font-size:22px">设置保险箱</h1>
        <p class="page-sub">放网站密码、API 密钥和私密笔记。内容先在这台电脑上用主密码加密，Google 和插件作者都打不开。</p>
        ${signedIn ? html`<div class="notice">${icon('info', 16)}<span>如果你在别的电脑上已经设置过保险箱，不用重新设置：同步完成后，用原来的主密码解锁即可。<button type="button" class="link-btn" data-click="syncNow">立即同步</button></span></div>` : ''}
        <div class="field"><label for="v-pw">主密码</label>
          <input id="v-pw" class="input" type="password" value="${state.pw}" data-input="pw" placeholder="至少 12 个字符，可以是一句话" autocomplete="new-password" autofocus>
          <div class="strength" aria-hidden="true"><span style="width:${sc.pct}%;background:${sc.color}"></span></div>
          <span class="hint">${sc.text || '主密码只在这台电脑上用，不会上传。忘记后只能用恢复密钥找回。'}</span></div>
        <div class="field"><label for="v-pw2">再输入一次</label>
          <input id="v-pw2" class="input" type="password" value="${state.pw2}" data-input="pw2" autocomplete="new-password"></div>
        ${state.err ? html`<p class="error-text" role="alert">${state.err}</p>` : ''}
        <button type="submit" class="btn pri lg" ${state.busy ? 'disabled' : ''}>${state.busy ? html`<span class="spinner"></span>正在生成密钥…` : '创建保险箱'}</button>
      </form>`;
    }

    function lockedView() {
      const s = state.status;
      if (state.recoveryMode) {
        const sc = passwordScore(state.pw);
        return html`<form class="vault-lock card" data-submit="recover" novalidate>
          <div class="big-icon">${icon('key', 26)}</div>
          <h1 style="font-size:22px">用恢复密钥解锁</h1>
          <p class="page-sub">输入创建保险箱时保存的恢复密钥，再设一个新的主密码。原来的恢复密钥继续有效。</p>
          <div class="field"><label for="v-rk">恢复密钥</label>
            <textarea id="v-rk" class="textarea mono" rows="2" data-input="recoveryKey" placeholder="SQ-RECOVERY-2.…" autofocus>${state.recoveryKey}</textarea></div>
          <div class="field"><label for="v-pw">新的主密码</label>
            <input id="v-pw" class="input" type="password" value="${state.pw}" data-input="pw" autocomplete="new-password" placeholder="至少 12 个字符">
            <div class="strength" aria-hidden="true"><span style="width:${sc.pct}%;background:${sc.color}"></span></div>
            <span class="hint">${sc.text}</span></div>
          <div class="field"><label for="v-pw2">再输入一次</label><input id="v-pw2" class="input" type="password" value="${state.pw2}" data-input="pw2" autocomplete="new-password"></div>
          ${state.err ? html`<p class="error-text" role="alert">${state.err}</p>` : ''}
          <div class="row"><button type="submit" class="btn pri" ${state.busy ? 'disabled' : ''}>${state.busy ? html`<span class="spinner"></span>正在解锁…` : '解锁并设置新密码'}</button>
            <button type="button" class="btn ghost" data-click="toggleRecovery">用主密码解锁</button></div>
        </form>`;
      }
      return html`<form class="vault-lock card" data-submit="unlock" novalidate>
        <div class="big-icon">${icon('lock', 26)}</div>
        <h1 style="font-size:22px">保险箱已锁定</h1>
        <p class="page-sub">网站密码、API 密钥和私密笔记都在这里，先在这台电脑上用主密码加密，再同步到 Google。</p>
        <div class="field"><label for="v-pw">主密码</label>
          <input id="v-pw" class="input ${state.err ? 'invalid' : ''}" type="password" value="${state.pw}" data-input="pw" placeholder="输入主密码" autocomplete="current-password" autofocus></div>
        ${state.err ? html`<p class="error-text" role="alert">${state.err}</p>` : ''}
        <button type="submit" class="btn pri lg" ${state.busy ? 'disabled' : ''}>${state.busy ? html`<span class="spinner"></span>正在解锁…` : '解锁'}</button>
        <div class="row small"><button type="button" class="link-btn" data-click="toggleRecovery">忘记主密码？用恢复密钥解锁</button>
          <span class="grow"></span><span class="muted">${s.autoLockMinutes ? `${s.autoLockMinutes} 分钟无操作自动锁定` : '关闭浏览器时锁定'}</span></div>
        <p class="small muted" style="padding-top:14px;border-top:1px solid var(--line-soft);line-height:1.7">登录 Google 不会解开保险箱。主密码不会离开这台电脑，忘记后只能用创建时保存的恢复密钥找回。</p>
      </form>`;
    }

    function fieldsOf(item, secret) {
      if (!secret) return [];
      if (item.kind === 'login') {
        const f = [];
        if (item.site) f.push({ label: '网站', value: item.site, secret: false });
        f.push({ label: '用户名', value: secret.username || '', secret: false });
        f.push({ label: '密码', value: secret.password || '', secret: true });
        if (secret.url) f.push({ label: '登录网址', value: secret.url, secret: false, link: true });
        if (secret.note) f.push({ label: '备注', value: secret.note, secret: false });
        return f;
      }
      if (item.kind === 'key') {
        const f = [{ label: '密钥', value: secret.secret || '', secret: true }];
        if (secret.ai?.baseUrl) f.push({ label: '接口地址', value: secret.ai.baseUrl, secret: false });
        if (secret.ai?.model) f.push({ label: '模型', value: secret.ai.model, secret: false });
        for (const x of secret.fields || []) f.push({ label: x.label, value: x.value, secret: false });
        return f;
      }
      return [{ label: '内容', value: secret.content || '', secret: true }];
    }

    function unlockedView() {
      const s = state.status;
      const match = makeMatcher(state.q);
      const list = state.items.filter((i) => (state.kind === 'all' || i.kind === state.kind) && match(i.name, i.site));
      const cur = state.items.find((i) => i.id === state.currentId) || null;
      const secret = cur ? state.secrets.get(cur.id) : null;
      const counts = { all: state.items.length, login: 0, key: 0, note: 0 };
      for (const i of state.items) counts[i.kind]++;
      const aiId = ctx.store.settings?.ai?.entryId;
      return html`<div class="vault ${cur ? 'has-current' : ''}">
        <section class="vault-side" aria-label="保险箱条目">
          <div class="vault-side-head">
            <div class="row"><h1 style="font-size:22px;font-weight:700" class="grow">保险箱</h1>
              <button type="button" class="btn sm" data-click="lock">${icon('lock', 14)}立即锁定</button>
              <button type="button" class="btn pri sm" data-click="create">${icon('plus', 14)}新建</button></div>
            <span class="small muted row" style="gap:6px">${icon('clock', 13)}<span id="vault-left">${remaining() || '关闭浏览器时锁定'}</span></span>
            <div class="kind-tabs" role="group" aria-label="类型">
              ${['all', 'login', 'key', 'note'].map((k) => html`<button type="button" class="chip" aria-pressed="${state.kind === k ? 'true' : 'false'}" data-click="kind" data-k="${k}">${k === 'all' ? '全部' : KIND_NAME[k]} ${counts[k]}</button>`)}
            </div>
            <label class="search-box">${icon('search', 15)}<span class="sr">搜索保险箱</span><input type="search" value="${state.q}" data-input="search" placeholder="搜索名称或网站" autocomplete="off"></label>
          </div>
          <div class="vault-items">
            ${list.map(
              (i) => html`<button type="button" class="vault-item" data-key="${i.id}" data-click="pick" data-id="${i.id}" aria-current="${i.id === state.currentId ? 'true' : 'false'}">
                ${tile(i.name, i.site ? 'https://' + i.site : '', 32, false)}
                <span class="grow"><span class="ellipsis" style="display:block;font-weight:600">${i.name}</span>
                <span class="ellipsis small muted" style="display:block">${i.kind === 'login' ? i.site || '网站登录' : KIND_NAME[i.kind]}</span></span>
              </button>`,
            )}
            ${!list.length ? html`<p class="muted small" style="padding:16px 12px;line-height:1.7">${state.items.length ? '没有匹配的条目。' : '保险箱还是空的。点「新建」放第一条进来。'}</p>` : ''}
          </div>
        </section>
        <section class="vault-detail" aria-label="详情">
          ${s.conflict ? conflictNotice(s.conflict) : ''}
          ${cur
            ? html`<div class="row" style="gap:14px;align-items:flex-start">
                <button type="button" class="icon-btn mobile-back" data-click="back" aria-label="返回列表">${icon('arrowLeft', 18)}</button>
                ${tile(cur.name, cur.site ? 'https://' + cur.site : '', 48, false)}
                <div class="grow"><h2 style="font-size:22px;font-weight:700">${cur.name}</h2>
                  <span class="small muted">${KIND_NAME[cur.kind]}，更新于 ${formatWhen(cur.updatedAt)}</span></div>
                <button type="button" class="btn sm" data-click="edit" ${secret && !secret.__error ? '' : 'disabled'}>${icon('edit', 14)}编辑</button>
                <button type="button" class="btn sm danger" data-click="remove">${icon('trash', 14)}删除</button>
              </div>
              ${secret?.__error
                ? html`<div class="notice danger">${icon('alert', 16)}<span>${secret.__error}</span></div>`
                : !secret
                  ? html`<div class="row muted"><span class="spinner"></span>正在解密…</div>`
                  : html`<div class="vault-fields">
                      ${fieldsOf(cur, secret).map((f, idx) => {
                        const shown = !f.secret || state.shown.has(cur.id + ':' + idx);
                        return html`<div class="vault-field" data-key="f${idx}">
                          <span class="label">${f.label}</span>
                          <span class="value ${f.secret ? 'secret' : ''}">${f.value ? (shown ? (f.link ? html`<a href="${f.value}" target="_blank" rel="noopener">${f.value}</a>` : f.value) : '••••••••••••') : html`<span class="faint">（空）</span>`}</span>
                          <span class="row" style="gap:4px">
                            ${f.secret && f.value ? html`<button type="button" class="icon-btn sm" data-click="reveal" data-i="${idx}" aria-label="${shown ? '隐藏' : '显示'}${f.label}">${icon(shown ? 'eyeOff' : 'eye', 15)}</button>` : ''}
                            ${f.value ? html`<button type="button" class="btn sm" data-click="copy" data-i="${idx}">${icon('copy', 13)}复制</button>` : ''}
                          </span></div>`;
                      })}
                    </div>`}
              ${cur.kind === 'login'
                ? html`<div class="notice">${icon('info', 16)}<div class="col" style="gap:8px">
                    <span>${cur.site ? html`在 <b>${cur.site}</b> 的登录页点工具栏上的书签图标，选「填入账号」即可，不需要设置选择器。` : '填上「网站」后，在那个网站的登录页就能一键填入。'}</span>
                    <label class="check"><input type="checkbox" data-change="fill" ${cur.fill ? 'checked' : ''}>允许在这个网站填入</label></div></div>`
                : ''}
              ${cur.kind === 'key' && secret?.ai?.baseUrl
                ? html`<div class="notice ok">${icon('zap', 16)}<div class="col" style="gap:8px"><span>这是一个 AI 接口。签到助手找不到按钮时，可以用它帮忙挑一个最像的再试一次（AI 只看得到按钮上的文字，看不到账号和密码）。</span>
                    <label class="check"><input type="checkbox" data-change="useAi" ${aiId === cur.id ? 'checked' : ''}>给签到助手用</label></div></div>`
                : ''}
              ${cur.kind === 'key' && secret?.note ? html`<p class="small muted" style="line-height:1.7">${secret.note}</p>` : ''}`
            : html`<div class="notes-empty"><p class="muted">从左边选一条，或者新建一条。</p></div>`}
        </section>
      </div>`;
    }

    function conflictNotice(c) {
      if (c.source === 'cloud') {
        return html`<div class="notice warn">${icon('alert', 16)}<div class="col" style="gap:8px"><span>云端已经有另一个保险箱（${c.remoteCount} 条），和这台电脑上的不是同一个。输入云端保险箱的主密码，就能把这里的内容并过去，以后两台电脑共用一个。</span>
          <div class="row wrap"><button type="button" class="btn sm pri" data-click="mergeRemote">合并到云端保险箱</button><button type="button" class="btn sm danger" data-click="useRemote">直接改用云端的</button></div></div></div>`;
      }
      return html`<div class="notice warn">${icon('alert', 16)}<div class="col" style="gap:8px"><span>导入的备份里还有一个保险箱（${c.remoteCount} 条），和这里的不是同一个。输入那个保险箱的主密码，就能把这些条目并进这里，之后继续用这里的主密码。</span>
        <div class="row wrap"><button type="button" class="btn sm pri" data-click="mergeRemote">合并进这里</button><button type="button" class="btn sm ghost" data-click="dropImported">不要了</button></div></div></div>`;
    }

    function draw() {
      if (!state.status) {
        morph(root, html`<div class="page"><div class="row muted"><span class="spinner"></span>正在读取保险箱…</div></div>`);
        return;
      }
      const s = state.status;
      if (!s.exists) morph(root, html`<div class="page">${createView()}</div>`);
      else if (!s.unlocked) morph(root, html`<div class="page">${lockedView()}</div>`);
      else morph(root, unlockedView());
    }

    // ───────── 编辑对话框 ─────────

    function editDialog(item) {
      const isNew = !item;
      let kind = item?.kind || (state.kind !== 'all' ? state.kind : 'login');
      const secret = item ? state.secrets.get(item.id) || {} : {};
      const fieldsHtml = (k) => {
        if (k === 'login')
          return html`<div class="field"><label for="ve-site">网站</label><input id="ve-site" class="input" name="site" value="${item?.site || ''}" placeholder="例如 github.com" autocomplete="off"><span class="hint">只在这个网站（含子域名）上填入，防止钓鱼网站骗走密码。</span></div>
            <div class="field"><label for="ve-user">用户名</label><input id="ve-user" class="input" name="username" value="${secret.username || ''}" autocomplete="off"></div>
            <div class="field"><label for="ve-pass">密码</label><div class="row"><input id="ve-pass" class="input mono" name="password" type="password" value="${secret.password || ''}" autocomplete="new-password">
              <button type="button" class="icon-btn" data-x="showpw" aria-label="显示密码">${icon('eye', 16)}</button><button type="button" class="btn sm" data-x="gen">生成</button></div></div>
            <div class="field"><label for="ve-url">登录网址（可选）</label><input id="ve-url" class="input" name="url" value="${secret.url || ''}" placeholder="https://" autocomplete="off"></div>
            <div class="field"><label for="ve-note">备注（可选）</label><textarea id="ve-note" class="textarea" name="note" rows="2">${secret.note || ''}</textarea></div>`;
        if (k === 'key')
          return html`<div class="field"><label for="ve-secret">密钥或令牌</label><textarea id="ve-secret" class="textarea mono" name="secret" rows="2" autocomplete="off">${secret.secret || ''}</textarea></div>
            <div class="field"><label for="ve-knote">用途（可选）</label><textarea id="ve-knote" class="textarea" name="note" rows="2" placeholder="比如：给部署工具用，只有仓库读写权限">${secret.note || ''}</textarea></div>
            <details class="adv" ${secret.ai?.baseUrl ? 'open' : ''}><summary>这是一个 AI 接口（OpenAI 兼容）</summary><div>
              <div class="field"><label for="ve-base">接口地址</label><input id="ve-base" class="input" name="aiBase" value="${secret.ai?.baseUrl || ''}" placeholder="https://api.example.com/v1" autocomplete="off"></div>
              <div class="field"><label for="ve-model">模型</label><input id="ve-model" class="input" name="aiModel" value="${secret.ai?.model || ''}" autocomplete="off"></div>
              <span class="hint">签到助手找不到按钮时会用它挑一个。第一次使用前会请你授权访问这个地址。</span></div></details>`;
        return html`<div class="field"><label for="ve-content">内容</label><textarea id="ve-content" class="textarea" name="content" rows="8">${secret.content || ''}</textarea></div>`;
      };
      modal({
        title: isNew ? '新建' : '编辑「' + item.name + '」',
        body: html`<form class="col" style="gap:14px" data-x="form" novalidate>
          ${isNew ? html`<div class="seg" role="radiogroup" aria-label="类型" data-x="kinds">${['login', 'key', 'note'].map((k) => html`<button type="button" role="radio" data-k="${k}" aria-checked="${kind === k ? 'true' : 'false'}">${KIND_NAME[k]}</button>`)}</div>` : ''}
          <div class="field"><label for="ve-name">名称</label><input id="ve-name" class="input" name="name" value="${item?.name || ''}" autocomplete="off" autofocus></div>
          <div class="col" style="gap:14px" data-x="fields">${fieldsHtml(kind)}</div>
          <p class="error-text" data-x="err" hidden></p>
          <div class="modal-foot"><button type="button" class="btn" data-x="cancel">取消</button><button type="submit" class="btn pri">保存</button></div>
        </form>`,
        onMount(box, close) {
          const form = box.querySelector('[data-x=form]');
          const err = box.querySelector('[data-x=err]');
          const fields = box.querySelector('[data-x=fields]');
          box.querySelector('[data-x=cancel]').addEventListener('click', () => close());
          box.querySelector('[data-x=kinds]')?.addEventListener('click', (e) => {
            const b = e.target.closest('[data-k]');
            if (!b) return;
            kind = b.getAttribute('data-k');
            for (const x of box.querySelectorAll('[data-x=kinds] [data-k]')) x.setAttribute('aria-checked', x === b ? 'true' : 'false');
            fields.innerHTML = String(fieldsHtml(kind));
          });
          box.addEventListener('click', (e) => {
            const t = e.target.closest('[data-x]');
            if (!t) return;
            if (t.getAttribute('data-x') === 'gen') {
              const p = form.querySelector('[name=password]');
              p.value = generatePassword();
              p.type = 'text';
            }
            if (t.getAttribute('data-x') === 'showpw') {
              const p = form.querySelector('[name=password]');
              p.type = p.type === 'password' ? 'text' : 'password';
            }
          });
          form.addEventListener('submit', async (e) => {
            e.preventDefault();
            const fd = new FormData(form);
            const get = (k) => String(fd.get(k) ?? '');
            let payload;
            if (kind === 'login') {
              const url = coerceUrl(get('url'));
              let site = get('site').trim();
              if (!site && url) site = domainOf(url);
              payload = { kind, name: get('name') || site, site, fill: item ? item.fill : true, secret: { username: get('username'), password: get('password'), url, note: get('note') } };
            } else if (kind === 'key') {
              const base = get('aiBase').trim();
              payload = { kind, name: get('name'), secret: { secret: get('secret'), note: get('note'), fields: secret.fields || [], ai: base ? { baseUrl: base, model: get('aiModel').trim() } : undefined } };
            } else {
              payload = { kind, name: get('name'), secret: { content: get('content') } };
            }
            if (item) payload.id = item.id;
            try {
              const saved = await call('vault.save', payload);
              state.secrets.delete(saved.id);
              state.currentId = saved.id;
              close();
              toast('已保存');
              load();
            } catch (e2) {
              err.textContent = e2.message;
              err.hidden = false;
            }
          });
        },
      });
    }

    // ───────── 事件 ─────────

    bind(root, {
      pw: (e) => {
        state.pw = e.target.value;
        state.err = '';
        render();
      },
      pw2: (e) => {
        state.pw2 = e.target.value;
        state.err = '';
      },
      recoveryKey: (e) => {
        state.recoveryKey = e.target.value;
        state.err = '';
      },
      async syncNow() {
        try {
          await call('sync.now');
          toast('同步完成');
          load();
        } catch (e) {
          toastError(e);
        }
      },
      async prepare() {
        if ([...state.pw].length < 12) return ((state.err = '主密码至少要 12 个字符'), render());
        if (state.pw !== state.pw2) return ((state.err = '两次输入的不一样'), render());
        state.busy = true;
        render();
        try {
          state.creating = await call('vault.prepare', { password: state.pw });
          state.pw = state.pw2 = '';
        } catch (e) {
          state.err = e.message;
        }
        state.busy = false;
        render();
      },
      savedKey: (e) => {
        state.savedKey = e.target.checked;
        render();
      },
      copyKey: () => copyText(state.creating.recoveryKey).then(() => toast('已复制恢复密钥')),
      downloadKey: () => downloadText('谜盒-保险箱恢复密钥.txt', `谜盒插件 · 保险箱恢复密钥\n\n${state.creating.recoveryKey}\n\n忘记主密码时，用它解锁保险箱。请保存在安全的地方，不要发给任何人。\n生成时间：${new Date().toLocaleString('zh-CN')}\n`),
      async commit() {
        state.busy = true;
        render();
        try {
          await call('vault.commit');
          state.creating = null;
          state.savedKey = false;
          toast('保险箱已创建');
        } catch (e) {
          toastError(e);
        }
        state.busy = false;
        load();
      },
      async cancelCreate() {
        await call('vault.cancelCreate').catch(() => {});
        state.creating = null;
        state.savedKey = false;
        render();
      },
      async unlock() {
        if (!state.pw) return ((state.err = '请输入主密码'), render());
        state.busy = true;
        render();
        try {
          await call('vault.unlock', { password: state.pw });
          state.pw = '';
          state.err = '';
        } catch (e) {
          state.err = e.message;
        }
        state.busy = false;
        load();
        setTimeout(() => root.querySelector('#v-pw')?.focus(), 30);
      },
      toggleRecovery() {
        state.recoveryMode = !state.recoveryMode;
        state.err = '';
        state.pw = state.pw2 = '';
        render();
      },
      async recover() {
        if (!state.recoveryKey.trim()) return ((state.err = '请输入恢复密钥'), render());
        if ([...state.pw].length < 12) return ((state.err = '新的主密码至少要 12 个字符'), render());
        if (state.pw !== state.pw2) return ((state.err = '两次输入的新密码不一样'), render());
        state.busy = true;
        render();
        try {
          await call('vault.unlockWithRecovery', { recoveryKey: state.recoveryKey.trim(), newPassword: state.pw });
          state.recoveryMode = false;
          state.recoveryKey = state.pw = state.pw2 = '';
          toast('已解锁，主密码已更新');
        } catch (e) {
          state.err = e.message;
        }
        state.busy = false;
        load();
      },
      lock: () => call('vault.lock').then(load).catch(toastError),
      create: () => editDialog(null),
      edit() {
        const cur = state.items.find((i) => i.id === state.currentId);
        if (cur) editDialog(cur);
      },
      async remove() {
        const cur = state.items.find((i) => i.id === state.currentId);
        if (!cur) return;
        const ok = await confirmBox({ title: `删除「${cur.name}」？`, text: '删除后其他电脑上也会消失。删除后可以马上撤销。', ok: '删除', danger: true });
        if (!ok) return;
        await call('vault.remove', { id: cur.id }).catch(toastError);
        state.currentId = null;
        load();
        toast(`已删除「${cur.name}」`, { action: { label: '撤销', run: () => call('vault.restore', { id: cur.id }).then(() => ((state.currentId = cur.id), load())) } });
      },
      kind(e, el) {
        state.kind = el.getAttribute('data-k');
        render();
      },
      search: debounce((e) => {
        state.q = e.target.value;
        render();
      }, 100),
      pick(e, el) {
        state.currentId = el.getAttribute('data-id');
        render();
        ensureSecret(state.currentId);
      },
      back() {
        state.currentId = null;
        render();
      },
      reveal(e, el) {
        const key = state.currentId + ':' + el.getAttribute('data-i');
        state.shown.has(key) ? state.shown.delete(key) : state.shown.add(key);
        render();
      },
      async copy(e, el) {
        const cur = state.items.find((i) => i.id === state.currentId);
        const f = fieldsOf(cur, state.secrets.get(cur.id))[Number(el.getAttribute('data-i'))];
        if (!f) return;
        try {
          await copyText(f.value, { secret: f.secret });
          toast(f.secret && ctx.store.settings?.clipboardClear ? '已复制，30 秒后自动清空剪贴板' : '已复制');
        } catch {
          toast('复制失败，请手动选中复制', { error: true });
        }
      },
      fill(e) {
        call('vault.setFill', { id: state.currentId, fill: e.target.checked }).then(load).catch(toastError);
      },
      useAi(e) {
        const on = e.target.checked;
        const base = state.secrets.get(state.currentId)?.ai?.baseUrl || '';
        const origin = on ? originOf(base) : null;
        // 访问 AI 接口地址的权限必须在点击时直接申请。
        const granted = origin ? chrome.permissions.request({ origins: [origin + '/*'] }) : Promise.resolve(true);
        granted
          .then((ok) => {
            if (!ok) {
              toast('需要允许访问 AI 接口地址，签到助手才能用它', { error: true });
              e.target.checked = false;
              return;
            }
            return call('settings.update', { ai: { entryId: on ? state.currentId : null } }).then(() => toast(on ? '签到助手会在找不到按钮时用这个 AI 接口' : '已停用'));
          })
          .catch(toastError);
      },
      async mergeRemote() {
        const c = state.status?.conflict || {};
        const cloud = c.source === 'cloud';
        const pw = await promptBox(
          cloud
            ? { title: '合并到云端保险箱', label: '云端保险箱的主密码', type: 'password', ok: '合并', hint: '这台电脑上的条目会用云端保险箱的密钥重新加密，之后用云端的主密码解锁。' }
            : { title: '合并备份里的保险箱', label: '那个保险箱的主密码', type: 'password', ok: '合并', hint: '那些条目会用这里的密钥重新加密，主密码不变。' },
        );
        if (pw === null) return;
        try {
          const r = await call('vault.mergeIntoRemote', { password: pw });
          toast(`已合并 ${r.merged} 条${r.failed ? `，${r.failed} 条解不开，已跳过` : ''}`);
          load();
        } catch (e) {
          toastError(e);
        }
      },
      async dropImported() {
        const ok = await confirmBox({ title: '不要导入的保险箱了？', text: '这里的保险箱不受影响。以后想要可以重新导入那个文件。', ok: '不要了' });
        if (!ok) return;
        await call('vault.dismissConflict').catch(toastError);
        load();
      },
      async useRemote() {
        const ok = await confirmBox({ title: '改用云端的保险箱？', text: `这台电脑上的 ${state.items.length} 条会被删除，改用云端保险箱（用云端的主密码解锁）。这一步不能撤销。`, ok: '改用云端的', danger: true });
        if (!ok) return;
        await call('vault.useRemote').catch(toastError);
        load();
      },
    });

    const off = onChange(['vault', 'settings'], () => load().catch(() => {}));
    let loadPending = false;
    tick = setInterval(() => {
      const el = root.querySelector('#vault-left');
      if (el) el.textContent = remaining() || '关闭浏览器时锁定';
      // 到期后到 load() 返回之间会每秒都触发，加个标志位只跑一次。
      if (!loadPending && state.status?.unlocked && state.status.expiresAt && state.status.expiresAt < Date.now()) {
        loadPending = true;
        load().finally(() => { loadPending = false; });
      }
    }, 1000);
    load().catch((e) => toastError(e));

    return {
      update(route) {
        const id = route.query.get('id');
        if (id) {
          state.currentId = id;
          render();
          if (state.status?.unlocked) ensureSecret(id);
        }
      },
      unmount() {
        off();
        clearInterval(tick);
        state.secrets.clear();
      },
    };
  },
};
