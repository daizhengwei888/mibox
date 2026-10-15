// 保险箱：网站登录、密钥和令牌、私密笔记。名称和网站是明文（锁定时也能搜到、能提示「有这个网站的账号」），
// 用户名、密码、密钥、正文都只以密文保存和同步。解锁后的主密钥放在 chrome.storage.session（只在内存里，
// 关闭浏览器即消失），到时间自动锁定。

import * as db from './db.js';
import * as cr from './crypto.js';
import { emit } from './events.js';
import { UserError } from './errors.js';
import { getSettings } from './settings.js';
import { base64url, fromBase64url, siteMatches, domainOf, uid, clampText, isWebUrl, coerceUrl } from '../shared/util.js';
import { LIMITS } from '../shared/defaults.js';
import { current, onSwitch } from './workspace.js';

const SESSION_KEY = 'sq.vaultSession';
const PENDING_KEY = 'sq.vaultPending';
const LOCK_ALARM = 'sq-vault-lock';
const KINDS = ['login', 'key', 'note'];

function workspaceStamp() {
  const w = current();
  return { workspaceId: w.id, workspaceEpoch: w.epoch };
}

function sameWorkspace(value) {
  const w = current();
  return value?.workspaceId === w.id && value?.workspaceEpoch === w.epoch;
}

// ───────────── 头信息与会话 ─────────────

export async function getHeader() {
  return db.kvGet('vaultHeader');
}

async function setHeader(header, { local = true } = {}) {
  await db.kvSet('vaultHeader', header);
  await db.kvSet('vaultHeaderUpdatedAt', Date.now());
  if (local) emit('vault', { header: true }, { local: true });
}

export async function adoptRemoteHeader(header, updatedAt) {
  cr.validateHeader(header);
  await db.kvSet('vaultHeader', header);
  await db.kvSet('vaultHeaderUpdatedAt', updatedAt || Date.now());
  const s = await readSession();
  if (s && (s.vaultId !== header.vaultId || s.keyId !== header.keyId)) await lock({ silent: true });
  emit('vault', { header: true });
}

async function readSession() {
  const got = await chrome.storage.session.get(SESSION_KEY);
  const s = got[SESSION_KEY];
  if (!s) return null;
  if (!sameWorkspace(s)) {
    await chrome.storage.session.remove(SESSION_KEY);
    return null;
  }
  if (s.expiresAt && s.expiresAt <= Date.now()) {
    await chrome.storage.session.remove(SESSION_KEY);
    return null;
  }
  return s;
}

async function lockMinutes() {
  const s = await getSettings();
  return Number(s.autoLockMinutes) || 0;
}

async function openSession(header, master) {
  const minutes = await lockMinutes();
  const expiresAt = minutes > 0 ? Date.now() + minutes * 60000 : 0;
  await chrome.storage.session.set({ [SESSION_KEY]: { ...workspaceStamp(), vaultId: header.vaultId, keyId: header.keyId, raw: base64url(master), expiresAt } });
  if (expiresAt) await chrome.alarms.create(LOCK_ALARM, { when: expiresAt });
  else await chrome.alarms.clear(LOCK_ALARM);
}

/** 每次用到保险箱都把自动锁定往后推。 */
async function touch() {
  const s = await readSession();
  if (!s) return;
  const minutes = await lockMinutes();
  const expiresAt = minutes > 0 ? Date.now() + minutes * 60000 : 0;
  if (expiresAt && s.expiresAt && expiresAt - s.expiresAt < 15000) return;
  await chrome.storage.session.set({ [SESSION_KEY]: { ...s, expiresAt } });
  if (expiresAt) await chrome.alarms.create(LOCK_ALARM, { when: expiresAt });
}

async function requireMaster() {
  const header = await getHeader();
  const s = await readSession();
  if (!header || !s || s.vaultId !== header.vaultId || s.keyId !== header.keyId) {
    throw new UserError('保险箱已锁定，请先解锁', 'LOCKED');
  }
  await touch();
  return { header, master: fromBase64url(s.raw) };
}

export async function lock({ silent = false } = {}) {
  await chrome.storage.session.remove(SESSION_KEY);
  await chrome.alarms.clear(LOCK_ALARM);
  if (!silent) emit('vault', { locked: true });
  return { locked: true };
}

export async function onAlarm(alarm) {
  if (alarm.name !== LOCK_ALARM) return false;
  const s = await readSession();
  if (!s || (s.expiresAt && s.expiresAt <= Date.now() + 1000)) await lock();
  else if (s.expiresAt) await chrome.alarms.create(LOCK_ALARM, { when: s.expiresAt });
  return true;
}

/** 改了自动锁定时间后，当前会话也按新时间算。 */
export async function applyLockSetting() {
  const s = await readSession();
  if (!s) return;
  const minutes = await lockMinutes();
  const expiresAt = minutes > 0 ? Date.now() + minutes * 60000 : 0;
  await chrome.storage.session.set({ [SESSION_KEY]: { ...s, expiresAt } });
  if (expiresAt) await chrome.alarms.create(LOCK_ALARM, { when: expiresAt });
  else await chrome.alarms.clear(LOCK_ALARM);
}

export async function status() {
  const header = await getHeader();
  const s = header ? await readSession() : null;
  const unlocked = !!(header && s && s.vaultId === header.vaultId && s.keyId === header.keyId);
  const records = await db.summary('vault');
  const conflict = await db.kvGet('vaultConflict');
  return {
    exists: !!header,
    unlocked,
    expiresAt: unlocked ? s.expiresAt || 0 : null,
    autoLockMinutes: await lockMinutes(),
    count: records.live - records.legacy,
    conflict: conflict ? { remoteCount: (conflict.records || []).filter((r) => !r.deleted).length, source: conflict.source || 'cloud' } : null,
  };
}

// ───────────── 新建、解锁、改密码 ─────────────

export async function prepareCreate(password) {
  if (await getHeader()) throw new UserError('已经有保险箱了');
  const err = cr.checkPassword(password);
  if (err) throw new UserError(err, 'WEAK_PASSWORD');
  const made = await cr.createVault(password);
  await chrome.storage.session.set({ [PENDING_KEY]: { ...workspaceStamp(), createdAt: Date.now(), header: made.header, raw: base64url(made.master), recoveryKey: made.recoveryKey } });
  return { recoveryKey: made.recoveryKey };
}

/** 用户确认已保存恢复密钥后才真正写入。 */
export async function commitCreate() {
  const got = await chrome.storage.session.get(PENDING_KEY);
  const p = got[PENDING_KEY];
  if (!p || !sameWorkspace(p)) {
    if (p) await chrome.storage.session.remove(PENDING_KEY);
    throw new UserError('保险箱创建已过期，请重新设置主密码');
  }
  if (await getHeader()) throw new UserError('已经有保险箱了');
  await setHeader(p.header);
  await openSession(p.header, fromBase64url(p.raw));
  await chrome.storage.session.remove(PENDING_KEY);
  emit('vault', { created: true });
  return status();
}

export async function cancelCreate() {
  await chrome.storage.session.remove(PENDING_KEY);
  return { ok: true };
}

onSwitch(async () => {
  await lock({ silent: true });
  await chrome.storage.session.remove(PENDING_KEY);
});

export async function unlock(password) {
  const header = await getHeader();
  if (!header) throw new UserError('还没有设置保险箱');
  let master;
  try {
    master = await cr.unwrapWithPassword(header, password);
  } catch (e) {
    if (e.code === 'UNSUPPORTED_CRYPTO') throw new UserError('不支持的加密参数', 'UNSUPPORTED_CRYPTO');
    throw new UserError('主密码不对，再试一次', 'WRONG_PASSWORD');
  }
  await openSession(header, master);
  emit('vault', { unlocked: true });
  return status();
}

/** 忘记主密码：用恢复密钥解开，同时设新主密码。 */
export async function unlockWithRecovery(recoveryKey, newPassword) {
  const header = await getHeader();
  if (!header) throw new UserError('还没有设置保险箱');
  const err = cr.checkPassword(newPassword);
  if (err) throw new UserError(err, 'WEAK_PASSWORD');
  let master;
  try {
    master = await cr.unwrapWithRecovery(header, recoveryKey);
  } catch (e) {
    throw new UserError(e.message, 'WRONG_RECOVERY');
  }
  const next = await cr.rewrapPassword(header, master, newPassword);
  await setHeader(next);
  await openSession(next, master);
  emit('vault', { unlocked: true });
  return status();
}

export async function changePassword(oldPassword, newPassword) {
  const header = await getHeader();
  if (!header) throw new UserError('还没有设置保险箱');
  let master;
  try {
    master = await cr.unwrapWithPassword(header, oldPassword);
  } catch (e) {
    if (e.code === 'UNSUPPORTED_CRYPTO') throw new UserError('不支持的加密参数', 'UNSUPPORTED_CRYPTO');
    throw new UserError('当前主密码不对', 'WRONG_PASSWORD');
  }
  const err = cr.checkPassword(newPassword);
  if (err) throw new UserError(err, 'WEAK_PASSWORD');
  const next = await cr.rewrapPassword(header, master, newPassword);
  await setHeader(next);
  await openSession(next, master);
  return { ok: true };
}

export async function regenerateRecovery(password) {
  const header = await getHeader();
  if (!header) throw new UserError('还没有设置保险箱');
  let master;
  try {
    master = await cr.unwrapWithPassword(header, password);
  } catch (e) {
    if (e.code === 'UNSUPPORTED_CRYPTO') throw new UserError('不支持的加密参数', 'UNSUPPORTED_CRYPTO');
    throw new UserError('主密码不对', 'WRONG_PASSWORD');
  }
  const made = await cr.regenerateRecovery(header, master, password);
  await setHeader(made.header);
  await openSession(made.header, master);
  return { recoveryKey: made.recoveryKey };
}

// ───────────── 条目 ─────────────

function publicOf(r) {
  return {
    id: r.id,
    kind: r.kind,
    name: r.name,
    site: r.site || '',
    fill: r.fill !== false,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

export async function list() {
  // 只列出能解密的条目（没有 cipher 的是认不出格式的旧条目）
  const rows = (await db.getLive('vault')).filter((r) => r.cipher);
  rows.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
  return rows.map(publicOf);
}

function cleanSecret(kind, s = {}) {
  const str = (v, max = LIMITS.vaultSecret) => clampText(String(v ?? ''), max);
  if (kind === 'login') {
    const url = coerceUrl(s.url);
    return { username: str(s.username, 512), password: str(s.password, 1024), url: isWebUrl(url) ? url : '', note: str(s.note) };
  }
  if (kind === 'key') {
    const fields = Array.isArray(s.fields)
      ? s.fields
          .filter((f) => f && String(f.label ?? '').trim())
          .slice(0, 12)
          .map((f) => ({ label: str(f.label, 40), value: str(f.value, 1024) }))
      : [];
    const out = { secret: str(s.secret), fields, note: str(s.note) };
    if (s.ai && (s.ai.baseUrl || s.ai.model)) out.ai = { baseUrl: str(s.ai.baseUrl, 300), model: str(s.ai.model, 120) };
    return out;
  }
  return { content: str(s.content, 32768) };
}

export async function reveal(id, includeCipher = false) {
  const { master } = await requireMaster();
  const fresh = await db.get('vault', id);
  if (!fresh || fresh.deleted) throw new UserError('这一条已经不存在了', 'NOT_FOUND');
  if (!fresh.cipher) throw new UserError('这一条的格式认不出来，没法解密');
  let secret;
  try {
    secret = await cr.decryptRecord(master, id, fresh.cipher);
  } catch {
    throw new UserError('这一条解密失败，可能是在别的保险箱里创建的', 'DECRYPT_FAILED');
  }
  return { ...publicOf(fresh), secret, ...(includeCipher ? { cipher: fresh.cipher } : {}) };
}

async function save_(input) {
  const { header, master } = await requireMaster();
  const kind = KINDS.includes(input?.kind) ? input.kind : null;
  if (!kind) throw new UserError('类型不对');
  const name = clampText(String(input.name ?? '').trim(), LIMITS.vaultName);
  if (!name) throw new UserError('请填写名称');
  const secret = cleanSecret(kind, input.secret);
  if (kind === 'login' && !secret.password && !secret.username) throw new UserError('至少填写用户名或密码');
  let site = '';
  if (kind === 'login') {
    site = String(input.site ?? '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
    if (!site && secret.url) site = domainOf(secret.url);
  }
  const t = Date.now();
  const existing = input.id ? await db.get('vault', input.id) : null;
  const id = existing && !existing.deleted ? existing.id : uid();
  const cipher = await cr.encryptRecord(master, header, id, secret);
  const rec = {
    id,
    kind,
    name,
    site,
    fill: kind === 'login' ? input.fill !== false : undefined,
    cipher,
    createdAt: existing && !existing.deleted ? existing.createdAt : t,
    updatedAt: t,
    deleted: false,
  };
  await db.put('vault', rec);
  emit('vault', { saved: id }, { local: true });
  return publicOf(rec);
}

async function setFill_(id, fill) {
  const r = await db.get('vault', id);
  if (!r || r.deleted) throw new UserError('这一条已经不存在了');
  await db.put('vault', { ...r, fill: !!fill, updatedAt: Date.now() });
  emit('vault', { saved: id }, { local: true });
  return { ok: true };
}

async function remove_(id) {
  const r = await db.get('vault', id);
  if (!r || r.deleted) return { removed: false };
  const t = Date.now();
  await db.put('vault', { ...r, deleted: true, deletedAt: t, updatedAt: t });
  emit('vault', { removed: id }, { local: true });
  return { removed: true };
}

async function restore_(id) {
  const r = await db.get('vault', id);
  if (!r || !r.deleted) return { restored: false };
  const next = { ...r, deleted: false, updatedAt: Date.now() };
  delete next.deletedAt;
  await db.put('vault', next);
  emit('vault', { restored: id }, { local: true });
  return { restored: true };
}

/** 当前网站在保险箱里的账号（锁定时也能查，只返回名称）。 */
export async function matchSite(url) {
  if (!isWebUrl(url)) return [];
  const rows = await db.getLive('vault');
  return rows.filter((r) => r.kind === 'login' && r.fill !== false && r.site && siteMatches(r.site, url)).map(publicOf);
}

/** 后台内部用：拿到某一条的明文（签到登录、AI 接口）。 */
export async function secretFor(id) {
  const full = await reveal(id, true);
  return full;
}

// 只为某个操作验证主密码，不打开、也不延长保险箱的解锁会话。
export async function verifyPassword(password, ids = []) {
  const header = await getHeader();
  if (!header) throw new UserError('还没有设置保险箱');
  let master;
  try { master = await cr.unwrapWithPassword(header, password); }
  catch (error) {
    if (error.code === 'UNSUPPORTED_CRYPTO') throw new UserError('不支持的加密参数', 'UNSUPPORTED_CRYPTO');
    throw new UserError('主密码不对，再试一次', 'WRONG_PASSWORD');
  }
  try {
    const entries = [];
    for (const id of new Set(ids)) {
      const row = await db.get('vault', id);
      if (!row || row.deleted || row.kind !== 'key' || !row.cipher) continue;
      try {
        const secret = await cr.decryptRecord(master, id, row.cipher);
        entries.push({ ...publicOf(row), secret, cipher: row.cipher });
      } catch { /* An unrelated obsolete credential must not block verification. */ }
    }
    return { header, entries };
  } finally { master.fill(0); }
}

export async function isUnlocked() {
  return (await status()).unlocked;
}

// ───────────── 从备份导入 ─────────────

/**
 * 导入一个保险箱（头信息 + 密文条目，导入过程中不需要解密）。
 * 本机没有保险箱：直接采用；同一个保险箱：按条目合并；不同的保险箱：记成冲突，让用户输入那个保险箱的主密码合并。
 */
async function importVault_(section, source = 'backup') {
  validateImportSection(section);
  const records = (Array.isArray(section.records) ? section.records : []).filter((r) => r && typeof r.id === 'string' && r.cipher && ['login', 'key', 'note'].includes(r.kind));
  const live = records.filter((r) => !r.deleted);
  const local = await getHeader();
  if (!local) {
    await db.kvSet('vaultHeader', section.header);
    await db.kvSet('vaultHeaderUpdatedAt', section.headerUpdatedAt || Date.now());
    await db.putMany('vault', records);
    emit('vault', { imported: live.length }, { local: true });
    return { mode: 'adopted', count: live.length };
  }
  if (local.vaultId === section.header.vaultId) {
    const existing = new Map((await db.getAll('vault')).map((r) => [r.id, r]));
    const newer = records.filter((r) => !existing.has(r.id) || (r.updatedAt || 0) > (existing.get(r.id).updatedAt || 0));
    await db.putMany('vault', newer);
    if (newer.length) emit('vault', { imported: newer.length }, { local: true });
    return { mode: 'merged', count: newer.filter((r) => !r.deleted).length };
  }
  if (!live.length) return { mode: 'empty', count: 0 };
  // 以前已经并进来过（同一批条目都在、而且不比文件里的旧）：不用再问。
  const have = new Map((await db.getAll('vault')).map((r) => [r.id, r]));
  if (live.every((r) => have.has(r.id) && (have.get(r.id).updatedAt || 0) >= (r.updatedAt || 0))) return { mode: 'merged', count: 0 };
  await db.kvSet('vaultConflict', { header: section.header, headerUpdatedAt: section.headerUpdatedAt || Date.now(), records, at: Date.now(), source });
  emit('vault', { conflict: true });
  return { mode: 'conflict', count: live.length };
}

export function validateImportSection(section) {
  if (!section || !section.header) throw new UserError('保险箱备份格式不正确', 'INVALID_HEADER');
  cr.validateHeader(section.header);
  if (section.records != null && !Array.isArray(section.records)) throw new UserError('保险箱备份格式不正确', 'INVALID_VAULT_BACKUP');
  return true;
}

/** 导出用：头信息和全部密文（不解密）。 */
export async function exportSection() {
  const header = await getHeader();
  if (!header) return null;
  return { header, headerUpdatedAt: (await db.kvGet('vaultHeaderUpdatedAt')) || 0, records: await db.getLive('vault') };
}

async function retireReplacedVault(localHeader, selectedHeader) {
  const retiredId = localHeader?.vaultId;
  if (!retiredId || retiredId === selectedHeader?.vaultId) return;
  await db.kvUpdate('vaultRetiredIds', (ids) => [...new Set([...(Array.isArray(ids) ? ids : []), retiredId])], []);
}

// ───────────── 两个保险箱合并（同步冲突） ─────────────

/**
 * 云端已经有另一个保险箱时：用云端保险箱的主密码，把这台电脑上的条目重新加密并入云端那个保险箱。
 * 需要本机保险箱先解锁。
 */
export async function mergeIntoRemote(remotePassword) {
  const conflict = await db.kvGet('vaultConflict');
  if (!conflict) throw new UserError('现在没有需要合并的保险箱');
  if (conflict.source && conflict.source !== 'cloud') return mergeImported_(remotePassword);
  const local = await requireMaster();
  let remoteMaster;
  try {
    remoteMaster = await cr.unwrapWithPassword(conflict.header, remotePassword);
  } catch (e) {
    if (e.code === 'UNSUPPORTED_CRYPTO') throw new UserError('不支持的加密参数', 'UNSUPPORTED_CRYPTO');
    throw new UserError('云端保险箱的主密码不对', 'WRONG_PASSWORD');
  }
  const t = Date.now();
  const localRows = await db.getLive('vault');
  const merged = [];
  for (const r of localRows) {
    if (!r.cipher) continue;
    const plain = await cr.decryptRecord(local.master, r.id, r.cipher);
    const cipher = await cr.encryptRecord(remoteMaster, conflict.header, r.id, plain);
    merged.push({ ...r, cipher, updatedAt: t });
  }
  const remoteRows = (conflict.records || []).filter((r) => !localRows.some((l) => l.id === r.id));
  await db.clear('vault');
  await db.putMany('vault', [...remoteRows, ...merged]);
  await db.kvSet('vaultHeader', conflict.header);
  await db.kvSet('vaultHeaderUpdatedAt', conflict.headerUpdatedAt || t);
  await db.kvSet('vaultConflict', null);
  await retireReplacedVault(local.header, conflict.header);
  await openSession(conflict.header, remoteMaster);
  emit('vault', { merged: merged.length }, { local: true });
  return { merged: merged.length };
}

/** 解开导入的那份明文。解不开返回 null。 */
async function openForeign(master, r) {
  try {
    if (r.cipher) return { kind: r.kind, secret: await cr.decryptRecord(master, r.id, r.cipher) };
  } catch {}
  return null;
}

/**
 * 备份里是另一个保险箱时：用那个保险箱的主密码解开，重新加密并进这里的保险箱，
 * 继续用这里的主密码（这样不会和云端、其他电脑上的保险箱冲突）。
 */
async function mergeImported_(password) {
  const conflict = await db.kvGet('vaultConflict');
  if (!conflict) throw new UserError('现在没有需要合并的保险箱');
  const local = await requireMaster();
  let foreign;
  try {
    foreign = await cr.unwrapWithPassword(conflict.header, password);
  } catch (e) {
    if (e.code === 'UNSUPPORTED_CRYPTO') throw new UserError('不支持的加密参数', 'UNSUPPORTED_CRYPTO');
    throw new UserError('备份里那个保险箱的主密码不对', 'WRONG_PASSWORD');
  }
  const existing = new Map((await db.getAll('vault')).map((r) => [r.id, r]));
  const t = Date.now();
  const out = [];
  let failed = 0;
  for (const r of conflict.records || []) {
    if (r.deleted) continue;
    const mine = existing.get(r.id);
    if (mine && !mine.deleted && (mine.updatedAt || 0) >= (r.updatedAt || 0)) continue;
    const opened = await openForeign(foreign, r);
    if (!opened) {
      failed++;
      continue;
    }
    const secret = cleanSecret(opened.kind, opened.secret);
    const next = { ...r, kind: opened.kind, name: clampText(String(r.name || opened.name || '未命名'), LIMITS.vaultName), cipher: await cr.encryptRecord(local.master, local.header, r.id, secret), updatedAt: t, deleted: false };
    delete next.deletedAt;
    out.push(next);
  }
  if (out.length) await db.putMany('vault', out);
  await db.kvSet('vaultConflict', null);
  emit('vault', { merged: out.length }, { local: true });
  return { merged: out.length, failed };
}

/** 不要导入的那个保险箱了（只对备份有效；云端的冲突下次同步还会出现）。 */
export async function dismissConflict() {
  await db.kvSet('vaultConflict', null);
  emit('vault', { conflict: false });
  return { ok: true };
}

/** 放弃这台电脑上的保险箱，直接用云端的。 */
export async function discardLocalForRemote() {
  const conflict = await db.kvGet('vaultConflict');
  if (!conflict) throw new UserError('现在没有需要合并的保险箱');
  cr.validateHeader(conflict.header);
  const local = await getHeader();
  await db.clear('vault');
  await db.putMany('vault', conflict.records || []);
  await db.kvSet('vaultHeader', conflict.header);
  await db.kvSet('vaultHeaderUpdatedAt', conflict.headerUpdatedAt || Date.now());
  await db.kvSet('vaultConflict', null);
  await retireReplacedVault(local, conflict.header);
  await lock({ silent: true });
  emit('vault', { replaced: true }, { local: true });
  return { ok: true };
}

/** 设置页「清除本机资料」时用。 */
export async function wipeLocal() {
  await lock({ silent: true });
  await db.clear('vault');
  await db.kvSet('vaultHeader', null);
  await db.kvSet('vaultConflict', null);
  await db.transact(['kv'], (tx) => tx.delete('kv', 'vaultRetiredIds'));
}

// 写操作排队执行，避免和同步写回互相覆盖。
export const save = (...args) => db.exclusive(() => save_(...args));
export const setFill = (...args) => db.exclusive(() => setFill_(...args));
export const remove = (...args) => db.exclusive(() => remove_(...args));
export const restore = (...args) => db.exclusive(() => restore_(...args));
export const importVault = (...args) => db.exclusive(() => importVault_(...args));
