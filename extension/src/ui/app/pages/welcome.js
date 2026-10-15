// 首次使用：登录 Google 或仅在本机使用 → 设置保险箱（可选）→ 完成。

import { html, morph, bind, scheduler } from '../../kit/dom.js';
import { icon, brandMark } from '../../kit/icons.js';
import { toast, toastError, copyText, downloadText } from '../../kit/ui.js';
import { call } from '../../../shared/client.js';
import { passwordScore } from './vault.js';

export default {
  title: '欢迎',
  mount(root, ctx) {
    const state = {
      step: 1,
      busy: false,
      err: '',
      loadErr: '',
      finishErr: '',
      google: null,
      vault: null,
      pw: '',
      pw2: '',
      recoveryKey: null,
      keySaved: false,
    };
    const render = scheduler(draw);

    async function load() {
      state.busy = true;
      state.loadErr = '';
      render();
      try {
        const [google, vault] = await Promise.all([call('google.status'), call('vault.status')]);
        Object.assign(state, { google, vault });
      } catch (e) {
        state.loadErr = e?.message || '读取设置失败，请重试。';
      } finally {
        state.busy = false;
        render();
      }
    }

    const stepNames = () => ['登录 Google', '设置保险箱', '完成'];

    function side() {
      return html`<aside class="welcome-side">
        <div class="brand">${brandMark(48)}<b>谜盒</b><p>收藏、笔记和重要信息放在一处，用你的 Google 账号在每台电脑间同步。</p></div>
        <ol class="welcome-steps">
          ${stepNames().map((n, i) => {
            const k = i + 1;
            const cls = state.step > k ? 'done' : state.step === k ? 'cur' : '';
            return html`<li class="${cls}" ${state.step === k ? html`aria-current="step"` : ''}><span class="n">${state.step > k ? icon('check', 14, { stroke: 3 }) : k}</span><span>${n}</span></li>`;
          })}
        </ol>
      </aside>`;
    }

    function step1() {
      const g = state.google;
      return html`<h1>用 Google 账号同步</h1>
        <p class="lead">登录后，收藏、笔记和保险箱会存到你自己的 Google Drive 应用私有空间。换一台电脑登录同一个账号，内容就都在。</p>
        ${g?.signedIn && !g.reauth && !g.otherAccount
          ? html`<div class="notice ok">${icon('check', 16)}<span>已登录 ${g.user?.email}</span></div>
              <div class="row"><button type="button" class="btn pri lg" data-click="next" ${state.busy ? 'disabled' : ''}>${state.busy ? html`<span class="spinner"></span>正在准备同步…` : '继续'}</button></div>`
          : !g?.configured
            ? html`<div class="notice">${icon('info', 16)}<span>这个插件还没有配置 Google 登录，资料先只保存在这台电脑上。可在设置 → 高级设置中配置。</span></div>
                <button type="button" class="btn pri lg" data-click="localOnly" ${state.busy ? 'disabled' : ''}>在这台电脑上使用</button>`
            : html`<button type="button" class="btn pri lg" data-click="signIn" ${state.busy ? 'disabled' : ''}>${state.busy ? html`<span class="spinner"></span>正在打开 Google 登录…` : '用 Chrome 里的 Google 账号登录'}</button>
              <button type="button" class="btn lg" data-click="localOnly" ${state.busy ? 'disabled' : ''}>先只在这台电脑上用</button>`}
        ${state.err ? html`<p class="error-text" role="alert">${state.err}</p>` : ''}
        ${g?.configured && (!g?.signedIn || g.reauth || g.otherAccount) ? html`<p class="small muted" style="line-height:1.7">使用 Chrome 当前登录的 Google 账号；Chrome 还没登录时会先请你登录。只申请 Drive 应用私有空间的权限，看不到你 Drive 里的其他文件。以后随时可以在设置里登录或退出。</p>` : ''}`;
    }

    function step2() {
      const v = state.vault;
      if (v?.exists && !state.recoveryKey) {
        return html`<h1>保险箱已经在了</h1>
          <p class="lead">已设置保险箱，用原来的主密码即可解锁。</p>
          <div class="row wrap"><a class="btn lg" href="#/vault" data-click="finishTo" data-to="#/vault">去解锁</a><button type="button" class="btn pri lg" data-click="next">继续</button></div>`;
      }
      if (state.recoveryKey) {
        return html`<h1>保存恢复密钥</h1>
          <p class="lead">忘记主密码时，只有它能打开保险箱。它只显示这一次，请抄下来、打印，或存到另一个密码管理器。</p>
          <div class="recovery-box">${state.recoveryKey}</div>
          <div class="row wrap"><button type="button" class="btn sm" data-click="copyKey">${icon('copy', 14)}复制</button><button type="button" class="btn sm" data-click="downloadKey">${icon('download', 14)}下载成文本文件</button></div>
          <label class="check"><input type="checkbox" data-change="keySaved" ${state.keySaved ? 'checked' : ''}>我已经把恢复密钥存到安全的地方</label>
          <div class="row"><button type="button" class="btn pri lg" data-click="commitVault" ${state.keySaved && !state.busy ? '' : 'disabled'}>继续</button></div>`;
      }
      const sc = passwordScore(state.pw);
      return html`<h1>设置保险箱</h1>
        <p class="lead">放网站密码、API 密钥和私密笔记。内容先在本机用主密码加密，Google 和插件作者都打不开。这一步可以以后再做。</p>
        <form class="col" style="gap:14px" data-submit="createVault" novalidate>
          <div class="field"><label for="w-pw">主密码</label><input id="w-pw" class="input" type="password" value="${state.pw}" data-input="pw" placeholder="至少 12 个字符，可以是一句话" autocomplete="new-password">
            <div class="strength" aria-hidden="true"><span style="width:${sc.pct}%;background:${sc.color}"></span></div><span class="hint">${sc.text || '主密码不会上传，忘记后只能用恢复密钥找回。'}</span></div>
          <div class="field"><label for="w-pw2">再输入一次</label><input id="w-pw2" class="input" type="password" value="${state.pw2}" data-input="pw2" autocomplete="new-password"></div>
          ${state.err ? html`<p class="error-text" role="alert">${state.err}</p>` : ''}
          <div class="row wrap"><button type="submit" class="btn pri lg" ${state.busy ? 'disabled' : ''}>${state.busy ? html`<span class="spinner"></span>正在生成密钥…` : '创建保险箱'}</button>
            <button type="button" class="btn lg ghost" data-click="next">以后再说</button></div>
        </form>`;
    }

    function step3() {
      return html`<h1>可以开始用了</h1>
        <div class="how-list">
          <div class="how"><span class="ticon">${icon('bookmark', 18)}</span><span class="grow">点浏览器右上角的书签图标（或按 <kbd>Alt</kbd> <kbd>Shift</kbd> <kbd>S</kbd>），当前网页就存好了。<span class="small muted" style="display:block">没看到图标？点拼图形状的扩展按钮，把「谜盒」固定到工具栏。</span></span></div>
          <div class="how"><span class="ticon">${icon('search', 18)}</span><span class="grow">在任何网页按 <kbd>Alt</kbd> <kbd>Shift</kbd> <kbd>K</kbd>，搜索收藏、笔记和保险箱。</span></div>
          <div class="how"><span class="ticon">${icon('sidebar', 18)}</span><span class="grow">按 <kbd>Alt</kbd> <kbd>Shift</kbd> <kbd>B</kbd> 打开侧栏，边看网页边记笔记。</span></div>
          <div class="how"><span class="ticon">${icon('scissors', 18)}</span><span class="grow">选中网页上的文字后右键「把选中的文字存为笔记」，会记下来源。</span></div>
        </div>
        <div class="row"><button type="button" class="btn pri lg" data-click="finish" ${state.busy ? 'disabled' : ''}>${state.busy ? html`<span class="spinner"></span>正在保存…` : '打开我的收藏'}</button></div>`;
    }

    function draw() {
      const body = state.loadErr
        ? html`<p class="error-text" role="alert">${state.loadErr}</p><button type="button" class="btn pri lg" data-click="retryLoad" ${state.busy ? 'disabled' : ''}>${state.busy ? html`<span class="spinner"></span>正在重试…` : '重试'}</button>`
        : state.google
          ? [step1, step2, step3][state.step - 1]()
          : html`<div class="row muted"><span class="spinner"></span>正在准备…</div>`;
      morph(
        root,
        html`<div class="welcome">${side()}<div class="welcome-main">
          ${state.google ? html`<div class="row" style="justify-content:flex-end;margin:-40px 0 8px"><button type="button" class="link-btn" data-click="skipAll" ${state.busy ? 'disabled' : ''}>跳过设置</button></div>` : ''}
          ${body}
          ${state.finishErr ? html`<p class="error-text" role="alert">${state.finishErr}</p>` : ''}</div></div>`,
      );
    }

    async function finish(to = '#/bookmarks') {
      if (state.busy) return;
      state.busy = true;
      state.finishErr = '';
      render();
      try {
        await call('settings.update', { onboarded: true });
        location.replace(location.pathname + to);
      } catch (e) {
        state.finishErr = e?.message || '保存设置失败，请重试。';
        state.busy = false;
        render();
      }
    }

    bind(root, {
      async signIn() {
        if (state.busy) return;
        state.busy = true;
        state.err = '';
        render();
        try {
          const result = await call('google.signIn');
          state.google = { signedIn: true, user: result?.user || null };
          await call('sync.now');
          state.vault = await call('vault.status');
          state.step = 2;
        } catch (e) {
          state.err = e.message;
        }
        state.busy = false;
        render();
      },
      async localOnly() {
        if (state.busy) return;
        state.busy = true;
        state.err = '';
        render();
        try {
          state.vault = await call('vault.status');
          state.step = 2;
        } catch (e) {
          state.err = e.message;
        }
        state.busy = false;
        render();
      },
      async next() {
        if (state.busy) return;
        state.err = '';
        if (state.step === 1 && state.google?.signedIn) {
          state.busy = true;
          render();
          try {
            await call('sync.now');
            state.vault = await call('vault.status');
            state.step = 2;
          } catch (e) {
            state.err = e.message;
          }
          state.busy = false;
          render();
          return;
        }
        state.step = Math.min(3, state.step + 1);
        render();
      },
      pw: (e) => {
        state.pw = e.target.value;
        state.err = '';
        render();
      },
      pw2: (e) => (state.pw2 = e.target.value),
      async createVault() {
        if ([...state.pw].length < 12) return ((state.err = '主密码至少要 12 个字符'), render());
        if (state.pw !== state.pw2) return ((state.err = '两次输入的不一样'), render());
        state.busy = true;
        render();
        try {
          const r = await call('vault.prepare', { password: state.pw });
          state.recoveryKey = r.recoveryKey;
          state.pw = state.pw2 = '';
        } catch (e) {
          state.err = e.message;
        }
        state.busy = false;
        render();
      },
      keySaved: (e) => {
        state.keySaved = e.target.checked;
        render();
      },
      copyKey: () => copyText(state.recoveryKey).then(() => toast('已复制恢复密钥')).catch(toastError),
      downloadKey: () => downloadText('谜盒-保险箱恢复密钥.txt', `谜盒插件 · 保险箱恢复密钥\n\n${state.recoveryKey}\n\n忘记主密码时，用它解锁保险箱。请保存在安全的地方。\n生成时间：${new Date().toLocaleString('zh-CN')}\n`),
      async commitVault() {
        state.busy = true;
        render();
        try {
          await call('vault.commit');
          state.recoveryKey = null;
          state.step = 3;
        } catch (e) {
          toastError(e);
        }
        state.busy = false;
        render();
      },
      finish: () => finish(),
      finishTo(e, el) {
        e.preventDefault();
        if (state.busy) return;
        finish(el.getAttribute('data-to'));
      },
      retryLoad: () => load(),
      skipAll: () => finish(),
    });

    load();
    return { unmount() {} };
  },
};
