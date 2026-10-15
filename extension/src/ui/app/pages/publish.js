// 静态网页发布界面；文件内容只在用户点击检查后读取并交给后台。

import { html, morph, bind, scheduler } from '../../kit/dom.js';
import { icon } from '../../kit/icons.js';
import { confirmBox, promptBox, copyText, toast } from '../../kit/ui.js';
import { call } from '../../../shared/client.js';

const LIMIT_FILES = 200;
const LIMIT_FILE = 5 * 1024 * 1024;
const LIMIT_TOTAL = 20 * 1024 * 1024;
const EXCLUDED = /(^|\/)(?:\.git|node_modules|\.env(?:\..*)?|\.DS_Store|__MACOSX)(?:\/|$)/i;
const bytes = (n) => `${(n / 1024 / 1024).toFixed(n < 1024 * 1024 ? 3 : 1)} MiB`;

function readBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`读取「${file.name}」失败`));
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.readAsDataURL(file);
  });
}

function safeUrl(value) {
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) ? url.href : '';
  } catch { return ''; }
}

export default {
  title: '创建网页',
  mount(root, ctx) {
    const state = {
      provider: ctx.route.parts[0] === 'cloudflare' ? 'cloudflare' : 'github',
      files: [], excluded: 0, tokenId: '', repo: '', accountId: '', project: '',
      preview: null, job: null, error: '', busy: false, confirmSourceChange: false,
      tokens: [], locked: true, timer: null, generation: 0,
      connection: null, pending: null, unlocked: false, publishReady: false, targets: null, selectedTarget: 'new',
      siteName: '', pageName: '', customSlug: false, accountChoices: [], repoChoices: [], showPaste: false,
      sites: [], dropping: false, filesLabel: '', manualAccount: false,
    };
    let active = true;
    let polling = false;
    let lastBuildCheck = 0;
    let targetGeneration = 0;
    let connectionGeneration = 0;
    let connectionRequest = 0;
    let vaultRequest = 0;
    let sitesRequest = 0;
    const render = scheduler(draw);
    const isBusy = () => state.busy || state.dropping || ['uploading', 'building'].includes(state.job?.status);
    const isSiteBusy = () => state.busy || state.dropping || state.job?.status === 'uploading';
    const invalidate = () => { state.preview = null; state.confirmSourceChange = false; state.generation++; };
    const fmtTarget = (p) => p?.repo || (p?.accountId ? `${p.accountId} / ${p.project}` : '');
    const connecting = () => ['waiting', 'capturing'].includes(state.pending?.status);

    function resetTargets() {
      targetGeneration++;
      state.targets = null; state.accountChoices = []; state.repoChoices = [];
      state.accountId = ''; state.repo = ''; state.project = ''; state.selectedTarget = 'new';
      state.manualAccount = false;
    }

    async function loadVault() {
      const request = ++vaultRequest;
      try {
        const [status, items] = await Promise.all([call('vault.status'), call('vault.list')]);
        if (!active || request !== vaultRequest) return;
        state.locked = !status.unlocked;
        state.tokens = items.filter((item) => item.kind === 'key');
        if (state.tokenId && !state.tokens.some((item) => item.id === state.tokenId)) { state.tokenId = ''; invalidate(); }
        state.unlocked = !!status.unlocked;
      } catch (e) { if (active && request === vaultRequest) state.error = e.message; }
      render();
    }

    async function loadConnection(refresh = false) {
      const provider = state.provider;
      const generation = connectionGeneration, request = ++connectionRequest;
      try {
        const result = await call('publish.connect.state', { provider });
        if (!active || provider !== state.provider || generation !== connectionGeneration || request !== connectionRequest) return;
        const changed = result.connection?.tokenId !== state.connection?.tokenId || result.connection?.connectedAt !== state.connection?.connectedAt;
        state.connection = result.connection || null; state.pending = result.pending || null;
        state.publishReady = !!result.publishReady;
        if (changed) { invalidate(); resetTargets(); state.tokenId = state.connection?.tokenId || ''; }
        if (state.connection && (changed || refresh)) {
          state.tokenId = state.connection.tokenId;
          await loadVault();
          if (!active || provider !== state.provider || generation !== connectionGeneration || request !== connectionRequest) return;
        }
        if (state.connection && state.publishReady) await loadTargets();
        render();
      } catch (e) { if (active && generation === connectionGeneration && request === connectionRequest) { state.error = e.message; render(); } }
    }

    async function loadTargets() {
      const provider = state.provider, tokenId = state.tokenId, accountId = state.accountId, generation = ++targetGeneration;
      if (!state.connection || tokenId !== state.connection.tokenId || !state.publishReady) { state.targets = null; return; }
      try {
        const result = await call('publish.targets', { provider, tokenId, ...(provider === 'cloudflare' && accountId ? { accountId } : {}) });
        if (!active || generation !== targetGeneration || provider !== state.provider || tokenId !== state.tokenId || accountId !== state.accountId) return;
        state.targets = result;
        state.error = result.accountDiscoveryError && !result.accountId ? result.accountDiscoveryError : '';
        if (provider === 'github') {
          state.repoChoices = result.repositories || [];
        } else {
          state.accountChoices = result.accounts || [];
          if (result.accountDiscoveryError || result.needsAccountRead) state.manualAccount = true;
          if (result.accountId) state.accountId = result.accountId;
        }
      } catch (e) { if (active && generation === targetGeneration) state.error = e.message; }
      if (active && generation === targetGeneration) render();
    }

    async function loadSites() {
      const request = ++sitesRequest;
      try {
        const result = await call('publish.sites');
        if (active && request === sitesRequest) { state.sites = result; render(); }
      } catch (e) { if (active && request === sitesRequest) { state.error = e.message; render(); } }
    }

    function suggestedName() {
      const file = state.files.find((f) => f.path === 'index.html') || state.files[0];
      const stem = state.pageName || (file?.file?.name || '').replace(/\.[^.]*$/, '');
      const slug = stem.normalize('NFKD').replace(/[^\x00-\x7F]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+/, '').slice(0, 39).replace(/-+$/, '');
      return slug || `mibox-page-${Math.random().toString(36).slice(2, 8)}`;
    }

    function applyFiles(items, label) {
      if (!items.length) return;
      invalidate(); state.job = null; updateTimer(); state.files = items; state.filesLabel = label; state.error = '';
      if (!state.pageName) state.pageName = (label || items[0].file.name).replace(/\.[^.]*$/, '').slice(0, 80);
      if (!state.siteName) state.siteName = suggestedName();
      render();
    }

    async function readDrop(entries, files) {
      const items = [];
      const add = (file, path) => {
        if (EXCLUDED.test(path) || path.split('/').some((part) => part.startsWith('.'))) return;
        if (file.size > LIMIT_FILE) throw new Error(`「${file.name}」超过单文件 5 MiB 限制`);
        items.push({ file, path, size: file.size, type: file.type });
        if (items.length > LIMIT_FILES || items.reduce((n, item) => n + item.size, 0) > LIMIT_TOTAL) throw new Error('最多 200 个文件，总计不超过 20 MiB');
      };
      async function walk(entry, path) {
        if (EXCLUDED.test(path) || entry.name.startsWith('.')) return;
        if (entry.isFile) { add(await new Promise((resolve, reject) => entry.file(resolve, reject)), path); return; }
        if (!entry.isDirectory) return;
        const reader = entry.createReader();
        for (;;) {
          const children = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
          if (!children.length) break;
          for (const child of children) await walk(child, path ? path + '/' + child.name : child.name);
        }
      }
      if (entries.length && entries.every(Boolean)) {
        const singleFolder = entries.length === 1 && entries[0].isDirectory;
        for (const entry of entries) await walk(entry, singleFolder ? '' : entry.name);
      } else for (const file of files) add(file, file.name);
      if (items.length === 1 && /\.html?$/i.test(items[0].path) && !entries.some((entry) => entry?.isDirectory)) items[0].path = 'index.html';
      return items;
    }

    async function removePage(id) {
      if (isSiteBusy()) return;
      const site = state.sites.find((row) => row.id === id);
      if (!site) return;
      const operation = connectionGeneration;
      state.busy = true; state.error = ''; render();
      try {
        const access = await call('publish.deleteAccess');
        if (!active || operation !== connectionGeneration) return;
        if (!access.authorized) {
          let password = await promptBox({ title: '验证删除权限', label: '保险箱主密码', type: 'password', ok: '验证', hint: '验证后 24 小时内可删除网页；每次删除仍会单独确认目标。' });
          if (password === null || !active || operation !== connectionGeneration) return;
          let authorization;
          try { authorization = await call('publish.authorizeDelete', { password }); }
          finally { password = ''; }
          if (!active || operation !== connectionGeneration) return;
          if (!authorization?.authorized) throw new Error('删除权限验证失败');
          await loadConnection(true);
          if (!active || operation !== connectionGeneration) return;
        }
        if (!active || operation !== connectionGeneration) return;
        const effect = site.provider === 'github' ? '公开网页会被下架，GitHub 仓库和源文件保留。' : '对应的 Cloudflare Pages 项目、部署和项目域名配置会被删除，公开网页将无法访问。';
        const confirmed = await confirmBox({ title: `删除「${site.name}」？`, text: `${effect} 目标：${fmtTarget(site.target)}。`, ok: '删除网页', danger: true });
        if (!confirmed || !active || operation !== connectionGeneration) return;
        const origin = site.provider === 'github' ? 'https://api.github.com/*' : 'https://api.cloudflare.com/*';
        if (!(await chrome.permissions.request({ origins: [origin] }))) throw new Error('需要允许访问平台才能删除网页');
        if (!active || operation !== connectionGeneration) return;
        await call('publish.remove', { id, confirmed: true, ...(site.provider === state.provider && state.connection ? { tokenId: state.connection.tokenId } : {}) });
        if (!active || operation !== connectionGeneration) return;
        invalidate();
        if (state.job?.provider === site.provider && fmtTarget(state.job.target) === fmtTarget(site.target)) { state.job = null; updateTimer(); }
        await loadSites();
        await loadTargets();
      } catch (e) { if (active && operation === connectionGeneration) state.error = e.message; }
      finally { if (active && operation === connectionGeneration) { state.busy = false; render(); } }
    }

    async function authorizeCreate() {
      if (isSiteBusy() || !state.connection || state.publishReady) return;
      const provider = state.provider, tokenId = state.connection.tokenId, operation = connectionGeneration;
      let password = '';
      state.busy = true; state.error = ''; render();
      try {
        password = await promptBox({ title: '启用免解锁创建', label: '保险箱主密码', type: 'password', ok: '启用', hint: '授权后创建网页无需解锁保险箱。' });
        if (password === null || !active || operation !== connectionGeneration) return;
        const result = await call('publish.authorizeCreate', { provider, tokenId, password });
        if (!active || operation !== connectionGeneration) return;
        if (!result?.ready) throw new Error('未能启用免解锁创建');
        state.publishReady = true;
        await loadTargets();
      } catch (e) { if (active && operation === connectionGeneration) state.error = e.message; }
      finally { password = ''; if (active && operation === connectionGeneration) { state.busy = false; render(); } }
    }

    async function copySite(id) {
      const site = state.sites.find((row) => row.id === id);
      if (!site || site.status !== 'live' || !safeUrl(site.url)) return;
      try { await copyText(site.url); toast('已复制网址'); }
      catch { toast('复制失败，请检查剪贴板权限', { error: true }); }
    }

    function siteTarget() {
      if (state.provider === 'github') return state.selectedTarget === 'new' ? { repo: `${state.connection?.profile?.login || ''}/${state.siteName.trim()}`, createRepo: true } : { repo: state.repo.trim() };
      return { accountId: state.accountId.trim(), project: (state.selectedTarget === 'new' ? state.siteName : state.project).trim(), ...(state.selectedTarget === 'new' ? { createProject: true } : {}) };
    }

    function requestProviderPermission(provider) {
      const origins = provider === 'github' ? ['https://github.com/*', 'https://api.github.com/*'] : ['https://dash.cloudflare.com/*', 'https://api.cloudflare.com/*'];
      return chrome.permissions.request({ origins });
    }

    async function connect(mode, selector) {
      if (isBusy()) return;
      const input = selector ? root.querySelector(selector) : null;
      const token = input?.value || '';
      if (input) input.value = '';
      if (mode === 'save' && !token) { state.error = '请粘贴访问令牌'; render(); return; }
      const provider = state.provider, tokenId = state.tokenId, generation = ++connectionGeneration;
      connectionRequest++;
      invalidate(); state.busy = true; state.error = ''; render();
      try {
        const ok = await requestProviderPermission(provider);
        if (!ok) throw new Error('需要允许访问官方页面和 API 才能连接账号');
        if (!active || generation !== connectionGeneration) return;
        await call('publish.connect.' + mode, { provider, ...(mode === 'save' ? { token } : mode === 'use' ? { tokenId } : {}) });
        if (!active || generation !== connectionGeneration) return;
        state.showPaste = false;
        await loadConnection(true);
      } catch (e) { if (active && generation === connectionGeneration) { if (mode === 'save') state.showPaste = true; state.error = e.message; } }
      finally { if (active && generation === connectionGeneration) { state.busy = false; render(); } }
    }

    async function loadJob() {
      if (polling || state.busy) return;
      polling = true;
      const generation = state.generation;
      try {
        let job = await call('publish.status');
        if (!active || state.busy || generation !== state.generation) return;
        if (job?.status === 'building' && Date.now() - lastBuildCheck > 5000) {
          lastBuildCheck = Date.now();
          job = await call('publish.check', { id: job.id });
        }
        if (!active || state.busy || generation !== state.generation) return;
        state.job = job;
        if (state.job?.status === 'ready' && state.job.provider === state.provider && !state.files.length && !state.repo && !state.project) {
          state.preview = state.job; state.tokenId = state.job.tokenId;
          if (!state.pageName) state.pageName = state.job.name || '';
          state.repo = state.job.target?.repo || ''; state.accountId = state.job.target?.accountId || ''; state.project = state.job.target?.project || '';
          const created = state.job.target?.createRepo || state.job.target?.createProject;
          const listed = state.provider === 'github' ? state.repoChoices.some((r) => r.repo === state.repo) : (state.targets?.projects || []).some((p) => p.name === state.project);
          state.selectedTarget = created ? 'new' : listed ? 'existing:' + (state.repo || state.project) : 'manual';
          if (created) state.siteName = state.provider === 'github' ? state.repo.split('/')[1] : state.project;
        }
      }
      catch (e) { if (active && !state.busy && generation === state.generation) state.error = e.message; }
      finally { polling = false; }
      if (!active) return;
      updateTimer();
      await loadSites();
      render();
    }

    function updateTimer() {
      clearInterval(state.timer);
      state.timer = ['uploading', 'building'].includes(state.job?.status)
        ? setInterval(loadJob, 2000) : null;
    }

    function filesForRead() {
      const accepted = [];
      let excluded = 0;
      for (const item of state.files) {
        const path = item.path;
        if (EXCLUDED.test(path) || path.startsWith('.') || path.split('/').some((part) => part.startsWith('.'))) { excluded++; continue; }
        accepted.push(item);
      }
      return { accepted, excluded };
    }

    function jobView() {
      const j = state.job;
      if (!j || j.provider !== state.provider || ['ready', 'removed'].includes(j.status)) return '';
      if (['live', 'building'].includes(j.status) && state.sites.some((site) => site.provider === j.provider && fmtTarget(site.target) === fmtTarget(j.target))) return '';
      const live = j.status === 'live';
      const url = live ? safeUrl(j.result?.url) : '';
      const tone = live ? 'ok' : j.status === 'failed' || j.status === 'interrupted' ? 'warn' : '';
      return html`<section class="panel col" style="gap:12px" aria-live="polite">
        <div class="row"><h2 class="grow" style="font-size:17px">${j.name || '网页'} · 发布状态</h2><span class="badge ${tone}">${j.status === 'ready' ? '待确认' : j.status === 'uploading' ? '正在上传' : j.status === 'building' ? '构建中' : live ? '已上线' : j.status === 'failed' ? '失败' : j.status === 'interrupted' ? '已中断' : j.status}</span></div>
        <p class="muted">${j.message || ''}</p>
        ${j.progress ? html`<p class="small muted">${j.progress.message || ''}${Number.isFinite(j.progress.completed) && Number.isFinite(j.progress.total) ? ` · ${j.progress.completed}/${j.progress.total}` : ''}</p>` : ''}
        ${j.error ? html`<p class="error-text" role="alert">${j.error}</p>` : ''}
        ${live && url ? html`<p>公开网址：<a href="${url}" target="_blank" rel="noopener">${url}</a></p>` : ''}
        ${j.status === 'building' ? html`<button type="button" class="btn" data-click="check" ${state.busy ? 'disabled' : ''}>检查构建状态</button>` : ''}
        ${['failed', 'interrupted'].includes(j.status) ? html`<div class="row wrap"><button type="button" class="btn" data-click="retry" ${state.busy ? 'disabled' : ''}>重新检查并准备发布</button></div>` : ''}
        ${j.status !== 'uploading' ? html`<button type="button" class="btn ghost sm" data-click="clear" ${state.busy ? 'disabled' : ''}>${j.status === 'building' ? '停止跟踪并清除本机记录（平台仍会继续构建）' : '清除本机发布记录'}</button>` : ''}
      </section>`;
    }

    function draw() {
      if (!active) return;
      const gh = state.provider === 'github';
      const { accepted, excluded } = filesForRead();
      const total = accepted.reduce((n, f) => n + f.size, 0);
      const preview = state.preview;
      const connected = state.connection;
      const canContinue = !!connected && state.tokenId === connected.tokenId && state.publishReady && !connecting();
      const hasAccount = gh || /^[a-f\d]{32}$/i.test(state.accountId.trim());
      morph(root, html`<div class="page publish-page">
        <div class="page-head"><a class="btn ghost sm" href="#/tools">${icon('chevronLeft', 16)}工具</a><h1 class="grow">创建网页</h1><span class="publish-provider">${icon(gh ? 'github' : 'cloud', 18)}${gh ? 'GitHub Pages' : 'Cloudflare Pages'}</span></div>
        <p class="page-sub">给网页起个名字，放入文件，创建一个可分享的网址。</p>
        ${state.error ? html`<div class="notice warn" role="alert">${state.error}</div>` : ''}
        <section class="panel publish-connect">
          ${connected ? html`<div class="row wrap"><span class="publish-account grow">${icon('check', 16)}已连接 ${connected.profile?.login || state.accountChoices[0]?.name || connected.profile?.label || (gh ? 'GitHub' : 'Cloudflare')}<span class="hint">凭证已存入保险箱${state.locked && !state.publishReady ? ' · 保险箱已锁定' : ''}</span></span><button type="button" class="btn ghost sm" data-click="refreshVault" ${isBusy() ? 'disabled' : ''}>刷新</button><button type="button" class="btn ghost sm" data-click="reconnect" ${isBusy() || state.locked ? 'disabled' : ''}>更换账号</button>${!state.publishReady ? html`<button type="button" class="btn pri sm" data-click="authorizeCreate" ${isSiteBusy() ? 'disabled' : ''}>启用免解锁创建</button>` : ''}</div>` : html`<div class="row wrap"><div class="grow"><h2>${state.locked ? '先解锁保险箱' : `连接 ${gh ? 'GitHub' : 'Cloudflare'}`}</h2><p class="hint">${state.locked ? '创建或解锁后，连接凭证会加密保存。' : '在官网生成令牌后，谜盒会验证、保存并自动返回。'}</p></div>${state.locked ? html`<a class="btn sm" href="#/vault">去保险箱</a>` : html`<button type="button" class="btn pri" data-click="connect" ${isBusy() ? 'disabled' : ''}>连接账号</button>`}</div>`}
          ${state.pending && connecting() ? html`<p class="hint" role="status">${state.pending.message || '等待在官网生成令牌…'}</p>` : ''}
          ${(!connected || connecting()) && !state.locked ? html`<button type="button" class="link-btn" data-click="showPaste" ${isBusy() ? 'disabled' : ''}>手动粘贴令牌</button>` : ''}
          ${state.showPaste ? html`<div class="publish-paste"><label class="sr" for="pub-connect-token">访问令牌</label><input id="pub-connect-token" class="input" type="password" placeholder="粘贴令牌，验证后存入保险箱" autocomplete="new-password" data-uncontrolled ${isBusy() || state.locked ? 'disabled' : ''}><button type="button" class="btn sm" data-click="saveToken" ${isBusy() || state.locked ? 'disabled' : ''}>验证并保存</button></div>` : ''}
          <details class="adv publish-credentials"><summary>其他连接方式</summary><div class="col"><div class="field"><label for="pub-token">已有保险箱令牌</label><div class="publish-paste"><select id="pub-token" class="select" data-change="token" ${state.locked || isBusy() ? 'disabled' : ''}><option value="">选择令牌</option>${state.tokens.map((item) => html`<option value="${item.id}" ${state.tokenId === item.id ? 'selected' : ''}>${item.name}</option>`)}</select><button type="button" class="btn sm" data-click="useToken" ${!state.tokenId || state.locked || isBusy() ? 'disabled' : ''}>连接</button></div></div><div class="publish-paste"><label class="sr" for="pub-connect-token-advanced">备用令牌</label><input id="pub-connect-token-advanced" class="input" type="password" placeholder="也可粘贴新的令牌" autocomplete="new-password" data-uncontrolled ${state.locked || isBusy() ? 'disabled' : ''}><button type="button" class="btn sm" data-click="saveAdvancedToken" ${state.locked || isBusy() ? 'disabled' : ''}>验证并连接</button></div></div></details>
        </section>
        <section class="panel publish-builder">
          <div class="field"><label for="pub-name">网页名称</label><input id="pub-name" class="input" value="${state.pageName}" data-input="name" placeholder="例如：我的作品集" maxlength="80" autocomplete="off" ${isBusy() ? 'disabled' : ''}></div>
          ${!gh && state.manualAccount ? html`<div class="field"><label for="pub-account">Cloudflare Account ID</label><input id="pub-account" class="input mono" value="${state.accountId}" data-input="account" data-change="accountDone" placeholder="填写账号的 32 位编号" autocomplete="off" ${isBusy() ? 'disabled' : ''}><span class="hint">无法自动读取账号时，可以手动指定。在 Cloudflare 控制台选择账号，复制地址中 dash.cloudflare.com/ 后的 32 位编号。</span></div>` : ''}
          ${!gh && state.accountChoices.length > 1 ? html`<div class="field"><label for="pub-account-choice">发布到哪个账号</label><select id="pub-account-choice" class="select" data-change="accountChoice" ${isBusy() || !canContinue ? 'disabled' : ''}><option value="" ${!state.accountId ? 'selected' : ''}>请选择账号</option>${state.accountChoices.map((a) => html`<option value="${a.id}" ${a.id === state.accountId ? 'selected' : ''}>${a.name}</option>`)}</select></div>` : ''}
          <div id="pub-dropzone" class="publish-drop" data-dragover="dragOver" data-dragleave="dragLeave" data-drop="drop" aria-label="拖入 HTML 文件或网站文件夹" aria-busy="${state.dropping}">
            ${icon(accepted.length ? 'globe' : 'upload', 28)}
            <strong>${state.dropping ? '正在读取文件夹…' : accepted.length ? state.filesLabel || '网站文件' : '把 HTML 文件或网站文件夹拖到这里'}</strong>
            <span class="hint" aria-live="polite">${accepted.length ? `${accepted.length} 个文件 · ${bytes(total)}${excluded ? ` · 已排除 ${excluded} 项` : ''}` : '也可以从电脑选择文件'}</span>
            <div class="row wrap"><button type="button" class="btn sm" data-click="pickFile" ${isBusy() ? 'disabled' : ''}>选择 HTML</button><button type="button" class="btn ghost sm" data-click="pickFolder" ${isBusy() ? 'disabled' : ''}>选择文件夹</button>${state.files.length ? html`<button type="button" class="btn ghost sm" data-click="clearFiles" ${isBusy() ? 'disabled' : ''}>清空</button>` : ''}</div>
            <input id="pub-file" class="sr" type="file" accept=".html,.htm,text/html" data-change="files" tabindex="-1" ${isBusy() ? 'disabled' : ''}>
            <input id="pub-folder" class="sr" type="file" webkitdirectory directory multiple data-change="files" tabindex="-1" ${isBusy() ? 'disabled' : ''}>
          </div>
          <p class="hint publish-limit">静态网页 · 最多 200 个文件 · 单文件 5 MiB · 总计 20 MiB</p>
          ${accepted.length ? html`<details class="publish-file-list"><summary>查看文件清单</summary><ul>${accepted.map((f) => html`<li>${f.path}<span>${bytes(f.size)}</span></li>`)}</ul></details>` : ''}
          <details class="adv publish-options"><summary>网址和高级选项</summary><div class="col">
            <div class="field"><label for="${gh ? 'pub-target-choice' : 'pub-project-choice'}">创建或更新</label><select id="${gh ? 'pub-target-choice' : 'pub-project-choice'}" class="select" data-change="target" ${isBusy() || !canContinue ? 'disabled' : ''}><option value="new" ${state.selectedTarget === 'new' ? 'selected' : ''}>创建新网页</option>${state.selectedTarget === 'manual' ? html`<option value="manual" selected>手动填写的目标</option>` : ''}${gh ? state.repoChoices.map((r) => html`<option value="existing:${r.repo}" ${state.selectedTarget === `existing:${r.repo}` ? 'selected' : ''}>更新 ${r.repo}</option>`) : (state.targets?.projects || []).map((p) => html`<option value="existing:${p.name}" ${state.selectedTarget === `existing:${p.name}` ? 'selected' : ''}>更新 ${p.name}</option>`)}</select></div>
            ${state.selectedTarget === 'new' ? html`<div class="field"><label for="${gh ? 'pub-site-name' : 'pub-project-input'}">网址名称</label><input id="${gh ? 'pub-site-name' : 'pub-project-input'}" class="input" value="${state.siteName}" data-input="siteName" placeholder="自动生成，可自行修改" autocomplete="off" ${isBusy() ? 'disabled' : ''}><span class="hint">小写字母、数字和中划线；网页名称可以使用中文。</span></div>` : ''}
            ${gh ? html`<div class="field"><label for="pub-repo">GitHub 仓库</label><input id="pub-repo" class="input" value="${state.repo}" data-input="repo" placeholder="owner/repository" autocomplete="off" ${isBusy() ? 'disabled' : ''}></div>` : html`${!state.manualAccount ? html`<div class="field"><label for="pub-account">Cloudflare Account ID</label><input id="pub-account" class="input mono" value="${state.accountId}" data-input="account" data-change="accountDone" placeholder="连接后自动读取" autocomplete="off" ${isBusy() ? 'disabled' : ''}></div>` : ''}<div class="field"><label for="pub-project">已有 Pages 项目</label><input id="pub-project" class="input" value="${state.project}" data-input="project" placeholder="仅手动更新时填写" autocomplete="off" ${isBusy() ? 'disabled' : ''}></div>`}
            ${state.targets?.needsAccountRead ? html`<p class="hint">账号列表读取受限，可检查 Account Settings → Read 和账号范围，或填写上方的 Account ID。</p>` : ''}
            ${state.targets?.truncated ? html`<p class="hint">列表未显示全部目标，可手动填写。</p>` : ''}
          </div></details>
          ${!gh && state.targets?.needsAccountRead && !state.accountId ? html`<p class="error-text">请检查账号读取权限和账号范围，或填写上方的 Account ID。</p>` : ''}
          <div class="publish-create-action"><span class="hint">${state.selectedTarget === 'new' ? '确认后会创建公开网页' : '将更新选定的网站'}</span><button type="button" class="btn pri" data-click="prepare" ${isBusy() || !canContinue || !accepted.length || !hasAccount ? 'disabled' : ''}>${state.busy ? html`<span class="spinner"></span>处理中…` : state.selectedTarget === 'new' ? '创建网页' : '更新网页'}</button></div>
        </section>
        ${preview ? html`<section class="panel publish-review"><div class="row"><h2 class="grow">确认${preview.target?.createRepo || preview.target?.createProject ? '创建' : '更新'}「${preview.name || state.pageName}」</h2><span class="badge">公开网页</span></div><p class="mono small publish-url">${preview.review?.predictedUrl || '网址由平台生成'}</p><p class="hint">${preview.files?.length || 0} 个文件 · ${bytes(preview.totalBytes || 0)} · ${fmtTarget(preview.target)}</p>${preview.review?.needsSourceChange ? html`<label class="check"><input type="checkbox" data-change="confirmed" ${state.confirmSourceChange ? 'checked' : ''}>确认切换 GitHub Pages 的发布来源</label>` : ''}<div class="publish-create-action"><span class="hint">核对名称、网址和文件后发布。</span><button type="button" class="btn pri" data-click="start" ${isBusy() || !canContinue || (preview.review?.needsSourceChange && !state.confirmSourceChange) ? 'disabled' : ''}>确认公开发布</button></div></section>` : ''}
        ${jobView()}
        <section class="publish-library" aria-labelledby="publish-created-title"><div class="row"><h2 id="publish-created-title" class="grow">已创建网页</h2><button type="button" class="btn ghost sm" data-click="refreshSites" ${isSiteBusy() ? 'disabled' : ''}>刷新列表</button></div>${state.sites.length ? html`<div class="publish-sites">${state.sites.map((site) => html`<article class="panel publish-site" data-key="${site.id}" data-site-id="${site.id}"><span class="publish-site-icon">${icon(site.provider === 'github' ? 'github' : 'cloud', 20)}</span><div class="grow"><h3>${site.name}</h3>${site.status === 'live' && safeUrl(site.url) ? html`<a class="publish-site-url" href="${safeUrl(site.url)}" target="_blank" rel="noopener">${site.url}</a>` : html`<p class="hint">${site.status === 'building' ? '正在构建，完成后显示网址' : site.error || '等待发布完成'}</p>`}<p class="hint publish-site-platform">${site.provider === 'github' ? 'GitHub Pages' : 'Cloudflare Pages'}</p></div><span class="badge ${site.status === 'live' ? 'ok' : ''}">${site.status === 'live' ? '已上线' : site.status === 'building' ? '构建中' : '失败'}</span>${site.status === 'live' && safeUrl(site.url) ? html`<button type="button" class="btn ghost sm" data-click="copySite" data-id="${site.id}">复制网址</button>` : ''}${site.status === 'building' ? html`<button type="button" class="btn ghost sm" data-click="check" data-id="${site.id}" ${state.busy ? 'disabled' : ''}>检查进度</button>` : ''}<button type="button" class="btn ghost sm danger" data-click="deleteSite" data-id="${site.id}" aria-label="删除网页 ${site.name}" ${isSiteBusy() ? 'disabled' : ''}>删除</button></article>`)}</div>` : html`<p class="publish-empty hint">创建的网页会保存在这里，方便查看和管理。</p>`}</section>
      </div>`);
    }

    async function prepare() {
      if (isBusy()) return;
      if (!state.tokenId) throw new Error('请先连接账号或选择保险箱访问令牌');
      if (!state.pageName.trim()) throw new Error('请为网页填写一个名称');
      if (!state.siteName) state.siteName = suggestedName();
      if (!state.publishReady || connecting() || state.tokenId !== state.connection?.tokenId) throw new Error('请先连接账号并启用免解锁创建');
      const isGithub = state.provider === 'github';
      const publishTarget = siteTarget();
      if (isGithub && (state.selectedTarget === 'new' ? (!/^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/.test(state.siteName.trim()) || !state.connection?.profile?.login) : !/^[\w.-]+\/[\w.-]+$/.test(publishTarget.repo))) throw new Error('请检查网站名称：使用小写字母、数字或中划线，最多 39 位；首尾不能是中划线');
      if (!isGithub && (!/^[a-f\d]{32}$/i.test(publishTarget.accountId) || !/^[a-z0-9](?:[a-z0-9-]{0,56}[a-z0-9])?$/.test(publishTarget.project))) throw new Error('请选择账号并检查项目名：使用小写字母、数字或中划线，首尾不能是中划线');
      const { accepted, excluded } = filesForRead();
      if (accepted.length > LIMIT_FILES) throw new Error(`最多发布 ${LIMIT_FILES} 个文件`);
      if (accepted.some((f) => f.size > LIMIT_FILE)) throw new Error('单个文件不能超过 5 MiB');
      const total = accepted.reduce((n, f) => n + f.size, 0);
      if (total > LIMIT_TOTAL) throw new Error('文件总量不能超过 20 MiB');
      if (!accepted.some((f) => f.path === 'index.html')) throw new Error('发布文件必须包含根目录 index.html；index.HTML 不会被当作入口文件');
      const origin = isGithub ? 'https://api.github.com' : 'https://api.cloudflare.com';
      const generation = state.generation, operation = connectionGeneration, provider = state.provider, tokenId = state.tokenId;
      state.busy = true; state.error = ''; render();
      try {
        const granted = await chrome.permissions.request({ origins: [`${origin}/*`] });
        if (!granted) throw new Error(`需要允许访问 ${isGithub ? 'api.github.com' : 'api.cloudflare.com'} 才能检查发布目标`);
        if (!active || generation !== state.generation) return;
        const files = await Promise.all(accepted.map(async (item) => ({ path: item.path, base64: await readBase64(item.file), size: item.size, type: item.type || 'application/octet-stream' })));
        if (!active || generation !== state.generation) return;
        const result = await call('publish.prepare', { provider, tokenId, name: state.pageName.trim(), target: publishTarget, files });
        if (!active || generation !== state.generation) return;
        state.preview = result; state.job = result; state.excluded = excluded;
        state.confirmSourceChange = false;
      } catch (e) { if (active && generation === state.generation) { if (e.code === 'PUBLISH_AUTH_REQUIRED') state.publishReady = false; state.error = e.message; } }
      finally { if (active && operation === connectionGeneration) { state.busy = false; render(); } }
    }

    async function start() {
      if (isBusy()) return;
      if (!state.preview?.id || state.preview.id !== state.job?.id) throw new Error('预览已失效，请重新检查');
      if (!state.publishReady || connecting() || state.preview.tokenId !== state.connection?.tokenId) throw new Error('连接已变化，请重新检查');
      if (state.preview.review?.needsSourceChange && !state.confirmSourceChange) throw new Error('请先确认切换 GitHub Pages 来源');
      const generation = state.generation, operation = connectionGeneration;
      state.busy = true; render();
      try {
        const job = await call('publish.start', { id: state.preview.id, confirmed: true, confirmSourceChange: state.confirmSourceChange });
        if (!active || generation !== state.generation) return;
        state.job = job;
        state.preview = null;
        updateTimer(); state.error = '';
      } catch (e) { if (active && generation === state.generation) { if (e.code === 'PUBLISH_AUTH_REQUIRED') state.publishReady = false; state.error = e.message; } }
      finally { if (active && operation === connectionGeneration) { state.busy = false; render(); } }
    }

    const unbind = bind(root, {
      files(e) {
        if (isBusy()) return;
        const list = [...(e.target.files || [])];
        const folder = e.target.hasAttribute('webkitdirectory');
        const items = list.map((file) => {
          let path = folder ? (file.webkitRelativePath || file.name).split('/').slice(1).join('/') : 'index.html';
          return { file, path, size: file.size, type: file.type };
        }).filter((f) => f.path);
        applyFiles(items, folder ? list[0]?.webkitRelativePath.split('/')[0] : list[0]?.name);
      },
      pickFile() { if (!isBusy()) root.querySelector('#pub-file')?.click(); },
      pickFolder() { if (!isBusy()) root.querySelector('#pub-folder')?.click(); },
      clearFiles() { if (isBusy()) return; invalidate(); state.files = []; state.filesLabel = ''; render(); },
      dragOver(e, el) { e.preventDefault(); if (isBusy()) return; if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'; el.dataset.dragging = 'true'; },
      dragLeave(e, el) { if (!el.contains(e.relatedTarget)) delete el.dataset.dragging; },
      async drop(e, el) {
        e.preventDefault(); delete el.dataset.dragging;
        if (isBusy()) return;
        const source = e.dataTransfer;
        const entries = [...(source?.items || [])].filter((item) => item.kind === 'file').map((item) => item.webkitGetAsEntry?.() || null);
        const files = [...(source?.files || [])];
        if (!entries.length && !files.length) return;
        const generation = state.generation, operation = connectionGeneration;
        state.dropping = true; state.error = ''; render();
        try {
          const items = await readDrop(entries, files);
          if (!active || generation !== state.generation) return;
          if (!items.length) throw new Error('没有找到可发布的文件');
          applyFiles(items, entries.length === 1 && entries[0]?.isDirectory ? entries[0].name : files.length === 1 ? files[0].name : '网站文件');
        } catch (error) { if (active && operation === connectionGeneration) state.error = error.message || '读取拖入的文件失败，请重新选择'; }
        finally { if (active && operation === connectionGeneration) { state.dropping = false; render(); } }
      },
      name(e) { state.pageName = e.target.value; if (!state.customSlug) state.siteName = suggestedName(); invalidate(); render(); },
      repo(e) { state.repo = e.target.value; state.selectedTarget = 'manual'; invalidate(); render(); },
      siteName(e) {
        state.customSlug = true;
        if (state.selectedTarget === 'new') state.siteName = e.target.value;
        else { state.selectedTarget = 'manual'; if (state.provider === 'github') state.repo = e.target.value; else state.project = e.target.value; }
        invalidate(); render();
      },
      target(e) {
        state.selectedTarget = e.target.value;
        if (state.selectedTarget !== 'manual') {
          const value = state.selectedTarget.startsWith('existing:') ? state.selectedTarget.slice(9) : '';
          if (state.provider === 'github') state.repo = value; else state.project = value;
        }
        if (state.selectedTarget === 'new' && !state.siteName) state.siteName = suggestedName();
        invalidate(); render();
      },
      async accountChoice(e) { state.accountId = e.target.value; state.project = ''; state.selectedTarget = 'new'; state.targets = null; invalidate(); render(); await loadTargets(); },
      account(e) { targetGeneration++; state.accountId = e.target.value; state.project = ''; state.selectedTarget = 'new'; state.targets = null; invalidate(); render(); },
      accountDone() { if (/^[a-f\d]{32}$/i.test(state.accountId.trim())) { state.accountId = state.accountId.trim(); loadTargets(); } },
      project(e) { state.project = e.target.value; state.selectedTarget = 'manual'; invalidate(); render(); },
      token(e) { targetGeneration++; state.tokenId = e.target.value; invalidate(); render(); },
      connect() { connect('open'); },
      reconnect() { connect('open'); },
      showPaste() { state.showPaste = true; render(); },
      saveToken() { connect('save', '#pub-connect-token'); },
      saveAdvancedToken() { connect('save', '#pub-connect-token-advanced'); },
      useToken() { connect('use'); },
      confirmed(e) { state.confirmSourceChange = e.target.checked; render(); },
      async refreshVault() { if (isBusy()) return; state.error = ''; await loadVault(); await loadConnection(true); },
      refreshSites() { if (!isSiteBusy()) { loadJob(); loadSites(); } },
      deleteSite(e, el) { return removePage(el.dataset.id); },
      copySite(e, el) { return copySite(el.dataset.id); },
      authorizeCreate() { return authorizeCreate(); },
      prepare() { prepare().catch((e) => { state.error = e.message; state.busy = false; render(); }); },
      start() { start().catch((e) => { state.error = e.message; state.busy = false; render(); }); },
      async check(e, el) {
        if (state.busy) return;
        const site = state.sites.find((row) => row.id === el.dataset.id);
        if (!site && !state.job?.id) return;
        const operation = connectionGeneration;
        state.busy = true; render();
        try {
          if (site) {
            await call('publish.siteCheck', { id: site.id, ...(site.provider === state.provider && state.connection ? { tokenId: state.connection.tokenId } : {}) });
            if (!active || operation !== connectionGeneration) return;
            state.job = await call('publish.status');
          } else state.job = await call('publish.check', { id: state.job.id });
          if (active && operation === connectionGeneration) { state.error = ''; updateTimer(); await loadSites(); }
        } catch (e) { if (active && operation === connectionGeneration) state.error = e.message; }
        finally { if (active && operation === connectionGeneration) { state.busy = false; render(); } }
      },
      async retry() { invalidate(); state.job = null; await prepare().catch((e) => { state.error = e.message; state.busy = false; render(); }); },
      async clear() {
        if (!state.job?.id) return;
        state.busy = true; render();
        try { await call('publish.clear', { id: state.job.id }); invalidate(); state.job = null; state.error = ''; updateTimer(); }
        catch (e) { state.error = e.message; }
        finally { state.busy = false; render(); }
      },
    });

    void (async () => { await loadVault(); await loadConnection(); if (active) await loadJob(); })();
    const connectionTimer = setInterval(() => { if (!document.hidden && !isBusy() && connecting()) loadConnection(); }, 2000);
    const onVisibility = () => { if (!document.hidden && !isBusy()) { loadConnection(); loadSites(); } };
    const dropGuard = (e) => { if ([...(e.dataTransfer?.types || [])].includes('Files')) e.preventDefault(); };
    root.addEventListener('dragover', dropGuard);
    root.addEventListener('drop', dropGuard);
    document.addEventListener('visibilitychange', onVisibility);
    return {
      update(route) {
        const next = route.parts[0] === 'cloudflare' ? 'cloudflare' : 'github';
        if (next !== state.provider) { connectionGeneration++; connectionRequest++; state.busy = false; state.dropping = false; state.provider = next; state.connection = null; state.publishReady = false; state.pending = null; resetTargets(); state.tokenId = ''; state.siteName = ''; state.customSlug = false; invalidate(); state.error = ''; loadConnection(); }
        loadJob(); render();
      },
      unmount() { active = false; state.generation++; connectionGeneration++; sitesRequest++; clearInterval(state.timer); clearInterval(connectionTimer); document.removeEventListener('visibilitychange', onVisibility); root.removeEventListener('dragover', dropGuard); root.removeEventListener('drop', dropGuard); unbind(); },
    };
  },
};
