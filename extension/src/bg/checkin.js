// 签到助手和技能包：在你自己的浏览器里按时打开网页、点按钮、检查结果。
// 只在用户授权过的网站上运行；需要登录时从保险箱取账号（保险箱必须是解锁状态）。

import * as db from './db.js';
import * as vault from './vault.js';
import * as ops from './pageops.js';
import * as cp from './checkin-page.js';
import { aiConfig, aiDecide } from './checkin-ai.js';
import { emit, notice } from './events.js';
import { UserError } from './errors.js';
import { getSettings } from './settings.js';
import { current, onSwitch, run as workspaceRun, assertWorkAllowed } from './workspace.js';
import { isWebUrl, originOf, domainOf, uid, todayKey, sleep, clampText, normalizeUrl } from '../shared/util.js';

const DAILY_ALARM = 'sq-checkin-daily';
const CATCHUP_ALARM = 'sq-checkin-catchup';
const RETRY_ALARM = 'sq-checkin-retry';
const RETRY_DELAY_MIN = 10;
const RETRY_MAX = 2; // 当天最多自动重试两次
const PICKER_KEY = 'sq.picker';
const RUN_KEEP = 30;

const running = new Set();
const activeRuns = new Set();

onSwitch(async () => {
  if (batch?.running) batch.stopping = true;
  if (batchPromise) await batchPromise.catch(() => {});
  batch = null;
  await chrome.storage.session.remove(BATCH_KEY).catch(() => {});
  await chrome.action.setBadgeText({ text: '' }).catch(() => {});
  await chrome.alarms.clear(DAILY_ALARM);
  await chrome.alarms.clear(CATCHUP_ALARM);
  await chrome.alarms.clear(RETRY_ALARM);
  await db.kvSet('checkinRetry', { day: '', count: 0, when: 0 });
  await Promise.all([...activeRuns]);
});

export const STATUS_TEXT = {
  ok: '成功',
  already: '今天已签过',
  'need-login': '需要登录',
  locked: '保险箱已锁定',
  challenge: '需要人工验证',
  'not-found': '找不到按钮',
  failed: '没有确认成功',
  'no-permission': '没有网站权限',
  error: '打开失败',
  skipped: '已跳过',
  running: '正在运行',
};

// ───────────── 任务增删改 ─────────────

export async function list() {
  const tasks = await db.getLive('tasks');
  tasks.sort((a, b) => a.createdAt - b.createdAt);
  return tasks.map((t) => ({ ...t, running: running.has(t.id) }));
}

function cleanRule(rule) {
  const type = ['text', 'gone', 'element', 'url', 'auto'].includes(rule?.type) ? rule.type : 'gone';
  return { type, value: clampText(String(rule?.value ?? '').trim(), 200), selector: clampText(String(rule?.selector ?? '').trim(), 500) };
}

async function save_(input) {
  const url = String(input?.url ?? '').trim();
  if (!isWebUrl(url)) throw new UserError('签到页网址需要以 http 或 https 开头');
  const kind = input.kind === 'skill' ? 'skill' : 'checkin';
  const t = Date.now();
  const existing = input.id ? await db.get('tasks', input.id) : null;
  const target = { selector: clampText(String(input.target?.selector ?? '').trim(), 500), text: clampText(String(input.target?.text ?? '').trim(), 60) };
  // 自动识别：不用点选，插件按关键词、论坛平台和 AI 自己找签到入口，成功后记住做法。
  const mode = kind === 'checkin' && input.mode === 'auto' ? 'auto' : 'picked';
  if (kind === 'checkin' && mode === 'picked' && !target.selector && !target.text) throw new UserError('请先到页面上点选签到按钮，或者改用自动识别');
  const success = mode === 'auto' ? { type: 'auto', value: '', selector: '' } : cleanRule(input.success);
  if (success.type === 'text' && !success.value) throw new UserError('请填写签到成功时页面上会出现的文字');
  if (success.type === 'element' && !success.selector) throw new UserError('请到页面上点选成功后出现的地方');
  if (success.type === 'url' && !success.value) throw new UserError('请填写成功后网址里会出现的内容');
  const login =
    input.login?.mode === 'vault' && input.login.entryId ? { mode: 'vault', entryId: String(input.login.entryId) } : input.login?.mode === 'auto' ? { mode: 'auto', entryId: null } : { mode: 'none', entryId: null };
  // 网址或方式变了、或者用户点了「忘掉」：记住的做法作废，下次重新找
  const keepLearned = !input.forget && existing && !existing.deleted && existing.url === url && existing.mode === mode;
  const rec = {
    ...(existing && !existing.deleted ? existing : {}),
    id: existing && !existing.deleted ? existing.id : uid(),
    kind,
    mode,
    learned: keepLearned ? existing.learned || null : null,
    name: clampText(String(input.name ?? '').trim(), 80) || domainOf(url) + ' 签到',
    url,
    enabled: input.enabled !== false,
    target,
    success,
    login,
    allowAi: mode === 'auto' ? true : !!input.allowAi,
    createdAt: existing && !existing.deleted ? existing.createdAt : t,
    updatedAt: t,
    deleted: false,
  };
  if (kind === 'skill') {
    rec.steps = existing?.steps || [];
    rec.description = existing?.description || '';
    rec.schedule = input.schedule === 'manual' ? 'manual' : existing?.schedule || 'daily';
  }
  await db.put('tasks', rec);
  emit('tasks', { saved: rec.id }, { local: true });
  return rec;
}

async function setEnabled_(id, enabled) {
  const rec = await db.get('tasks', id);
  if (!rec || rec.deleted) throw new UserError('任务不存在了');
  await db.put('tasks', { ...rec, enabled: !!enabled, updatedAt: Date.now() });
  emit('tasks', { saved: id }, { local: true });
  return { ok: true };
}

/**
 * 批量添加：每个网址建一个「自动识别」任务。按网址去重，已经有的跳过。
 * items = [{ url, name }]；login = 'auto' 时需要登录就用保险箱里匹配这个网站的账号。
 */
async function addMany_({ items, login = 'auto' } = {}) {
  const existing = await db.getLive('tasks');
  const keys = new Set();
  for (const t of existing) {
    if (t.kind !== 'checkin') continue;
    try {
      keys.add(normalizeUrl(t.url));
    } catch {}
  }
  let added = 0;
  let skipped = 0;
  let invalid = 0;
  const t0 = Date.now();
  for (const it of (Array.isArray(items) ? items : []).slice(0, 300)) {
    const url = String(it?.url ?? '').trim();
    if (!isWebUrl(url)) {
      invalid++;
      continue;
    }
    let key;
    try {
      key = normalizeUrl(url);
    } catch {
      invalid++;
      continue;
    }
    if (keys.has(key)) {
      skipped++;
      continue;
    }
    keys.add(key);
    await db.put('tasks', {
      id: uid(),
      kind: 'checkin',
      mode: 'auto',
      learned: null,
      name: clampText(String(it?.name ?? '').trim(), 80) || domainOf(url),
      url,
      enabled: true,
      target: { selector: '', text: '' },
      success: { type: 'auto', value: '', selector: '' },
      login: login === 'auto' ? { mode: 'auto', entryId: null } : { mode: 'none', entryId: null },
      allowAi: true,
      createdAt: t0 + added,
      updatedAt: t0,
      deleted: false,
    });
    added++;
  }
  if (added) emit('tasks', { added }, { local: true });
  return { added, skipped, invalid };
}

async function remove_(id) {
  const rec = await db.get('tasks', id);
  if (!rec || rec.deleted) return { removed: false };
  const t = Date.now();
  await db.put('tasks', { ...rec, deleted: true, deletedAt: t, updatedAt: t });
  emit('tasks', { removed: id }, { local: true });
  return { removed: true };
}

async function restore_(id) {
  const rec = await db.get('tasks', id);
  if (!rec || !rec.deleted) return { restored: false };
  const next = { ...rec, deleted: false, updatedAt: Date.now() };
  delete next.deletedAt;
  await db.put('tasks', next);
  emit('tasks', { restored: id }, { local: true });
  return { restored: true };
}

export async function history(taskId) {
  const runs = await db.getByIndex('runs', 'taskId', taskId);
  return runs.sort((a, b) => b.at - a.at).slice(0, RUN_KEEP);
}

// ───────────── 技能包 ─────────────

const STEP_OPS = ['open', 'wait', 'click', 'waitFor', 'checkText'];

/** 导入技能包（JSON）。只允许打开网页、等待、点击和检查文字，读不到保险箱。导入后默认关闭。 */
async function importSkill_(data) {
  if (!data || data.format !== 'shuqian-skill/1') throw new UserError('这不是技能包文件（需要 format: shuqian-skill/1）');
  const name = clampText(String(data.name ?? '').trim(), 80);
  if (!name) throw new UserError('技能包缺少名称');
  const sites = (Array.isArray(data.sites) ? data.sites : []).map(originOf).filter(Boolean);
  if (!sites.length) throw new UserError('技能包需要在 sites 里写明会访问哪些网站');
  const steps = Array.isArray(data.steps) ? data.steps.slice(0, 40) : [];
  if (!steps.length) throw new UserError('技能包没有步骤');
  const clean = [];
  for (const s of steps) {
    const op = s?.do;
    if (!STEP_OPS.includes(op)) throw new UserError('技能包里有不支持的步骤：' + String(op));
    if (op === 'open') {
      if (!isWebUrl(s.url) || !sites.includes(originOf(s.url))) throw new UserError('步骤里的网址必须在 sites 声明的网站内：' + String(s.url));
      clean.push({ do: 'open', url: s.url });
    } else if (op === 'wait') {
      clean.push({ do: 'wait', ms: Math.min(30000, Math.max(0, Number(s.ms) || 1000)) });
    } else if (op === 'click') {
      if (!s.selector && !s.text) throw new UserError('点击步骤需要 selector 或 text');
      clean.push({ do: 'click', selector: clampText(String(s.selector ?? ''), 500), text: clampText(String(s.text ?? ''), 60) });
    } else if (op === 'waitFor') {
      if (!s.selector && !s.text) throw new UserError('等待步骤需要 selector 或 text');
      clean.push({ do: 'waitFor', selector: clampText(String(s.selector ?? ''), 500), text: clampText(String(s.text ?? ''), 200), timeout: Math.min(30000, Number(s.timeout) || 10000) });
    } else if (op === 'checkText') {
      clean.push({ do: 'checkText', text: clampText(String(s.text ?? ''), 200) });
    }
  }
  if (clean[0].do !== 'open') throw new UserError('技能包的第一步必须是打开网页');
  const t = Date.now();
  const rec = {
    id: uid(),
    kind: 'skill',
    name,
    description: clampText(String(data.description ?? ''), 300),
    url: clean[0].url,
    sites,
    steps: clean,
    schedule: data.schedule === 'manual' ? 'manual' : 'daily',
    enabled: false,
    target: { selector: '', text: '' },
    success: { type: 'text', value: '', selector: '' },
    login: { mode: 'none', entryId: null },
    allowAi: false,
    createdAt: t,
    updatedAt: t,
    deleted: false,
  };
  await db.put('tasks', rec);
  emit('tasks', { saved: rec.id }, { local: true });
  return rec;
}

// ───────────── 运行 ─────────────

function waitComplete(tabId, timeout = 30000) {
  return new Promise((resolve) => {
    let finished = false;
    const end = (ok) => {
      if (finished) return;
      finished = true;
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      resolve(ok);
    };
    const listener = (id, info) => {
      if (id === tabId && info.status === 'complete') end(true);
    };
    const timer = setTimeout(() => end(false), timeout);
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId).then((t) => {
      if (t.status === 'complete') end(true);
    }, () => end(false));
  });
}

async function exec(tabId, func, args = []) {
  await assertWorkAllowed();
  const [res] = await chrome.scripting.executeScript({ target: { tabId }, func, args });
  return res?.result;
}

async function execSafe(tabId, func, args = []) {
  await assertWorkAllowed();
  try {
    return await exec(tabId, func, args);
  } catch {
    return undefined;
  }
}

async function hasPermission(url) {
  const origin = originOf(url);
  if (!origin) return false;
  return chrome.permissions.contains({ origins: [origin + '/*'] });
}

async function navigate(tabId, url) {
  await assertWorkAllowed();
  await chrome.tabs.update(tabId, { url });
  await sleep(300);
  await waitComplete(tabId, 30000);
  await sleep(1200);
}

async function loginIfNeeded(task, tabId, ctx) {
  const needs = await execSafe(tabId, ops.hasLoginFormInPage);
  if (!needs) return null;
  let entryId = task.login?.mode === 'vault' ? task.login.entryId : null;
  if (task.login?.mode === 'auto') {
    // 自动匹配：保险箱里正好有一个这个网站的账号才用
    const here = await chrome.tabs.get(tabId);
    const matches = await vault.matchSite(here.url);
    if (matches.length !== 1) return { status: 'need-login', message: matches.length ? '网页要求登录，保险箱里这个网站有多个账号，请在任务里选一个' : '网页要求登录，保险箱里没有这个网站的账号' };
    entryId = matches[0].id;
  }
  if (!entryId) return { status: 'need-login', message: '网页要求登录，这个任务没有设置账号' };
  if (!(await vault.isUnlocked())) return { status: 'locked', message: '需要登录，但保险箱是锁着的。解锁后再运行一次' };
  let entry;
  try {
    entry = await vault.secretFor(entryId);
  } catch (e) {
    return { status: 'need-login', message: e.message };
  }
  const tab = await chrome.tabs.get(tabId);
  if (entry.site && !siteOk(entry.site, tab.url)) return { status: 'need-login', message: '登录页的网址和保险箱里的网站对不上，没有填入' };
  await exec(tabId, ops.fillLoginInPage, [entry.secret.username || '', entry.secret.password || '', true]);
  await sleep(800);
  await waitComplete(tabId, 15000);
  await sleep(1500);
  // 先填用户名、下一页再填密码的网站
  const again = await execSafe(tabId, ops.hasLoginFormInPage);
  if (again) {
    await exec(tabId, ops.fillLoginInPage, [entry.secret.username || '', entry.secret.password || '', true]);
    await sleep(800);
    await waitComplete(tabId, 15000);
    await sleep(1500);
    if (await execSafe(tabId, ops.hasLoginFormInPage)) return { status: 'need-login', message: '自动登录没有成功，可能需要验证码' };
  }
  ctx.loggedIn = true;
  const now = await chrome.tabs.get(tabId);
  if (originOf(now.url) !== originOf(task.url) || !now.url.startsWith(task.url.split('#')[0])) await navigate(tabId, task.url);
  return null;
}

function siteOk(site, url) {
  const host = domainOf(url);
  return host === site || host.endsWith('.' + site) || site.endsWith('.' + host);
}

// ───────────── 自动识别（关键词 → 论坛平台 → AI），成功后记住做法 ─────────────

const AUTO_BUDGET_MS = 90000;
const DIALOG_OK = /签到成功|打卡成功|领取成功|已签到|已经签到|已打卡|已领取|明[日天]再来|获得|奖励|积分|成功|success|already/i;
const DIALOG_BAD = /失败|错误|异常|error|fail/i;
const DIALOG_LOGIN = /请先?登录|未登录|尚未登录|login required|please (log|sign) in/i;

/** 在网页主环境接管 alert / confirm，后台标签页里的弹窗不再卡住页面。 */
async function hookDialogs(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: cp.hookDialogsInPage });
  } catch {}
}

async function readDialogs(tabId) {
  try {
    const [res] = await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: cp.readDialogsInPage });
    return Array.isArray(res?.result) ? res.result : [];
  } catch {
    return [];
  }
}

/** 点完之后：如果开始跳转，就等新页面加载完。urlChanged 也包括单页应用只改了 # 后面的情况。 */
async function settle(tabId, beforeUrl) {
  await sleep(700);
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) return { navigated: false, urlChanged: false };
  const navigated = tab.status === 'loading' || (!!tab.url && !!beforeUrl && tab.url.split('#')[0] !== beforeUrl.split('#')[0]);
  if (navigated) {
    await waitComplete(tabId, 25000);
    await sleep(1200);
    await hookDialogs(tabId);
  }
  const now = navigated ? (await chrome.tabs.get(tabId).catch(() => tab)).url : tab.url;
  return { navigated, urlChanged: navigated || (!!now && !!beforeUrl && now !== beforeUrl) };
}

/**
 * 点过之后在几秒内找结果：弹窗、新出现的「签到成功 / 签到失败」、按钮消失或变灰。
 * opts.link：点的是普通链接；打开的新页面写着「今天已签」时算「今天已签过」，不算这次签到成功。
 */
async function verifyAfterClick(tabId, base, selector, moved, ms = 7000, { link = false, urlChanged = false } = {}) {
  const end = Date.now() + ms;
  for (;;) {
    // 只看提示框（alert）；确认框的问话（「签到可获得积分，确定吗？」）不算结果
    const all = await readDialogs(tabId);
    const alerts = all.filter((d) => d.startsWith('alert:')).map((d) => d.slice(6));
    if (all.some((d) => DIALOG_LOGIN.test(d.replace(/^\w+:/, '')))) return { login: true };
    const bad = alerts.find((d) => DIALOG_BAD.test(d));
    if (bad) return { ok: false, failed: bad.slice(0, 40) };
    const good = alerts.find((d) => DIALOG_OK.test(d));
    if (good) return { ok: true, evidence: '弹窗「' + good.slice(0, 40) + '」' };
    const r = await execSafe(tabId, cp.checkAutoSuccessInPage, [base || null, moved ? '' : selector || '']);
    if (r?.failed) return { ok: false, failed: r.failed };
    if (r?.ok) {
      // 点的其实是「去签到页」：新出现的「连续签到 N 天」不算，页面上还有没点过的签到按钮就继续
      // 同一页里只看点之前没有的按钮（导航栏上原本就有的「每日签到」不算）；换了新页面就看全部
      const scan = await execSafe(tabId, cp.scanCheckinInPage, [selector && !moved ? [selector] : []]);
      const pending = (scan?.candidates || []).filter((c) => !c.disabled && c.score >= 80 && (moved || !(base?.text || '').includes(c.text)));
      if (pending.length && !scan.already) return { ok: false };
      if (link && (moved || urlChanged) && scan?.already) return { ok: false, already: scan.already };
      return { ok: true, evidence: r.evidence };
    }
    if (Date.now() > end) return { ok: false };
    await sleep(700);
  }
}

async function clickAndVerify(tabId, step, ms) {
  const base = await execSafe(tabId, cp.snapshotInPage);
  const click = await execSafe(tabId, cp.clickSelectorInPage, [step.selector || '', step.text || '']);
  if (!click?.found) return { clicked: false };
  if (click.disabled) return { clicked: false, disabled: true, text: click.text };
  const { navigated, urlChanged } = await settle(tabId, base?.url);
  const v = await verifyAfterClick(tabId, base, step.selector, navigated, ms, { link: click.link, urlChanged });
  return { clicked: true, navigated, at: click.at, text: click.text || step.text, ...v };
}

/** 记住这次成功的做法；下次直接照做，不用再找、也不用再问 AI。at 是点这一下时所在的网页。 */
async function learn(task, steps, how) {
  const clean = steps
    .filter((st) => st && (st.open || st.selector || st.text))
    .slice(-4)
    .map((st) => (st.open ? { open: String(st.open).slice(0, 500) } : { selector: clampText(String(st.selector || ''), 500), text: clampText(String(st.text || ''), 60), ...(isWebUrl(st.at) ? { at: String(st.at).slice(0, 500) } : {}) }));
  if (!clean.length) return;
  await db.exclusive(async () => {
    const rec = await db.get('tasks', task.id);
    if (!rec || rec.deleted) return;
    await db.put('tasks', { ...rec, learned: { steps: clean, how, at: Date.now() }, updatedAt: Date.now() });
  });
  emit('tasks', { learned: task.id }, { local: true });
}

const samePage = (a, b) => !!a && !!b && a.split('#')[0] === b.split('#')[0];

/**
 * 自动签到。顺序：记住的做法 → 页面上「今天已签」 → 关键词找按钮 → 论坛平台签到页 → AI 多步操作。
 * opts.useLearned=false 时跳过记住的做法（点选任务找不到按钮时用）。
 */
async function runAuto(task, tabId, ctx, { useLearned = true } = {}) {
  const deadline = Date.now() + AUTO_BUDGET_MS;
  const steps = [];
  const tried = [];
  const notes = [];
  const already = (text) => ({ status: 'already', message: '页面显示「' + text + '」' });

  // 1. 记住的做法
  const learned = !useLearned ? [] : task.learned?.steps?.length ? task.learned.steps : task.mode === 'auto' && (task.target?.selector || task.target?.text) ? [task.target] : [];
  for (let i = 0; i < learned.length; i++) {
    const st = learned[i];
    const last = i === learned.length - 1;
    if (st.open) {
      await navigate(tabId, st.open);
      await hookDialogs(tabId);
      steps.push({ open: st.open });
      // 最后一步就是打开签到页（比如 NexusPHP 的 attendance.php）：打开即签到，看结果
      if (last) {
        const scan = await execSafe(tabId, cp.scanCheckinInPage, [[]]);
        if (scan?.already && !scan.candidates.some((c) => !c.disabled && c.score >= 92)) return already(scan.already);
        if (scan && !scan.candidates.some((c) => !c.disabled && c.score >= 60)) {
          const v = await verifyAfterClick(tabId, { text: '', url: st.open }, '', true, 2500);
          if (v.login) return { status: 'need-login', message: '网页提示需要登录' };
          if (v.failed) return { status: 'failed', message: '打开签到页后网页提示「' + v.failed + '」' };
          if (v.ok) return { status: 'ok', message: '按记住的做法签到成功：' + v.evidence };
        }
      }
      continue;
    }
    // 记得这一步是在哪个网页上点的：不在那一页就先过去（同一个网站才去）
    const here = (await chrome.tabs.get(tabId).catch(() => null))?.url || '';
    if (st.at && !samePage(st.at, here) && originOf(st.at) === originOf(task.url) && i > 0) {
      await navigate(tabId, st.at);
      await hookDialogs(tabId);
    }
    const r = await clickAndVerify(tabId, st, last ? 7000 : 2500);
    if (r.disabled) return { status: 'already', message: `「${r.text || st.text}」是灰的，今天应该签过了` };
    if (!r.clicked) {
      // 这一步的按钮没了：如果下一步在别的网页上，直接去那一页接着做（今天已经点过的入口常常会消失）
      const next = learned[i + 1];
      if (next && next.at && !samePage(next.at, here) && originOf(next.at) === originOf(task.url)) {
        notes.push('记住的「' + (st.text || '…') + '」没有了，直接去下一步的网页');
        continue;
      }
      notes.push('记住的按钮「' + (st.text || '…') + '」找不到了，重新找');
      break;
    }
    steps.push({ selector: st.selector, text: st.text, at: r.at || st.at });
    if (r.login) return { status: 'need-login', message: '网页提示需要登录' };
    if (r.failed) return { status: 'failed', message: '点了「' + (r.text || st.text || '签到') + '」，网页提示「' + r.failed + '」' };
    if (r.already) return already(r.already);
    if (r.ok) return { status: 'ok', message: '按记住的做法签到成功：' + r.evidence };
    tried.push(st.selector);
  }

  // 2. 规则：已签检测、关键词、论坛平台
  let recipeTried = false;
  let discuzTried = false;
  let waitedLate = false;
  for (let round = 0; round < 5 && Date.now() < deadline; round++) {
    const scan = await execSafe(tabId, cp.scanCheckinInPage, [tried]);
    if (!scan) break;
    const strong = scan.candidates.filter((c) => !c.disabled && c.score >= 60);
    if (scan.already && !strong.some((c) => c.score >= 92)) return already(scan.already);
    if (/dsu_paulsign/.test(scan.url) && !discuzTried) {
      discuzTried = true;
      recipeTried = true;
      const base = await execSafe(tabId, cp.snapshotInPage);
      const d = await execSafe(tabId, cp.discuzPaulsignInPage);
      if (d?.handled) {
        const { navigated } = await settle(tabId, base?.url);
        const v = await verifyAfterClick(tabId, base, '', navigated, 6000);
        if (v.failed) return { status: 'failed', message: 'Discuz 签到页提示「' + v.failed + '」' };
        if (v.ok) {
          await learn(task, [{ open: scan.url }], 'recipe');
          return { status: 'ok', message: 'Discuz 签到成功：' + v.evidence };
        }
      }
    }
    if (!strong.length) {
      if (scan.recipeUrl && !recipeTried) {
        recipeTried = true;
        const base = { text: '', url: scan.recipeUrl };
        await navigate(tabId, scan.recipeUrl);
        await hookDialogs(tabId);
        steps.push({ open: scan.recipeUrl });
        notes.push('打开了论坛的签到页 ' + new URL(scan.recipeUrl).pathname);
        // NexusPHP 的 attendance.php 打开就算签到
        if (/attendance\.php/.test(scan.recipeUrl)) {
          const again = await execSafe(tabId, cp.scanCheckinInPage, [tried]);
          if (again?.already) return already(again.already);
          const v = await verifyAfterClick(tabId, base, '', true, 3000);
          if (v.ok) {
            await learn(task, steps, 'recipe');
            return { status: 'ok', message: '打开签到页完成签到：' + v.evidence };
          }
        }
        continue;
      }
      if (scan.loginWall) return { status: 'need-login', message: '看起来还没有登录这个网站' + (task.login?.mode === 'none' ? '' : '，也没有能自动填入的账号') };
      // 单页应用的按钮常常晚一点才画出来：等一会儿再看一次
      if (!waitedLate) {
        waitedLate = true;
        await sleep(2500);
        continue;
      }
      break;
    }
    const best = strong[0];
    tried.push(best.selector);
    const r = await clickAndVerify(tabId, best, 7000);
    if (!r.clicked) continue;
    steps.push({ selector: best.selector, text: best.text, at: r.at });
    if (r.login) return { status: 'need-login', message: '点了「' + best.text + '」，网页提示需要登录' };
    if (r.failed) return { status: 'failed', message: '点了「' + best.text + '」，网页提示「' + r.failed + '」' };
    if (r.already) return already(r.already);
    if (r.ok) {
      await learn(task, steps, 'keyword');
      return { status: 'ok', message: '自动找到「' + best.text + '」并签到成功：' + r.evidence };
    }
    notes.push('点了「' + best.text + '」' + (r.navigated ? '，进入了新页面' : '，页面没有明显变化'));
  }

  // 3. AI 多步操作
  const cfg = await aiConfig();
  if (!cfg.error) {
    const history = [...notes];
    for (let i = 0; i < 5 && Date.now() < deadline; i++) {
      const page = await execSafe(tabId, cp.dehydrateInPage, [120]);
      if (!page) break;
      const d = await aiDecide(cfg, { task, page, history, timeoutMs: Math.max(5000, Math.min(25000, deadline - Date.now())) });
      if (d.action === 'error') {
        notes.push(d.why);
        break;
      }
      if (d.action === 'done') {
        if (d.result === 'already') return { status: 'already', message: 'AI 判断今天已经签过' + (d.why ? '：' + d.why : '') };
        if (steps.length) {
          await learn(task, steps, 'ai');
          return { status: 'ok', message: 'AI 判断已经完成签到' + (d.why ? '：' + d.why : '') };
        }
        notes.push('AI 认为已经完成，但没有做任何操作');
        break;
      }
      if (d.action === 'login') return { status: 'need-login', message: 'AI 判断需要先登录这个网站' };
      if (d.action === 'fail') {
        notes.push('AI：' + d.why);
        break;
      }
      const base = await execSafe(tabId, cp.snapshotInPage);
      const c = await execSafe(tabId, cp.aiClickInPage, [d.index]);
      if (!c?.found) {
        history.push(`选了编号 ${d.index}，但页面上没有这个元素`);
        continue;
      }
      if (c.refused) {
        history.push(`编号 ${d.index}「${c.text}」属于危险操作，已拒绝，请换一个`);
        continue;
      }
      if (c.disabled) {
        history.push(`「${c.text}」是灰的，点不了`);
        continue;
      }
      steps.push({ selector: c.selector, text: c.text, at: c.at });
      const { navigated, urlChanged } = await settle(tabId, base?.url);
      const v = await verifyAfterClick(tabId, base, c.selector, navigated, 6000, { link: c.link, urlChanged });
      if (v.login) return { status: 'need-login', message: '点了「' + c.text + '」，网页提示需要登录' };
      if (v.failed) return { status: 'failed', message: 'AI 点了「' + c.text + '」，网页提示「' + v.failed + '」' };
      if (v.already) return already(v.already);
      if (v.ok) {
        await learn(task, steps, 'ai');
        return { status: 'ok', message: 'AI 找到「' + c.text + '」并签到成功：' + v.evidence };
      }
      history.push(`点了「${c.text}」${navigated ? '，进入了新页面' : '，页面没有明显变化'}`);
    }
  } else {
    notes.push(cfg.error);
  }

  if (steps.length) return { status: 'failed', message: notes.slice(-2).join('；') || '点了按钮，但没有看到成功的迹象' };
  return { status: 'not-found', message: '没找到签到入口' + (notes.length ? '：' + notes.slice(-2).join('；') : '') };
}

async function pollSuccess(tabId, rule, target, beforeText, ms = 10000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    await sleep(700);
    const ok = await execSafe(tabId, ops.checkSuccessInPage, [rule, target, beforeText || '']);
    if (ok) return true;
  }
  return false;
}

async function runCheckin(task, tabId) {
  const ctx = {};
  // 网址打不开时 Chrome 显示的是自己的错误页，脚本注入不进去
  const probe = await chrome.scripting.executeScript({ target: { tabId }, func: () => document.readyState }).then(
    () => null,
    (e) => e,
  );
  if (probe) return { status: 'error', message: /error page/i.test(probe.message || '') ? '网页打不开，可能网址写错了或网站暂时连不上' : '没法在这个网页上运行：' + (probe.message || '未知原因') };
  await hookDialogs(tabId);
  const ch = await execSafe(tabId, ops.detectChallengeInPage);
  if (ch?.challenged) return { status: 'challenge', message: ch.reason + '，需要你手动打开网页通过一次' };

  const loginRes = await loginIfNeeded(task, tabId, ctx);
  if (loginRes) return loginRes;
  const ch2 = ctx.loggedIn ? await execSafe(tabId, ops.detectChallengeInPage) : null;
  if (ch2?.challenged) return { status: 'challenge', message: ch2.reason + '，需要你手动打开网页通过一次' };
  if (ctx.loggedIn) await hookDialogs(tabId);
  if (task.mode === 'auto') return runAuto(task, tabId, ctx);

  const rule = task.success;
  if (rule.type !== 'gone') {
    const already = await execSafe(tabId, ops.checkSuccessInPage, [rule, task.target, '']);
    if (already) return { status: 'already', message: '页面显示今天已经完成' };
  }
  let click = await execSafe(tabId, ops.clickTargetInPage, [task.target]);
  if (!click?.found) {
    if (await execSafe(tabId, ops.hasLoginFormInPage)) return { status: 'need-login', message: '网页要求登录' };
    if (task.allowAi) {
      // 点选的按钮找不到了：按自动识别再找一遍（关键词、论坛平台、AI），成功后记住新的做法
      const auto = await runAuto(task, tabId, ctx);
      return auto.status === 'ok' ? { ...auto, message: '原来的按钮找不到了，' + auto.message } : auto;
    } else if (rule.type === 'gone') {
      return { status: 'already', message: '没找到签到按钮，可能今天已经签过' };
    } else {
      return { status: 'not-found', message: '找不到签到按钮，网页可能改版了，请重新点选' };
    }
  }
  if (click.disabled) return { status: 'already', message: '签到按钮是灰的，可能今天已经签过' };
  const ok = await pollSuccess(tabId, rule, task.target, click.before);
  if (ok) return { status: 'ok', message: click.how === 'text' ? '按文字找到按钮并签到成功' : '签到成功' };
  return { status: 'failed', message: '点了按钮，但没有看到成功的迹象' };
}

async function runSkill(task, tabId) {
  for (const step of task.steps || []) {
    if (step.do === 'open') {
      if (!(await hasPermission(step.url))) return { status: 'no-permission', message: '没有访问 ' + domainOf(step.url) + ' 的权限' };
      await navigate(tabId, step.url);
      const ch = await execSafe(tabId, ops.detectChallengeInPage);
      if (ch?.challenged) return { status: 'challenge', message: ch.reason };
    } else if (step.do === 'wait') {
      await sleep(step.ms);
    } else if (step.do === 'click') {
      const r = await execSafe(tabId, ops.clickTargetInPage, [{ selector: step.selector, text: step.text }]);
      if (!r?.found) return { status: 'not-found', message: '找不到要点的「' + (step.text || step.selector) + '」' };
      await sleep(800);
    } else if (step.do === 'waitFor') {
      const end = Date.now() + step.timeout;
      let seen = false;
      while (Date.now() < end && !seen) {
        seen = step.selector ? await execSafe(tabId, ops.pageHasElementInPage, [step.selector]) : await execSafe(tabId, ops.pageHasTextInPage, [step.text]);
        if (!seen) await sleep(600);
      }
      if (!seen) return { status: 'failed', message: '等了很久也没出现「' + (step.text || step.selector) + '」' };
    } else if (step.do === 'checkText') {
      const seen = await execSafe(tabId, ops.pageHasTextInPage, [step.text]);
      if (!seen) return { status: 'failed', message: '页面上没有「' + step.text + '」' };
    }
  }
  return { status: 'ok', message: '全部步骤完成' };
}

async function recordRun(task, result, trigger) {
  const at = Date.now();
  const okStatuses = ['ok', 'already'];
  const run = { id: uid(), taskId: task.id, at, day: todayKey(at), ok: okStatuses.includes(result.status), status: result.status, message: result.message || '', trigger };
  await db.put('runs', run);
  const old = (await db.getByIndex('runs', 'taskId', task.id)).sort((a, b) => b.at - a.at).slice(RUN_KEEP);
  if (old.length) await db.removeMany('runs', old.map((r) => r.id));
  await db.exclusive(async () => {
    const rec = await db.get('tasks', task.id);
    if (rec) await db.put('tasks', { ...rec, lastRun: { at, day: run.day, ok: run.ok, status: run.status, message: run.message } });
  });
  return run;
}

/** 运行一个任务。manual=true 时遇到需要人工处理的情况会把网页留着并切过去。 */
async function run_(id, { manual = false, trigger = 'manual', windowId = null } = {}) {
  await assertWorkAllowed();
  const task = await db.get('tasks', id);
  if (!task || task.deleted) throw new UserError('任务不存在了');
  if (running.has(id)) return { status: 'running', message: '正在运行' };
  running.add(id);
  emit('tasks', { running: [...running] });
  let tabId = null;
  let keepOpen = false;
  let result;
  try {
    const urls = task.kind === 'skill' ? task.sites || [task.url] : [task.url];
    for (const u of urls) {
      if (!(await hasPermission(u))) {
        result = { status: 'no-permission', message: '还没有授权访问 ' + domainOf(u) + '，请在任务里点「授权」' };
        break;
      }
    }
    if (!result) {
      const url = task.kind === 'skill' ? 'about:blank' : task.url;
      let tab = null;
      if (windowId != null) tab = await chrome.tabs.create({ url, active: false, windowId }).catch(() => null);
      if (!tab) tab = await chrome.tabs.create({ url, active: false });
      tabId = tab.id;
      if (task.kind !== 'skill') {
        const loaded = await waitComplete(tabId, 30000);
        if (!loaded) result = { status: 'error', message: '网页 30 秒内没有打开' };
        else await sleep(1500);
      }
      if (!result) result = task.kind === 'skill' ? await runSkill(task, tabId) : await runCheckin(task, tabId);
      keepOpen = manual && ['challenge', 'need-login', 'locked'].includes(result.status);
    }
  } catch (e) {
    result = { status: 'error', message: e?.message ? '运行出错：' + e.message : '运行出错' };
  } finally {
    if (tabId !== null) {
      if (keepOpen) {
        await chrome.tabs.update(tabId, { active: true }).catch(() => {});
        result.message += '。网页已经打开，处理好后再点一次运行';
      } else {
        await chrome.tabs.remove(tabId).catch(() => {});
      }
    }
    running.delete(id);
  }
  await recordRun(task, result, trigger);
  emit('tasks', { ran: id, running: [...running] });
  // 批量结束后单独重试某一个：把结果写回汇总，工具栏角标跟着更新
  if (batch && !batch.running && batch.workspaceId === current().id) {
    const item = batch.items.find((i) => i.id === id);
    if (item) {
      item.status = result.status;
      item.message = result.message || '';
      item.at = Date.now();
      await saveBatch();
      await updateBadge();
    }
  }
  return { ...result, text: STATUS_TEXT[result.status] || result.status };
}

export function run(...args) {
  const p = workspaceRun(() => run_(...args));
  activeRuns.add(p);
  p.then(() => activeRuns.delete(p), () => activeRuns.delete(p));
  return p;
}

// ───────────── 批量签到：独立的最小化窗口里几个一起跑，实时进度，可以停止 ─────────────

const BATCH_KEY = 'sq.checkinBatch';
const PROBLEM = (st) => !['ok', 'already', 'skipped', 'running', ''].includes(st || '');
let batch = null;
let batchPromise = null;
let saveTimer = null;

async function saveBatch(now = false) {
  const write = async () => {
    saveTimer = null;
    try {
      await chrome.storage.session.set({ [BATCH_KEY]: batch });
    } catch {}
    emit('checkinBatch', { running: !!batch?.running });
  };
  if (now) {
    clearTimeout(saveTimer);
    return write();
  }
  if (!saveTimer) saveTimer = setTimeout(write, 250);
}

/** 工具栏图标上显示需要处理的网站数。 */
async function updateBadge() {
  const n = batch && !batch.running ? batch.items.filter((i) => PROBLEM(i.status)).length : 0;
  try {
    await chrome.action.setBadgeBackgroundColor({ color: '#b45309' });
    await chrome.action.setBadgeText({ text: n ? String(Math.min(n, 99)) : '' });
    await chrome.action.setTitle({ title: n ? `收藏当前网页（Alt+Shift+S）· 签到有 ${n} 个网站需要处理` : '收藏当前网页（Alt+Shift+S）' });
  } catch {}
}

export async function batchStatus() {
  if (batch && batch.workspaceId === current().id) return batch;
  const saved = (await chrome.storage.session.get(BATCH_KEY))[BATCH_KEY] || null;
  if (!saved || saved.workspaceId !== current().id) return null;
  if (saved.running && !batchPromise) {
    // 后台被浏览器回收过：上一轮没跑完
    saved.running = false;
    saved.interrupted = true;
    for (const i of saved.items) if (i.state !== 'done') {
      i.state = 'done';
      i.status = 'skipped';
      i.message = '运行被中断';
    }
  }
  return saved;
}

/** 开始一轮批量签到，立即返回；进度通过 checkinBatch 事件推给界面。 */
async function startBatch_({ ids = null, onlyDue = false, trigger = 'manual' } = {}) {
  await assertWorkAllowed();
  if (batchPromise) return { started: false, batch };
  const s = await getSettings();
  const today = todayKey();
  const live = await db.getLive('tasks');
  let tasks;
  if (Array.isArray(ids)) {
    const want = new Set(ids);
    tasks = live.filter((t) => want.has(t.id));
  } else {
    tasks = live.filter((t) => t.enabled && (t.kind === 'checkin' || t.schedule !== 'manual' || trigger === 'manual'));
    if (onlyDue) tasks = tasks.filter((t) => !(t.lastRun && t.lastRun.day === today && t.lastRun.ok));
  }
  tasks.sort((a, b) => a.createdAt - b.createdAt);
  const w = current();
  batch = {
    id: uid(),
    workspaceId: w.id,
    epoch: w.epoch,
    trigger,
    startedAt: Date.now(),
    finishedAt: 0,
    running: true,
    stopping: false,
    total: tasks.length,
    done: 0,
    items: tasks.map((t) => ({ id: t.id, name: t.name, url: t.url, state: 'queued', status: '', message: '', at: 0 })),
  };
  await saveBatch(true);
  await updateBadge();
  const size = Math.max(1, Math.min(5, Number(s.checkin.concurrency) || 3));
  const p = runBatch(tasks.map((t) => t.id), size, trigger, w.epoch);
  batchPromise = p;
  activeRuns.add(p);
  p.catch(() => {}).finally(() => {
    activeRuns.delete(p);
    if (batchPromise === p) batchPromise = null;
  });
  return { started: true, batch };
}

async function runBatch(ids, size, trigger, epoch) {
  let windowId = null;
  if (ids.length) {
    try {
      const win = await chrome.windows.create({ url: 'about:blank', focused: false, state: 'minimized' });
      windowId = win.id;
    } catch {}
  }
  const queue = [...ids];
  const worker = async () => {
    while (queue.length && !batch.stopping && current().epoch === epoch) {
      const id = queue.shift();
      const item = batch.items.find((i) => i.id === id);
      item.state = 'running';
      item.status = 'running';
      await saveBatch();
      if (windowId != null && !(await chrome.windows.get(windowId).catch(() => null))) windowId = null;
      let r;
      try {
        r = await run(id, { trigger, windowId });
      } catch (e) {
        r = { status: 'error', message: e?.message || '运行出错' };
      }
      if (r.status === 'running') r = { status: 'skipped', message: '这个任务正在单独运行' };
      item.state = 'done';
      item.status = r.status;
      item.message = r.message || '';
      item.at = Date.now();
      batch.done++;
      await saveBatch();
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(size, Math.max(1, ids.length)) }, worker));
  } finally {
    if (windowId != null) await chrome.windows.remove(windowId).catch(() => {});
    for (const i of batch.items) {
      if (i.state !== 'done') {
        i.state = 'done';
        i.status = 'skipped';
        i.message = batch.stopping ? '已停止' : '没有运行';
      }
    }
    batch.running = false;
    batch.finishedAt = Date.now();
    await saveBatch(true);
    await updateBadge();
    if (current().epoch === epoch) await db.kvSet('checkinLastAuto', { day: todayKey(), at: Date.now(), trigger });
  }
}

export const startBatch = (...args) => workspaceRun(() => startBatch_(...args));

export async function stopBatch() {
  if (batch?.running) {
    batch.stopping = true;
    await saveBatch(true);
  }
  return { ok: true };
}

/** 用户看过结果了：清掉工具栏角标。 */
export async function batchSeen() {
  try {
    await chrome.action.setBadgeText({ text: '' });
  } catch {}
  return { ok: true };
}

/** 定时运行：跑完才返回。onlyDue=true 时跳过今天已经成功过的。 */
async function runAll_({ onlyDue = false, trigger = 'manual' } = {}) {
  const r = await startBatch_({ onlyDue, trigger });
  if (!r.started) return { ran: 0, busy: true };
  if (batchPromise) await batchPromise.catch(() => {});
  return { ran: r.batch.total };
}

export const runAll = (...args) => workspaceRun(() => runAll_(...args));

// ───────────── 定时 ─────────────

function nextAt(time) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(time || '');
  if (!m) return null;
  const d = new Date();
  d.setHours(Number(m[1]), Number(m[2]), 0, 0);
  if (d.getTime() <= Date.now() + 1000) d.setDate(d.getDate() + 1);
  return d.getTime();
}

async function reschedule_({ catchUp = false } = {}) {
  const s = await getSettings();
  await chrome.alarms.clear(DAILY_ALARM);
  if (!s.tools.checkin || !s.checkin.time) {
    await chrome.alarms.clear(CATCHUP_ALARM);
    await chrome.alarms.clear(RETRY_ALARM);
    await db.kvSet('checkinRetry', { day: '', count: 0, when: 0 });
    return;
  }
  const when = nextAt(s.checkin.time);
  if (when) await chrome.alarms.create(DAILY_ALARM, { when });
  const day = todayKey();
  const retryState = await db.kvGet('checkinRetry');
  const failed = await failedToday();
  if (!failed) {
    await chrome.alarms.clear(RETRY_ALARM);
    await db.kvSet('checkinRetry', { day, count: 0, when: 0 });
  } else if (retryState?.day === day && retryState.count > 0 && retryState.count <= RETRY_MAX && retryState.when > 0) {
    const alarm = await chrome.alarms.get(RETRY_ALARM);
    let dueAt = retryState.when;
    if (dueAt <= Date.now()) dueAt = Date.now() + 1000;
    if (!alarm || alarm.scheduledTime <= Date.now() || Math.abs(alarm.scheduledTime - dueAt) > 1000) {
      await db.kvSet('checkinRetry', { ...retryState, when: dueAt });
      await chrome.alarms.create(RETRY_ALARM, { when: dueAt });
    }
  }
  if (catchUp) {
    // 今天的时间已经过了、但今天还没跑过：开机一分钟后补跑。
    const m = /^(\d{1,2}):(\d{2})$/.exec(s.checkin.time);
    const today = new Date();
    today.setHours(Number(m[1]), Number(m[2]), 0, 0);
    const last = await db.kvGet('checkinLastAuto');
    if (Date.now() > today.getTime() && (!last || last.day !== todayKey())) {
      await chrome.alarms.create(CATCHUP_ALARM, { when: Date.now() + 60000 });
    }
  }
}

export const reschedule = (...args) => workspaceRun(() => reschedule_(...args));

/** 今天到期但还没成功的任务数。 */
async function failedToday() {
  const today = todayKey();
  const tasks = (await db.getLive('tasks')).filter((t) => t.enabled && (t.kind === 'checkin' || t.schedule !== 'manual'));
  return tasks.filter((t) => !(t.lastRun && t.lastRun.day === today && t.lastRun.ok)).length;
}

/** 当天失败后过十分钟再试，最多两次；早上断网不会再整天不试。 */
async function scheduleRetry() {
  if (!(await failedToday())) {
    await chrome.alarms.clear(RETRY_ALARM);
    await db.kvSet('checkinRetry', { day: todayKey(), count: 0, when: 0 });
    return;
  }
  const rec = (await db.kvGet('checkinRetry')) || { day: '', count: 0 };
  const day = todayKey();
  const count = rec.day === day ? rec.count : 0;
  if (rec.day === day && rec.when > 0) {
    const alarm = await chrome.alarms.get(RETRY_ALARM);
    let dueAt = rec.when;
    if (dueAt <= Date.now()) dueAt = Date.now() + 1000;
    if (!alarm || alarm.scheduledTime <= Date.now() || Math.abs(alarm.scheduledTime - dueAt) > 1000) {
      await db.kvSet('checkinRetry', { ...rec, when: dueAt });
      await chrome.alarms.create(RETRY_ALARM, { when: dueAt });
    }
    return;
  }
  if (count >= RETRY_MAX) return;
  const dueAt = Date.now() + RETRY_DELAY_MIN * 60000;
  await db.kvSet('checkinRetry', { day, count: count + 1, when: dueAt });
  await chrome.alarms.create(RETRY_ALARM, { when: dueAt });
}

async function onAlarm_(alarm) {
  if (alarm.name !== DAILY_ALARM && alarm.name !== CATCHUP_ALARM && alarm.name !== RETRY_ALARM) return false;
  const s = await getSettings();
  if (alarm.name === RETRY_ALARM) {
    const retry = await db.kvGet('checkinRetry');
    const deliveredAt = Number(alarm.scheduledTime) || 0;
    if (!retry || retry.day !== todayKey() || retry.count < 1 || retry.when === 0) return true;
    if (retry.when && retry.when > Date.now()) return true;
    if (deliveredAt && retry.when && Math.abs(deliveredAt - retry.when) > 1000) return true;
    await db.kvSet('checkinRetry', { ...retry, when: 0 });
  }
  if (s.tools.checkin) {
    await runAll({ onlyDue: true, trigger: 'scheduled' });
    await scheduleRetry();
  } else {
    await chrome.alarms.clear(RETRY_ALARM);
    await db.kvSet('checkinRetry', { day: '', count: 0, when: 0 });
  }
  if (alarm.name === DAILY_ALARM) await reschedule();
  return true;
}

export const onAlarm = (...args) => workspaceRun(() => onAlarm_(...args));

// ───────────── 页面点选 ─────────────

async function injectPicker(tabId, token, mode) {
  await chrome.scripting.executeScript({ target: { tabId }, func: (o) => (window.__sqPicker = o), args: [{ token, mode }] });
  await chrome.scripting.executeScript({ target: { tabId }, files: ['src/content/picker.js'] });
}

async function startPicker_({ url, mode }, sender) {
  if (!isWebUrl(url)) throw new UserError('网址需要以 http 或 https 开头');
  if (!(await hasPermission(url))) throw new UserError('还没有授权访问这个网站', 'NO_PERMISSION');
  const token = uid();
  const tab = await chrome.tabs.create({ url, active: true });
  const w = current();
  await chrome.storage.session.set({ [PICKER_KEY]: { token, tabId: tab.id, createdAt: Date.now(), mode: mode === 'success' ? 'success' : 'target', returnTabId: sender?.tab?.id ?? null, workspaceId: w.id, workspaceEpoch: w.epoch } });
  await waitComplete(tab.id, 30000);
  await sleep(500);
  try {
    await injectPicker(tab.id, token, mode);
  } catch (e) {
    throw new UserError('没能在这个网页上点选：' + (e.message || ''));
  }
  return { token };
}

export const startPicker = (...args) => workspaceRun(() => startPicker_(...args));

async function pending() {
  const p = (await chrome.storage.session.get(PICKER_KEY))[PICKER_KEY] || null;
  if (!p) return null;
  const w = current();
  if (p.workspaceId !== w.id || p.workspaceEpoch !== w.epoch) {
    await chrome.storage.session.remove(PICKER_KEY);
    return null;
  }
  return p;
}

/** 点选中途网页跳转了（比如先跳去登录），重新注入。 */
export function installPickerWatcher() {
  chrome.tabs.onUpdated.addListener((tabId, info) => {
    if (info.status !== 'complete') return;
    workspaceRun(async () => {
      const p = await pending();
      if (p && p.tabId === tabId) await injectPicker(tabId, p.token, p.mode);
    }).catch(() => {});
  });
  chrome.tabs.onRemoved.addListener((tabId) => {
    workspaceRun(async () => {
      const p = await pending();
      if (p && p.tabId === tabId) {
        await chrome.storage.session.remove(PICKER_KEY);
        notice('picker', { token: p.token, cancelled: true });
      }
    }).catch(() => {});
  });
}

async function pickerResult_(payload, sender, cancelled) {
  const p = await pending();
  if (!p || p.token !== payload?.token || sender?.tab?.id !== p.tabId) return { ok: false };
  await chrome.storage.session.remove(PICKER_KEY);
  notice('picker', cancelled ? { token: p.token, cancelled: true } : { token: p.token, mode: p.mode, selector: String(payload.selector || '').slice(0, 500), text: String(payload.text || '').slice(0, 60), url: payload.url });
  if (p.returnTabId != null) {
    try {
      const back = await chrome.tabs.update(p.returnTabId, { active: true });
      if (back?.windowId) await chrome.windows.update(back.windowId, { focused: true });
    } catch {}
  }
  await chrome.tabs.remove(p.tabId).catch(() => {});
  return { ok: true };
}

export const pickerResult = (...args) => workspaceRun(() => pickerResult_(...args));

onSwitch(async () => {
  const p = (await chrome.storage.session.get(PICKER_KEY))[PICKER_KEY] || null;
  await chrome.storage.session.remove(PICKER_KEY);
  if (p?.tabId != null) await chrome.tabs.remove(p.tabId).catch(() => {});
});

// 写操作排队执行，避免和同步写回互相覆盖。
export const save = (...args) => db.exclusive(() => save_(...args));
export const setEnabled = (...args) => db.exclusive(() => setEnabled_(...args));
export const remove = (...args) => db.exclusive(() => remove_(...args));
export const restore = (...args) => db.exclusive(() => restore_(...args));
export const importSkill = (...args) => db.exclusive(() => importSkill_(...args));
export const addMany = (...args) => db.exclusive(() => addMany_(...args));
