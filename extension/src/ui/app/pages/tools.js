// 工具页：工具开关、签到助手（任务列表 + 新建/编辑 + 页面点选）、导入的技能包。

import { html, morph, bind, scheduler, debounce } from '../../kit/dom.js';
import { icon } from '../../kit/icons.js';
import { toast, toastError, modal, confirmBox, openMenu, pickFile, hasSite } from '../../kit/ui.js';
import { call, onChange, onNotice } from '../../../shared/client.js';
import { formatWhen, formatClock, domainOf, isWebUrl, coerceUrl, originOf, todayKey, siteMatches, splitTitle, normalizeUrl } from '../../../shared/util.js';

const STATUS = {
  ok: ['成功', 'ok'],
  already: ['今天已签过', 'ok'],
  'need-login': ['需要登录', 'warn'],
  locked: ['保险箱已锁定', 'warn'],
  challenge: ['需要人工验证', 'warn'],
  'not-found': ['找不到按钮', 'danger'],
  failed: ['没有确认成功', 'danger'],
  'no-permission': ['没有网站权限', 'warn'],
  error: ['打开失败', 'danger'],
  skipped: ['已跳过', ''],
  running: ['正在运行', ''],
};
const PROBLEM = (st) => !!st && !['ok', 'already', 'skipped', 'running'].includes(st);
const LEARNED = { keyword: '按文字', recipe: '论坛签到页', ai: 'AI', learned: '记住的做法' };

const urlKey = (u) => {
  try {
    return normalizeUrl(u);
  } catch {
    return String(u);
  }
};

/** 粘贴的文字里每行找一个网址；网址前后的文字当作名称。没有协议的域名补上 https://。 */
function parsePaste(text) {
  const out = [];
  const seen = new Set();
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = line.match(/https?:\/\/[^\s，,]+/i) || line.match(/(?:^|\s)((?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d{2,5})?(?:\/[^\s，,]*)?)/i);
    if (!m) continue;
    const raw = (m[1] || m[0]).trim();
    const url = coerceUrl(raw);
    if (!isWebUrl(url)) continue;
    const key = urlKey(url);
    if (seen.has(key)) continue;
    seen.add(key);
    const name = line.replace(m[0], ' ').replace(/[|｜,，\t]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/^[-–—:：]+|[-–—:：]+$/g, '').trim();
    out.push({ url, name: name.slice(0, 80) });
  }
  return out;
}

const TIMES = ['', '06:00', '07:00', '08:00', '09:00', '10:00', '12:00', '14:00', '18:00', '20:00', '22:00'];

function emptyForm(url = '', name = '') {
  return {
    id: null,
    name,
    url,
    mode: 'auto',
    target: { selector: '', text: '' },
    success: { type: 'auto', value: '', selector: '' },
    login: { mode: 'auto', entryId: null },
    allowAi: true,
    enabled: true,
    learned: null,
    forget: false,
    err: '',
    pickToken: null,
    pickMode: null,
  };
}

export default {
  title: '工具',
  mount(root, ctx) {
    const state = {
      tasks: [],
      perm: {},
      logins: [],
      lastAuto: null,
      form: null,
      loaded: false,
      batch: null,
      filter: 'all',
    };
    const render = scheduler(draw);
    const settings = () => ctx.store.settings;
    const view = () => (ctx.route.parts[0] === 'checkin' ? 'checkin' : 'grid');

    async function load() {
      const [tasks, logins, lastAuto, batch] = await Promise.all([call('tasks.list'), call('vault.list'), call('tasks.lastAuto'), call('tasks.batch').catch(() => null)]);
      state.tasks = tasks;
      state.logins = logins.filter((i) => i.kind === 'login');
      state.lastAuto = lastAuto;
      state.batch = batch;
      const perm = {};
      await Promise.all(
        tasks.map(async (t) => {
          const origins = t.kind === 'skill' ? t.sites || [] : [originOf(t.url)];
          perm[t.id] = (await Promise.all(origins.map((o) => hasSite(o)))).every(Boolean);
        }),
      );
      state.perm = perm;
      state.loaded = true;
      if (view() === 'checkin' && batch && !batch.running) call('tasks.batchSeen').catch(() => {});
      render();
    }
    // 批量签到时每完成一个网站都会广播一次，合并成一次刷新
    const reload = debounce(() => load().catch(() => {}), 400);

    function openFromRoute(route) {
      const url = route.query.get('new');
      if (route.parts[0] === 'checkin' && url && !state.form) {
        state.form = emptyForm(url, route.query.get('name') ? route.query.get('name') + ' 签到' : '');
        history.replaceState(null, '', '#/tools/checkin');
      }
      render();
    }

    // ───────── 工具总览 ─────────

    function toolCard({ key, ic, name, desc, status, open, sw = true }) {
      const on = !!settings().tools[key];
      return html`<article class="tool-card">
        <div class="head"><span class="ticon">${icon(ic, 20)}</span>
          <div class="grow"><h3>${name}</h3><span class="small muted">内置</span></div>
          ${sw ? html`<button type="button" class="switch" role="switch" aria-checked="${on ? 'true' : 'false'}" aria-label="启用${name}" data-click="toggleTool" data-k="${key}"></button>` : ''}
        </div>
        <p>${desc}</p>
        <div class="foot"><span class="grow">${status}</span>${open ? html`<button type="button" class="btn sm" data-click="${open}">打开</button>` : ''}</div>
      </article>`;
    }

    function gridView() {
      const s = settings();
      const checkins = state.tasks.filter((t) => t.kind === 'checkin');
      const skills = state.tasks.filter((t) => t.kind === 'skill');
      const ranToday = state.lastAuto?.day === todayKey();
      const ckStatus = !s.tools.checkin
        ? '已关闭，不会自动运行'
        : `${checkins.length} 个任务，${s.checkin.time ? (ranToday ? `今天 ${formatClock(state.lastAuto.at)} 已运行` : `每天 ${s.checkin.time} 运行`) : '只手动运行'}`;
      return html`<div class="page">
        <div class="page-head"><h1>工具</h1>
          <button type="button" class="btn" data-click="importSkill">${icon('fileUp', 16)}导入技能包</button></div>
        <p class="page-sub" style="margin-top:-12px">按需开启。每个工具只在用到时，才申请对应网站的访问权限。</p>
        <section class="col" style="gap:12px" aria-labelledby="h-installed">
          <h2 id="h-installed" class="section-title">已安装</h2>
          <div class="tool-grid">
            ${toolCard({ key: 'checkin', ic: 'calendarCheck', name: '签到助手', desc: '批量添加要签到的网站，一键全部签到：自动找签到按钮并确认成功，找不到时交给 AI，学会后下次直接点。需要登录时用保险箱里的账号。', status: ckStatus, open: 'openCheckin' })}
            ${toolCard({ key: 'clip', ic: 'scissors', name: '网页摘录', desc: '在网页上选中文字后右键，存成一条笔记，并记下来源网址。', status: s.tools.clip ? '右键菜单已添加' : '已关闭' })}
            ${toolCard({ key: 'autoCollect', ic: 'bookmark', name: '自动收录 Chrome 书签', desc: '用 Chrome 自带的星标收藏网页时，同时存一份到这里。', status: s.tools.autoCollect ? '正在收录新增书签' : '已关闭' })}
            ${toolCard({ key: 'io', ic: 'download', name: '导入与导出', desc: '从 Chrome 或书签文件导入，导出为浏览器通用的书签文件，或者完整备份。', status: '在设置里', open: 'openImport', sw: false })}
          </div>
        </section>
        <section class="col" style="gap:12px" aria-labelledby="h-publish">
          <h2 id="h-publish" class="section-title">网页发布</h2>
          <div class="tool-grid">
            <article class="tool-card"><div class="head"><span class="ticon">${icon('github', 20)}</span><h3 class="grow">部署到 GitHub Pages</h3><span class="badge">可用</span></div>
              <p>连接账号后，选择文件和网站即可发布。凭证加密存入保险箱，新网站自动创建公开仓库。</p><div class="foot"><span class="grow"></span><a class="btn sm" href="#/publish/github">打开</a></div></article>
            <article class="tool-card"><div class="head"><span class="ticon">${icon('cloud', 20)}</span><h3 class="grow">部署到 Cloudflare Pages</h3><span class="badge">可用</span></div>
              <p>连接账号后自动读取 Pages 网站，选择或新建后发布。凭证加密保存在保险箱。</p><div class="foot"><span class="grow"></span><a class="btn sm" href="#/publish/cloudflare">打开</a></div></article>
          </div>
        </section>
        <section class="col" style="gap:12px" aria-labelledby="h-skill">
          <h2 id="h-skill" class="section-title">导入的技能包</h2>
          ${skills.length
            ? html`<table class="table"><thead><tr><th scope="col">技能包</th><th scope="col">会访问</th><th scope="col">上次运行</th><th scope="col"><span class="sr">操作</span></th></tr></thead><tbody>
                ${skills.map((t) => html`<tr data-key="${t.id}">
                  <td><div class="name">${t.name}</div><div class="small muted">${t.description || (t.schedule === 'daily' ? '每天跟签到助手一起运行' : '只手动运行')}</div></td>
                  <td class="small">${(t.sites || []).map((o) => domainOf(o)).join('、')}</td>
                  <td>${runCell(t)}</td>
                  <td><div class="row" style="justify-content:flex-end">
                    <button type="button" class="switch" role="switch" aria-checked="${t.enabled ? 'true' : 'false'}" aria-label="启用${t.name}" data-click="toggleSkill" data-id="${t.id}"></button>
                    <button type="button" class="btn sm" data-click="run" data-id="${t.id}" ${t.running ? 'disabled' : ''}>${t.running ? html`<span class="spinner"></span>` : '运行'}</button>
                    <button type="button" class="icon-btn sm" data-click="taskMore" data-id="${t.id}" aria-label="${t.name} 的更多操作">${icon('more', 15)}</button></div></td>
                </tr>`)}
              </tbody></table>`
            : html`<div class="empty" style="padding:24px"><p>还没有导入技能包。技能包是一份步骤清单，只能打开网页、等待、点击和检查文字，读不到你的保险箱，导入后默认关闭。</p>
                <button type="button" class="btn" data-click="importSkill">${icon('fileUp', 16)}选择文件</button></div>`}
        </section>
      </div>`;
    }

    // ───────── 签到助手 ─────────

    function runCell(t) {
      const r = t.lastRun;
      if (t.running) return html`<span class="row small" style="gap:6px"><span class="spinner"></span>正在运行</span>`;
      if (!r) return html`<span class="small faint">还没运行过</span>`;
      const [text, tone] = STATUS[r.status] || [r.status, ''];
      const today = r.day === todayKey();
      return html`<span class="row small" style="gap:6px" title="${r.message}"><span class="dot ${tone}"></span>${today ? formatClock(r.at) : formatWhen(r.at)} ${text}</span>`;
    }

    function loginLabel(t) {
      if (t.login?.mode === 'auto') return '自动匹配保险箱账号';
      if (t.login?.mode !== 'vault') return '不自动登录';
      const e = state.logins.find((l) => l.id === t.login.entryId);
      return e ? '保险箱：' + e.name : '保险箱：账号已删除';
    }

    function modeLabel(t) {
      if (t.mode !== 'auto') return '手动点选';
      if (t.learned?.steps?.length) return '自动识别 · 已学会（' + (LEARNED[t.learned.how] || '自动') + '）';
      return '自动识别';
    }

    function batchPanel() {
      const b = state.batch;
      if (!b || !b.total) return '';
      let ok = 0;
      let already = 0;
      let skipped = 0;
      for (const i of b.items) {
        if (i.status === 'ok') ok++;
        else if (i.status === 'already') already++;
        else if (i.status === 'skipped') skipped++;
      }
      const runningItems = b.items.filter((i) => i.state === 'running');
      const problems = b.items.filter((i) => i.state === 'done' && PROBLEM(i.status));
      const title = b.running ? (b.stopping ? '正在停止，等手上的网站做完…' : `正在签到 ${b.done} / ${b.total}`) : b.interrupted ? '上一轮签到被中断了' : `签到完成 · ${formatClock(b.finishedAt)}`;
      return html`<section class="ck-batch ${b.running ? 'is-running' : ''}" aria-labelledby="ck-batch-h">
        <div class="ck-batch-head">
          <div class="grow col" style="gap:4px"><b id="ck-batch-h">${title}</b>
            <div class="ck-batch-counts"><span><span class="dot ok"></span>成功 ${ok}</span><span><span class="dot ok"></span>今天已签 ${already}</span><span><span class="dot ${problems.length ? 'warn' : ''}"></span>需要处理 ${problems.length}</span>${skipped ? html`<span><span class="dot"></span>跳过 ${skipped}</span>` : ''}</div></div>
          ${b.running
            ? html`<button type="button" class="btn sm" data-click="stopBatch" ${b.stopping ? 'disabled' : ''}>${icon('pause', 14)}停止</button>`
            : problems.length
              ? html`<button type="button" class="btn sm pri" data-click="retryProblems">${icon('play', 14)}重试这 ${problems.length} 个</button>`
              : ''}
        </div>
        <div class="ck-progress" role="progressbar" aria-label="签到进度" aria-valuemin="0" aria-valuemax="${b.total}" aria-valuenow="${b.done}"><span style="transform:scaleX(${(b.done / b.total).toFixed(4)})"></span></div>
        ${runningItems.length ? html`<ul class="ck-live" aria-label="正在签到">${runningItems.map((i) => html`<li data-key="r-${i.id}"><span class="spinner"></span><span class="grow ellipsis">${i.name}</span><span class="small muted">${domainOf(i.url)}</span></li>`)}</ul>` : ''}
        ${problems.length
          ? html`<ul class="ck-problems" aria-label="需要处理">${problems.map((i) => {
              const [text, tone] = STATUS[i.status] || [i.status, 'warn'];
              return html`<li data-key="p-${i.id}">
                <span class="dot ${tone}"></span>
                <div class="grow col" style="gap:2px;min-width:0"><span class="row" style="gap:8px"><b class="ellipsis">${i.name}</b><span class="badge ${tone === 'danger' ? 'danger' : 'warn'}">${text}</span></span><span class="small muted ck-msg">${i.message}</span></div>
                <div class="row" style="gap:6px;flex:none">
                  ${i.status === 'no-permission' ? html`<button type="button" class="btn sm outline" data-click="grant" data-id="${i.id}">授权</button>` : ''}
                  ${i.status === 'locked' ? html`<a class="btn sm" href="#/vault">解锁保险箱</a>` : ''}
                  ${i.status === 'need-login' && /保险箱里没有/.test(i.message) ? html`<a class="btn sm" href="#/vault">添加账号</a>` : ''}
                  <button type="button" class="btn sm" data-click="openUrl" data-url="${i.url}">${icon('external', 14)}打开网页</button>
                  <button type="button" class="btn sm" data-click="run" data-id="${i.id}" ${state.tasks.find((t) => t.id === i.id)?.running || b.running ? 'disabled' : ''}>重试</button>
                </div></li>`;
            })}</ul>`
          : ''}
      </section>`;
    }

    function formView() {
      const f = state.form;
      const logins = [...state.logins].sort((a, b) => (siteMatches(b.site, f.url) ? 1 : 0) - (siteMatches(a.site, f.url) ? 1 : 0));
      const aiReady = !!settings().ai?.entryId;
      const picking = f.pickToken ? f.pickMode : null;
      return html`<section class="panel col" style="gap:18px" aria-labelledby="h-new" id="task-form">
        <div class="row"><h2 id="h-new" class="grow" style="font-size:17px">${f.id ? '编辑签到任务' : '新建签到任务'}</h2>
          <button type="button" class="icon-btn" data-click="closeForm" aria-label="关闭">${icon('x', 18)}</button></div>
        <ol class="steps">
          <li><span class="step-no">1</span><div class="col" style="gap:10px">
            <div class="field"><label for="ck-url">签到页网址</label><input id="ck-url" class="input" value="${f.url}" data-input="fUrl" placeholder="https://" autocomplete="off"></div>
            <div class="field"><label for="ck-name">任务名称</label><input id="ck-name" class="input" value="${f.name}" data-input="fName" placeholder="${f.url ? domainOf(coerceUrl(f.url)) + ' 签到' : '比如：V2EX 每日任务'}" autocomplete="off"></div>
            <span class="hint">也可以在收藏卡片的菜单里选「加入签到」，网址会自动带过来。</span></div></li>
          <li><span class="step-no">2</span><div class="col" style="gap:12px">
            <fieldset class="col" style="gap:4px;border:0;padding:0;margin:0"><legend class="label" style="margin-bottom:6px">怎么找签到按钮</legend>
              <label class="rule-option"><input type="radio" name="mode" value="auto" data-change="fMode" ${f.mode === 'auto' ? 'checked' : ''}><span class="col" style="gap:2px"><span>自动识别（推荐）</span><span class="hint">按「签到、打卡、领取奖励」等文字和常见论坛的签到页去找，点完自动判断是否成功；找不到时交给 AI。成功一次就记住做法，下次直接点。</span></span></label>
              <label class="rule-option"><input type="radio" name="mode" value="picked" data-change="fMode" ${f.mode !== 'auto' ? 'checked' : ''}>到页面上点选按钮，自己设定怎么算成功</label>
            </fieldset>
            ${f.mode === 'auto' && f.learned?.steps?.length
              ? html`<div class="picked ck-learned">${icon('check', 16)}<span class="grow">${f.forget ? '保存后，下次运行会重新找签到入口' : `已经记住做法（${LEARNED[f.learned.how] || '自动'}，${f.learned.steps.length} 步，${formatWhen(f.learned.at)}学会）`}</span>
                  <button type="button" class="btn sm" data-click="fForget">${f.forget ? '还是用记住的' : '忘掉，下次重新找'}</button></div>`
              : ''}
            ${f.mode === 'auto' ? '' : html`<div class="col ck-picked" style="gap:10px"><span class="label">签到按钮</span>
            ${f.target.selector || f.target.text
              ? html`<div class="picked">${icon('check', 16)}<span class="grow">已选中页面上的${f.target.text ? html`「<b>${f.target.text}</b>」` : '一个'}按钮</span>
                  <button type="button" class="btn sm" data-click="pick" data-mode="target">${picking === 'target' ? html`<span class="spinner"></span>等你点选…` : '重新点选'}</button></div>`
              : html`<div class="row wrap"><button type="button" class="btn outline" data-click="pick" data-mode="target">${picking === 'target' ? html`<span class="spinner"></span>等你在网页上点选…` : html`${icon('target', 16)}到页面上点选`}</button>
                  <span class="hint">会打开签到页，鼠标移到按钮上点一下就记住了。</span></div>`}
            <details class="adv"><summary>手动填写选择器</summary><div>
              <div class="field"><label for="ck-sel">CSS 选择器</label><input id="ck-sel" class="input mono" value="${f.target.selector}" data-input="fSel" autocomplete="off"></div>
              <div class="field"><label for="ck-text">按钮文字（选择器失效时按文字找）</label><input id="ck-text" class="input" value="${f.target.text}" data-input="fText" autocomplete="off"></div></div></details>
          <fieldset class="col" style="gap:4px;border:0;padding:0;margin:0"><legend class="label" style="margin-bottom:6px">怎么算签到成功</legend>
            <label class="rule-option"><input type="radio" name="ok" value="gone" data-change="fRule" ${f.success.type === 'gone' ? 'checked' : ''}>点过的按钮消失或变灰</label>
            <label class="rule-option"><input type="radio" name="ok" value="text" data-change="fRule" ${f.success.type === 'text' ? 'checked' : ''}>页面出现文字
              <input class="input" aria-label="成功时出现的文字" value="${f.success.value && f.success.type === 'text' ? f.success.value : ''}" data-input="fRuleText" placeholder="比如：已成功领取" ${f.success.type === 'text' ? '' : 'disabled'}></label>
            <label class="rule-option"><input type="radio" name="ok" value="element" data-change="fRule" ${f.success.type === 'element' ? 'checked' : ''}>页面上出现某个地方
              ${f.success.type === 'element' ? html`<button type="button" class="btn sm" data-click="pick" data-mode="success">${picking === 'success' ? html`<span class="spinner"></span>等你点选…` : f.success.selector ? '已选好，重新点选' : '到页面上点选'}</button>` : ''}</label>
            <label class="rule-option"><input type="radio" name="ok" value="url" data-change="fRule" ${f.success.type === 'url' ? 'checked' : ''}>网址里出现
              <input class="input" aria-label="成功后网址里出现的内容" value="${f.success.type === 'url' ? f.success.value : ''}" data-input="fRuleUrl" placeholder="比如：/success" ${f.success.type === 'url' ? '' : 'disabled'}></label>
          </fieldset>
          <label class="check"><input type="checkbox" data-change="fAi" ${f.allowAi ? 'checked' : ''}>按钮找不到时，按自动识别再找一遍（包括 AI）</label></div>`}
          </div></li>
          <li><span class="step-no">3</span><div class="field"><label for="ck-login">需要登录时</label>
            <select id="ck-login" class="select" data-change="fLogin">
              <option value="__auto" ${f.login.mode === 'auto' ? 'selected' : ''}>自动使用保险箱里这个网站的账号（只有一个时）</option>
              <option value="" ${f.login.mode !== 'vault' && f.login.mode !== 'auto' ? 'selected' : ''}>不登录，未登录就跳过</option>
              ${logins.map((l) => html`<option value="${l.id}" ${f.login.mode === 'vault' && f.login.entryId === l.id ? 'selected' : ''}>使用保险箱里的「${l.name}」${l.site ? `（${l.site}）` : ''}</option>`)}
            </select>
            <span class="hint">${state.logins.length ? '自动登录要求保险箱是解锁状态；锁着的时候这个任务会跳过，并提示你。' : html`保险箱里还没有网站登录。<a href="#/vault">去保险箱添加</a>`}</span></div></li>
        </ol>
        ${aiReady ? '' : html`<p class="hint">还没有设置 AI 接口，规则找不到时就没有 AI 兜底。在保险箱新建一条「密钥和令牌」，展开「这是一个 AI 接口」填好地址和模型，再勾选「给签到助手用」。</p>`}
        ${f.err ? html`<p class="error-text" role="alert">${f.err}</p>` : ''}
        <div class="row" style="justify-content:flex-end"><button type="button" class="btn" data-click="closeForm">取消</button><button type="button" class="btn pri" data-click="saveForm">保存任务</button></div>
      </section>`;
    }

    function checkinView() {
      const s = settings();
      const tasks = state.tasks.filter((t) => t.kind === 'checkin');
      const today = todayKey();
      const batchRunning = !!state.batch?.running;
      const times = TIMES.includes(s.checkin.time) ? TIMES : [...TIMES, s.checkin.time];
      const noPerm = tasks.filter((t) => state.perm[t.id] === false);
      const aiReady = !!s.ai?.entryId;
      const vaultLocked = ctx.store.vault?.exists && !ctx.store.vault?.unlocked;
      const problems = tasks.filter((t) => t.lastRun && PROBLEM(t.lastRun.status));
      const todo = tasks.filter((t) => t.enabled && !(t.lastRun && t.lastRun.day === today && t.lastRun.ok));
      const shown = state.filter === 'problem' ? problems : state.filter === 'todo' ? todo : tasks;
      return html`<div class="page">
        <div class="page-head">
          <button type="button" class="btn ghost sm" data-click="backTools">${icon('chevronLeft', 16)}工具</button>
          <h1 style="flex:1">签到助手</h1>
          <button type="button" class="btn" data-click="batchAdd">${icon('plus', 16)}批量添加</button>
          <button type="button" class="btn ghost" data-click="newTask">单个添加</button>
          <button type="button" class="btn pri" data-click="runAll" ${batchRunning || !tasks.length ? 'disabled' : ''}>${batchRunning ? html`<span class="spinner"></span>正在签到…` : html`${icon('play', 14)}一键全部签到`}</button>
        </div>
        ${!s.tools.checkin ? html`<div class="notice warn">${icon('alert', 16)}<span class="grow">签到助手已关闭，任务不会自动运行。</span><button type="button" class="btn sm" data-click="toggleTool" data-k="checkin">打开</button></div>` : ''}
        ${noPerm.length ? html`<div class="notice warn">${icon('alert', 16)}<span class="grow">${noPerm.length} 个网站还没有授权访问，签到时会跳过。</span><button type="button" class="btn sm" data-click="grantAll">一键授权</button></div>` : ''}
        ${vaultLocked && (aiReady || tasks.some((t) => t.login?.mode !== 'none')) ? html`<div class="notice">${icon('lock', 16)}<span class="grow">保险箱锁着：需要登录的网站和 AI 兜底这次都用不了。</span><a class="btn sm" href="#/vault">解锁</a></div>` : ''}
        ${batchPanel()}
        <div class="ck-settings">
          <label>每天自动签到 <select class="select" data-change="ckTime">${times.map((t) => html`<option value="${t}" ${s.checkin.time === t ? 'selected' : ''}>${t || '不自动运行'}</option>`)}</select></label>
          <label>一次签 <select class="select" data-change="ckConc">${[1, 2, 3, 4, 5].map((n) => html`<option value="${n}" ${Number(s.checkin.concurrency) === n ? 'selected' : ''}>${n} 个网站</option>`)}</select></label>
          <span class="ck-ai row" style="gap:8px"><button type="button" class="switch" role="switch" aria-checked="${aiReady && s.checkin.ai !== false ? 'true' : 'false'}" aria-label="找不到时交给 AI" data-click="ckAi" ${aiReady ? '' : 'disabled'}></button>找不到时交给 AI</span>
          <span class="small muted grow" style="min-width:240px">${aiReady ? '在单独的最小化窗口里运行；电脑开机且浏览器打开时才会自动签到，错过的时间会在下次开机后补跑。' : html`还没有设置 AI 接口。<a href="#/vault">去保险箱设置</a>后，规则找不到的网站会交给 AI。`}</span>
        </div>
        ${state.form ? formView() : ''}
        ${tasks.length
          ? html`<div class="row wrap" style="gap:8px"><div class="seg" role="radiogroup" aria-label="筛选">
                ${[['all', `全部 ${tasks.length}`], ['problem', `需要处理 ${problems.length}`], ['todo', `今天未签 ${todo.length}`]].map(([k, t]) => html`<button type="button" role="radio" aria-checked="${state.filter === k ? 'true' : 'false'}" data-click="filter" data-k="${k}">${t}</button>`)}
              </div></div>
            ${shown.length
              ? html`<table class="table ck-table"><thead><tr><th scope="col">网站</th><th scope="col">方式</th><th scope="col">最近一次</th><th scope="col"><span class="sr">操作</span></th></tr></thead><tbody>
              ${shown.map((t) => html`<tr data-key="${t.id}">
                <td><div class="name">${splitTitle(t.name, t.url).main}${!t.enabled ? html` <span class="badge">已停用</span>` : ''}</div><div class="small muted">${domainOf(t.url)}</div></td>
                <td class="small"><div>${modeLabel(t)}</div>${t.login?.mode === 'auto' ? '' : html`<div class="muted">${loginLabel(t)}</div>`}</td>
                <td>${runCell(t)}${t.lastRun && PROBLEM(t.lastRun.status) ? html`<div class="small muted ck-msg" style="max-width:340px;line-height:1.5;margin-top:2px">${t.lastRun.message}</div>` : ''}</td>
                <td><div class="row" style="justify-content:flex-end">
                  ${state.perm[t.id] === false ? html`<button type="button" class="btn sm outline" data-click="grant" data-id="${t.id}">授权</button>` : ''}
                  ${t.lastRun?.status === 'locked' ? html`<a class="btn sm" href="#/vault">解锁保险箱</a>` : ''}
                  <button type="button" class="btn sm" data-click="run" data-id="${t.id}" ${t.running || batchRunning ? 'disabled' : ''}>${t.running ? html`<span class="spinner"></span>` : '运行'}</button>
                  <button type="button" class="icon-btn sm" data-click="taskMore" data-id="${t.id}" aria-label="${t.name} 的更多操作">${icon('more', 15)}</button></div></td>
              </tr>`)}
            </tbody></table>`
              : html`<p class="muted small" style="padding:8px 2px">${state.filter === 'problem' ? '没有需要处理的网站。' : '今天的都签完了。'}</p>`}`
          : !state.form
            ? html`<div class="empty"><h2>还没有签到网站</h2><p>批量添加你要签到的网站：粘贴网址、从收藏分组里选，或者直接用现在打开的标签页。插件会自己找签到按钮，找不到时交给 AI，成功一次就记住做法。</p>
                <div class="row wrap"><button type="button" class="btn pri" data-click="batchAdd">${icon('plus', 16)}批量添加</button><button type="button" class="btn" data-click="newTask">单个添加</button></div></div>`
            : ''}
      </div>`;
    }

    // ───────── 批量添加 ─────────

    function batchAddDialog() {
      const groups = ctx.store.groups || [];
      const bookmarks = ctx.store.bookmarks || [];
      const existing = new Set(state.tasks.filter((t) => t.kind === 'checkin').map((t) => urlKey(t.url)));
      const st = { src: 'paste', text: '', groupId: groups[0]?.id || '__fav', picked: new Set(), tabs: [], login: true, err: '' };
      let box = null;
      const groupItems = () => {
        const list = st.groupId === '__fav' ? bookmarks.filter((b) => b.favorite) : bookmarks.filter((b) => (b.groupId || '') === st.groupId);
        return list.filter((b) => isWebUrl(b.url)).map((b) => ({ url: b.url, name: splitTitle(b.title, b.url).main }));
      };
      const pickAll = (list) => {
        st.picked = new Set(list.filter((i) => !existing.has(urlKey(i.url))).map((i) => i.url));
      };
      const items = () => (st.src === 'paste' ? parsePaste(st.text) : (st.src === 'group' ? groupItems() : st.tabs).filter((i) => st.picked.has(i.url)));
      const listView = (list) => {
        const selectable = list.filter((i) => !existing.has(urlKey(i.url)));
        const picked = selectable.filter((i) => st.picked.has(i.url)).length;
        return list.length
          ? html`<div class="ba-tools"><span class="small muted grow">已选 ${picked} / ${selectable.length}${list.length > selectable.length ? `（${list.length - selectable.length} 个已在签到列表里）` : ''}</span>
              <button type="button" class="btn sm ghost" data-click="baAll" ${picked === selectable.length ? 'disabled' : ''}>全选</button>
              <button type="button" class="btn sm ghost" data-click="baNone" ${picked ? '' : 'disabled'}>全不选</button></div>
            <ul class="ba-list">${list.map((i) => {
              const dup = existing.has(urlKey(i.url));
              return html`<li><label class="check"><input type="checkbox" data-change="baPick" data-url="${i.url}" ${st.picked.has(i.url) ? 'checked' : ''} ${dup ? 'disabled' : ''}><span class="grow col" style="gap:1px;min-width:0"><span class="ellipsis">${i.name || domainOf(i.url)}</span><span class="small muted ellipsis">${domainOf(i.url)}${dup ? ' · 已在签到列表里' : ''}</span></span></label></li>`;
            })}</ul>`
          : html`<p class="muted small" style="padding:12px 0">${st.src === 'tabs' ? '没有打开的网页。' : '这个分组里没有收藏。'}</p>`;
      };
      const currentList = () => (st.src === 'group' ? groupItems() : st.src === 'tabs' ? st.tabs : []);
      const body = () => {
        const list = items();
        const fresh = list.filter((i) => !existing.has(urlKey(i.url)));
        const dups = list.length - fresh.length;
        return html`<div class="col" style="gap:14px">
          <div class="seg" role="radiogroup" aria-label="从哪里添加" data-roving="off">
            ${[['paste', '粘贴网址'], ['group', '从收藏分组选'], ['tabs', '当前打开的网页']].map(([k, t]) => html`<button type="button" role="radio" aria-checked="${st.src === k ? 'true' : 'false'}" data-click="baSrc" data-k="${k}">${t}</button>`)}
          </div>
          ${st.src === 'paste'
            ? html`<div class="field"><label for="ba-text">每行一个网址，前后可以写名称</label>
                <textarea id="ba-text" class="textarea mono" rows="8" data-input="baText" placeholder="https://www.v2ex.com/mission/daily\nNodeSeek https://www.nodeseek.com\nlinux.do">${st.text}</textarea>
                <span class="hint">可以直接填签到页的网址，也可以只填首页，插件会自己找签到入口。</span></div>`
            : st.src === 'group'
              ? html`<div class="col" style="gap:8px"><select class="select" data-change="baGroup" aria-label="选择分组">
                  <option value="__fav" ${st.groupId === '__fav' ? 'selected' : ''}>星标（${bookmarks.filter((b) => b.favorite).length}）</option>
                  ${groups.map((g) => html`<option value="${g.id}" ${st.groupId === g.id ? 'selected' : ''}>${g.name}（${bookmarks.filter((b) => b.groupId === g.id).length}）</option>`)}
                </select>${listView(groupItems())}</div>`
              : listView(st.tabs)}
          <label class="check"><input type="checkbox" data-change="baLogin" ${st.login ? 'checked' : ''}>需要登录时，自动用保险箱里这个网站的账号</label>
          <p class="small muted">${fresh.length ? `将添加 ${fresh.length} 个网站` : '还没有选中新网站'}${dups ? `，${dups} 个已在签到列表里会跳过` : ''}。添加时会请你一次授权这些网站。</p>
          ${st.err ? html`<p class="error-text" role="alert">${st.err}</p>` : ''}
          <div class="modal-foot"><button type="button" class="btn" data-click="baCancel">取消</button><button type="button" class="btn pri" data-click="baAdd" ${fresh.length ? '' : 'disabled'}>${fresh.length ? `添加 ${fresh.length} 个网站` : '添加网站'}</button></div>
        </div>`;
      };
      const draw = () => box && morph(box.querySelector('[data-x=ba]'), body());
      chrome.tabs
        .query({})
        .then((tabs) => {
          const seen = new Set();
          st.tabs = tabs
            .filter((t) => isWebUrl(t.url))
            .filter((t) => {
              const k = urlKey(t.url);
              if (seen.has(k)) return false;
              seen.add(k);
              return true;
            })
            .map((t) => ({ url: t.url, name: splitTitle(t.title || '', t.url).main || domainOf(t.url) }));
          if (st.src === 'tabs') pickAll(st.tabs);
          draw();
        })
        .catch(() => {});
      let unbind = () => {};
      modal({
        title: '批量添加签到网站',
        wide: true,
        body: html`<div data-x="ba"></div>`,
        onMount(b, close) {
          box = b;
          draw();
          unbind = bind(box, {
            baSrc(e, el) {
              st.src = el.getAttribute('data-k');
              st.err = '';
              if (st.src === 'group') pickAll(groupItems());
              if (st.src === 'tabs') pickAll(st.tabs);
              draw();
            },
            baText(e) {
              st.text = e.target.value;
              draw();
            },
            baGroup(e) {
              st.groupId = e.target.value;
              pickAll(groupItems());
              draw();
            },
            baPick(e, el) {
              const u = el.getAttribute('data-url');
              if (e.target.checked) st.picked.add(u);
              else st.picked.delete(u);
              draw();
            },
            baAll() {
              pickAll(currentList());
              draw();
            },
            baNone() {
              st.picked = new Set();
              draw();
            },
            baLogin(e) {
              st.login = e.target.checked;
            },
            baCancel: () => close(),
            baAdd() {
              const list = items().filter((i) => !existing.has(urlKey(i.url)));
              if (!list.length) return;
              const origins = [...new Set(list.map((i) => originOf(i.url)).filter(Boolean))].map((o) => o + '/*');
              // 授权必须在点击里直接申请：一次申请全部网站
              chrome.permissions
                .request({ origins })
                .then(async (granted) => {
                  const r = await call('tasks.addMany', { items: list, login: st.login ? 'auto' : 'none' });
                  close();
                  toast(`已添加 ${r.added} 个网站${r.skipped ? `，跳过 ${r.skipped} 个重复` : ''}${granted ? '' : '。还没有授权，签到前点「一键授权」'}`, { timeout: 6000 });
                  load();
                })
                .catch((err) => {
                  st.err = err.message || '添加失败';
                  draw();
                });
            },
          });
          if (st.src === 'paste') setTimeout(() => box.querySelector('#ba-text')?.focus(), 30);
        },
        onClose: () => unbind(),
      });
      if (st.src === 'group') pickAll(groupItems());
    }

    function draw() {
      if (!state.loaded || !settings()) {
        morph(root, html`<div class="page"><div class="row muted"><span class="spinner"></span>正在读取…</div></div>`);
        return;
      }
      morph(root, view() === 'checkin' ? checkinView() : gridView());
    }

    // ───────── 事件 ─────────

    const byId = (id) => state.tasks.find((t) => t.id === id);

    function historyDialog(t) {
      call('tasks.history', { id: t.id }).then((runs) => {
        modal({
          title: t.name + ' · 运行记录',
          wide: true,
          body: runs.length
            ? html`<table class="table"><thead><tr><th>时间</th><th>结果</th><th>说明</th></tr></thead><tbody>
                ${runs.map((r) => html`<tr><td class="small" style="white-space:nowrap">${new Date(r.at).toLocaleString('zh-CN', { hour12: false })}</td>
                  <td><span class="row small" style="gap:6px"><span class="dot ${(STATUS[r.status] || [])[1] || ''}"></span>${(STATUS[r.status] || [r.status])[0]}</span></td>
                  <td class="small muted">${r.message}${r.trigger === 'scheduled' ? '（定时）' : ''}</td></tr>`)}</tbody></table>`
            : html`<p class="muted">还没有运行记录。</p>`,
        });
      }, toastError);
    }

    bind(root, {
      toggleTool(e, el) {
        const k = el.getAttribute('data-k');
        call('settings.update', { tools: { [k]: !settings().tools[k] } }).catch(toastError);
      },
      openCheckin: () => ctx.go('#/tools/checkin'),
      openImport: () => ctx.go('#/settings/import'),
      backTools: () => ctx.go('#/tools'),
      ckTime: (e) => call('settings.update', { checkin: { time: e.target.value } }).then(() => toast(e.target.value ? `每天 ${e.target.value} 自动运行` : '已改为只手动运行')).catch(toastError),
      ckConc: (e) => call('settings.update', { checkin: { concurrency: Number(e.target.value) } }).catch(toastError),
      ckAi: () => call('settings.update', { checkin: { ai: settings().checkin.ai === false } }).catch(toastError),
      filter(e, el) {
        state.filter = el.getAttribute('data-k');
        render();
      },
      batchAdd: () => batchAddDialog(),
      stopBatch: () => call('tasks.batchStop').catch(toastError),
      retryProblems() {
        const ids = (state.batch?.items || []).filter((i) => PROBLEM(i.status)).map((i) => i.id);
        if (!ids.length) return;
        call('tasks.runIds', { ids })
          .then((r) => {
            state.batch = r.batch;
            render();
          })
          .catch(toastError);
      },
      grantAll() {
        const origins = [...new Set(state.tasks.filter((t) => state.perm[t.id] === false).flatMap((t) => (t.kind === 'skill' ? t.sites || [] : [originOf(t.url)])))].filter(Boolean).map((o) => o + '/*');
        if (!origins.length) return;
        chrome.permissions.request({ origins }).then((ok) => {
          toast(ok ? `已授权 ${origins.length} 个网站` : '没有授权，这些网站签到时会跳过', { error: !ok });
          load();
        });
      },
      openUrl: (e, el) => chrome.tabs.create({ url: el.getAttribute('data-url') }),
      fMode(e) {
        const f = state.form;
        f.mode = e.target.value === 'picked' ? 'picked' : 'auto';
        if (f.mode === 'auto') f.success = { type: 'auto', value: '', selector: '' };
        else if (f.success.type === 'auto') f.success = { type: 'gone', value: '', selector: '' };
        render();
      },
      newTask() {
        state.form = emptyForm();
        render();
        setTimeout(() => root.querySelector('#ck-url')?.focus(), 30);
      },
      closeForm() {
        state.form = null;
        render();
      },
      fUrl: (e) => {
        state.form.url = e.target.value;
        state.form.err = '';
      },
      fName: (e) => (state.form.name = e.target.value),
      fSel: (e) => (state.form.target.selector = e.target.value.trim()),
      fText: (e) => (state.form.target.text = e.target.value.trim()),
      fRule(e) {
        state.form.success = { type: e.target.value, value: '', selector: '' };
        render();
      },
      fRuleText: (e) => (state.form.success.value = e.target.value),
      fRuleUrl: (e) => (state.form.success.value = e.target.value),
      fLogin(e) {
        const v = e.target.value;
        state.form.login = v === '__auto' ? { mode: 'auto', entryId: null } : v ? { mode: 'vault', entryId: v } : { mode: 'none', entryId: null };
      },
      fAi: (e) => (state.form.allowAi = e.target.checked),
      fForget() {
        state.form.forget = !state.form.forget;
        render();
      },
      pick(e, el) {
        const f = state.form;
        const url = coerceUrl(f.url);
        if (!isWebUrl(url)) {
          f.err = '先填上签到页网址';
          render();
          root.querySelector('#ck-url')?.focus();
          return;
        }
        f.url = url;
        const mode = el.getAttribute('data-mode');
        // 授权必须在点击里直接申请。
        chrome.permissions.request({ origins: [originOf(url) + '/*'] }).then(async (granted) => {
          if (!granted) {
            f.err = '需要允许访问 ' + domainOf(url) + '，插件才能在这个网站上点选和签到';
            render();
            return;
          }
          try {
            const r = await call('picker.start', { url, mode });
            f.pickToken = r.token;
            f.pickMode = mode;
            f.err = '';
          } catch (err) {
            f.err = err.message;
          }
          render();
        });
      },
      async saveForm() {
        const f = state.form;
        const url = coerceUrl(f.url);
        const payload = { id: f.id || undefined, kind: 'checkin', mode: f.mode, name: f.name, url, target: f.target, success: f.success, login: f.login, allowAi: f.allowAi, enabled: f.enabled, forget: f.forget };
        try {
          await call('tasks.save', payload);
          state.form = null;
          toast('任务已保存');
          load();
        } catch (e) {
          f.err = e.message;
          render();
        }
      },
      async run(e, el) {
        const t = byId(el.getAttribute('data-id'));
        if (!t) return;
        t.running = true;
        render();
        try {
          const r = await call('tasks.run', { id: t.id });
          toast(`${t.name}：${r.text}${['ok', 'already'].includes(r.status) ? '' : '。' + r.message}`, { error: !['ok', 'already'].includes(r.status), timeout: 6000 });
        } catch (err) {
          toastError(err);
        }
        load();
      },
      runAll() {
        call('tasks.runAll')
          .then((r) => {
            state.batch = r.batch;
            if (!r.started) toast('已经在签到了');
            render();
          })
          .catch(toastError);
      },
      grant(e, el) {
        const t = byId(el.getAttribute('data-id'));
        if (!t) return;
        const origins = (t.kind === 'skill' ? t.sites : [originOf(t.url)]).map((o) => o + '/*');
        chrome.permissions.request({ origins }).then((ok) => {
          toast(ok ? '已授权' : '没有授权，任务没法运行', { error: !ok });
          load();
        });
      },
      taskMore(e, el) {
        const t = byId(el.getAttribute('data-id'));
        if (!t) return;
        const items = [];
        if (t.kind === 'checkin') {
          items.push({
            label: '编辑',
            icon: 'edit',
            run: () => {
              state.form = { ...emptyForm(), ...structuredClone({ id: t.id, mode: t.mode === 'auto' ? 'auto' : 'picked', name: t.name, url: t.url, target: t.target, success: t.success, login: t.login, allowAi: t.allowAi, enabled: t.enabled, learned: t.learned || null }) };
              render();
              setTimeout(() => root.querySelector('#task-form')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 30);
            },
          });
          items.push({ label: t.enabled ? '停用（不自动运行）' : '启用', icon: t.enabled ? 'pause' : 'play', run: () => call('tasks.setEnabled', { id: t.id, enabled: !t.enabled }).then(load).catch(toastError) });
        }
        items.push({ label: '运行记录', icon: 'clock', run: () => historyDialog(t) });
        items.push({ label: '打开网页', icon: 'external', run: () => chrome.tabs.create({ url: t.url }) });
        items.push('-');
        items.push({
          label: '删除',
          icon: 'trash',
          danger: true,
          run: async () => {
            await call('tasks.remove', { id: t.id }).catch(toastError);
            load();
            toast(`已删除「${t.name}」`, { action: { label: '撤销', run: () => call('tasks.restore', { id: t.id }).then(load) } });
          },
        });
        openMenu(el, items);
      },
      toggleSkill(e, el) {
        const t = byId(el.getAttribute('data-id'));
        if (!t) return;
        if (t.enabled) {
          call('tasks.setEnabled', { id: t.id, enabled: false }).then(load).catch(toastError);
          return;
        }
        chrome.permissions.request({ origins: (t.sites || []).map((o) => o + '/*') }).then((ok) => {
          if (!ok) return toast('需要授权技能包访问的网站才能启用', { error: true });
          call('tasks.setEnabled', { id: t.id, enabled: true }).then(load).catch(toastError);
        });
      },
      async importSkill() {
        const file = await pickFile('.json,application/json');
        if (!file) return;
        try {
          const data = JSON.parse(await file.text());
          const ok = await confirmBox({
            title: `导入技能包「${String(data.name || '未命名')}」？`,
            text: `它会访问：${(Array.isArray(data.sites) ? data.sites : []).join('、') || '（没有声明）'}，共 ${Array.isArray(data.steps) ? data.steps.length : 0} 个步骤。导入后默认关闭，启用时再授权这些网站。`,
            ok: '导入',
          });
          if (!ok) return;
          await call('skills.import', { data });
          toast('已导入，默认关闭');
          load();
        } catch (e) {
          toastError(e instanceof SyntaxError ? new Error('文件不是有效的 JSON') : e);
        }
      },
    });

    const offNotice = onNotice('picker', (d) => {
      const f = state.form;
      if (!f || d.token !== f.pickToken) return;
      f.pickToken = null;
      f.pickMode = null;
      if (!d.cancelled) {
        if (d.mode === 'success') f.success = { type: 'element', value: '', selector: d.selector };
        else {
          f.target = { selector: d.selector, text: d.text };
          if (d.url && !f.url) f.url = d.url;
        }
        toast(d.mode === 'success' ? '已记住成功后出现的地方' : `已记住「${d.text || '按钮'}」`);
      }
      render();
    });
    const off = onChange(['tasks', 'vault'], () => reload());
    // 批量签到进度：只取进度，结束时再整页刷新一次
    const offBatch = onChange(['checkinBatch'], () => {
      const was = !!state.batch?.running;
      call('tasks.batch')
        .then((b) => {
          state.batch = b;
          render();
          if (was && b && !b.running) reload.flush();
        })
        .catch(() => {});
    });
    const unsub = ctx.subscribe(() => render());
    load().then(() => openFromRoute(ctx.route)).catch(toastError);

    return {
      update(route) {
        openFromRoute(route);
      },
      unmount() {
        off();
        offBatch();
        reload.cancel();
        offNotice();
        unsub();
      },
    };
  },
};
