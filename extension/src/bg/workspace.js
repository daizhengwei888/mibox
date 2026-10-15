// 资料库：未登录时用本机库（shuqian-local），登录 Google 后每个账号一个独立的库；切换时先等手上的操作做完。

import * as db from './db.js';
import { UserError } from './errors.js';
import { sha256Hex } from '../shared/util.js';
import { stable } from './merge.js';

const control = db.database('shuqian-control');
const hooks = new Set();
let state;
let initialization;
let switching = false;
let leases = 0;
let drain;

function broadcast(phase) {
  chrome.runtime.sendMessage({ sqEvent: 'changed', topics: ['workspace'], detail: { phase, epoch: current().epoch } }).catch(() => {});
}

async function persist(patch) {
  return control.exclusive(async () => {
    const stored = await control.kvGet('workspace');
    const next = { ...(stored || state), ...patch };
    await control.kvSet('workspace', next);
    state = next;
    return state;
  });
}

function counts(snapshot) {
  return Object.fromEntries(db.STORES.filter((s) => s !== 'kv').map((s) => [s, snapshot[s].filter((r) => !r.deleted).length]));
}

async function snapshot(database) {
  const rows = await Promise.all(db.STORES.map((s) => database.getAll(s)));
  return Object.fromEntries(db.STORES.map((s, i) => [s, rows[i]]));
}

const excluded = new Set(['google', 'syncState', 'deviceId', 'localCopyHash']);
function business(data) {
  return Object.fromEntries(db.STORES.map((s) => [s, data[s].filter((r) => s !== 'kv' || !excluded.has(r.key)).sort((a, b) => String(a.id || a.key).localeCompare(String(b.id || b.key)))]));
}
async function digest(data) { return sha256Hex(stable(business(data))); }

async function initialize() {
  state = await control.kvGet('workspace');
  if (!state) await persist({ id: 'local', database: 'shuqian-local', auth: null, generation: 0, transition: false });
  if (state.transition) {
    await chrome.storage.session.remove(['sq.vaultSession', 'sq.vaultPending', 'sq.picker']);
    await persist({ transition: false, generation: (state.generation || 0) + 1, auth: state.auth ? { ...state.auth, reauth: true } : null });
  }
  const expectedId = state.auth?.user?.googleSub ? await sha256Hex('shuqian-account:' + state.auth.user.googleSub) : 'local';
  const expectedDatabase = expectedId === 'local' ? 'shuqian-local' : 'shuqian-account-' + expectedId;
  if (state.id !== expectedId || state.database !== expectedDatabase) throw new UserError('资料库归属记录不一致，已停止读取，请保留备份后人工恢复', 'WORKSPACE_OWNER');
  db.activate(state.database);
  const epoch = `${state.generation || 0}:${state.id || 'local'}`;
  const stored = await chrome.storage.session.get(['sq.vaultSession', 'sq.vaultPending', 'sq.picker']);
  const stale = [];
  for (const key of ['sq.vaultSession', 'sq.vaultPending', 'sq.picker']) {
    const value = stored[key];
    if (!value) continue;
    const expiry = key === 'sq.vaultSession' ? value.expiresAt : value.createdAt ? value.createdAt + 30 * 60 * 1000 : 0;
    if (value.workspaceId !== state.id || value.workspaceEpoch !== epoch || (expiry && expiry <= Date.now())) stale.push(key);
  }
  if (stale.length) await chrome.storage.session.remove(stale);
}

export function ready() {
  if (!initialization) initialization = initialize().catch((e) => { initialization = null; throw e; });
  return initialization;
}

export function current() {
  return Object.freeze({ id: state?.id || 'local', database: state?.database || 'shuqian-local', account: state?.auth?.user ? Object.freeze({ ...state.auth.user }) : null, epoch: `${state?.generation || 0}:${state?.id || 'local'}` });
}

export async function status() {
  await ready();
  const localSummary = await Promise.all(db.STORES.filter((s) => s !== 'kv').map(async (store) => [store, await db.database('shuqian-local').summary(store)]));
  const localCounts = Object.fromEntries(localSummary.map(([store, summary]) => [store, summary.live]));
  return { ...current(), localCounts, switching };
}

export async function run(fn, expectedEpoch = null) {
  await ready();
  if (switching || (expectedEpoch && expectedEpoch !== current().epoch)) throw new UserError('资料库已切换，请重新打开页面后操作', 'WORKSPACE_CHANGED');
  leases++;
  try { return await fn(current()); }
  finally {
    leases--;
    if (!leases && drain) { drain(); drain = null; }
  }
}

export function onSwitch(fn) { hooks.add(fn); }

export async function transition(fn, expectedEpoch = null) {
  await ready();
  if (switching || (expectedEpoch && expectedEpoch !== current().epoch)) throw new UserError('资料库正在切换，请稍后重试', 'WORKSPACE_CHANGED');
  switching = true;
  broadcast('switching');
  try {
    if (leases) await new Promise((resolve) => { drain = resolve; });
    await persist({ transition: true });
    for (const hook of hooks) await hook();
    const result = await fn();
    await persist({ transition: false });
    return result;
  } catch (e) {
    await persist({ transition: false });
    throw e;
  } finally {
    switching = false;
    broadcast('ready');
  }
}

export async function activate(auth) {
  if (!switching) throw new Error('Workspace activation requires a transition');
  const id = auth?.user ? await sha256Hex('shuqian-account:' + auth.user.googleSub) : 'local';
  const database = id === 'local' ? 'shuqian-local' : 'shuqian-account-' + id;
  await db.database(database).openDb();
  await persist({ id, database, auth, generation: state.generation + 1 });
  db.activate(database);
}

export async function getAuth() { await ready(); return state.auth || null; }
export async function setAuth(auth) {
  await ready();
  if (auth?.user?.googleSub !== state.auth?.user?.googleSub) throw new UserError('登录身份修改必须同时切换资料库', 'WORKSPACE_OWNER');
  await persist({ auth });
}
export async function deviceId() {
  await ready();
  return control.exclusive(async () => {
    let id = await control.kvGet('deviceId');
    if (!id) await control.kvSet('deviceId', id = crypto.randomUUID());
    return id;
  });
}

export async function assertSyncAllowed() {
  await ready();
  if (!state.auth?.user) throw new UserError('请先登录 Google 后同步', 'NOT_SIGNED_IN');
  await assertWorkAllowed();
}

export async function assertWorkAllowed() {
  await ready();
  if (state.auth?.reauth) throw new UserError('Chrome 登录状态已变化，请重新登录后继续', 'REAUTH');
  const copy = await control.kvGet('copyLocal:' + state.id);
  if (copy && copy.phase !== 'activated') throw new UserError('本机资料复制尚未完成，请重新点击复制完成校验后再同步', 'COPY_PENDING');
}

export async function copyLocal({ confirmed = false } = {}) {
  if (!confirmed) throw new UserError('请确认将本机资料复制到当前账号', 'CONFIRM_REQUIRED');
  return transition(async () => {
    if (!state.auth?.user) throw new UserError('请先登录目标 Google 账号', 'NOT_SIGNED_IN');
    const data = business(await snapshot(db.database('shuqian-local')));
    const target = db.database(state.database);
    const hash = await digest(data);
    if (await target.kvGet('localCopyHash') === hash) return { already: true };
    const journalKey = 'copyLocal:' + state.id;
    const journal = await control.kvGet(journalKey);
    if (journal && journal.hash !== hash) throw new UserError('复制来源已变化，请保留资料并用备份导入', 'COPY_CHANGED');
    // 当前账号已经有资料时，改用备份导入（含保险箱冲突处理），这里不直接覆盖。
    if (!journal && Object.values(counts(await snapshot(target))).some(Boolean)) throw new UserError('当前账号已有资料，请导出本机备份后用导入功能合并', 'COPY_TARGET');
    await control.kvSet(journalKey, { hash, source: 'shuqian-local', target: state.database, phase: 'prepared' });
    for (const store of db.STORES) await target.putMany(store, data[store]);
    if (await digest(await snapshot(target)) !== hash) throw new UserError('复制校验失败，原本机资料仍保留', 'COPY_VERIFY');
    await target.kvSet('localCopyHash', hash);
    await control.kvSet(journalKey, { hash, phase: 'activated', at: Date.now() });
    await persist({ generation: state.generation + 1 });
    return { counts: counts(data), verified: true };
  });
}
