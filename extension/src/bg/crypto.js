// 保险箱用到的加密原语：PBKDF2-SHA256（60 万次）派生口令密钥，
// AES-256-GCM 包裹一个随机主密钥；每条记录再用主密钥 AES-GCM 加密，附加数据绑定记录 id。

import { base64url, fromBase64url } from '../shared/util.js';

export const KDF_ITERATIONS = 600000;
// 导入或从云端采纳头信息时允许的迭代次数区间：太低不安全，太高会让每次解锁卡很久。
export const KDF_MIN = 100000;
export const KDF_MAX = 1000000;
// 头信息有两个版本，标识字符串（包括 bch.*）是加密格式的一部分，改了已有的保险箱就打不开，不要改。
export const HEADER_V1 = 'bch.vault-header/1';
export const HEADER_V2 = 'sq.vault-header/2';

const enc = new TextEncoder();
const dec = new TextDecoder();

export function randomId(bytes = 16) {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export function checkPassword(password) {
  const text = String(password ?? '');
  const n = [...text].length;
  if (n < 12) return '主密码至少要 12 个字符';
  if (n > 256) return '主密码太长了（最多 256 个字符）';
  return null;
}

async function derive(password, salt, iterations = KDF_ITERATIONS) {
  if (!Number.isInteger(iterations) || iterations < KDF_MIN || iterations > KDF_MAX) {
    const e = new Error('不支持的加密参数');
    e.code = 'UNSUPPORTED_CRYPTO';
    throw e;
  }
  const base = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

function aesKey(raw, usages) {
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, usages);
}

async function seal(key, plain, aad) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(aad) }, key, plain));
  return { iv: base64url(iv), ciphertext: base64url(ct) };
}

async function open(key, box, aad) {
  const out = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromBase64url(box.iv), additionalData: enc.encode(aad) },
    key,
    fromBase64url(box.ciphertext),
  );
  return new Uint8Array(out);
}

function wrapAad(header, kind) {
  if (header.format === HEADER_V1) {
    return JSON.stringify(['bch.vault-wrap/1', kind, header.workspaceId, header.vaultId, header.keyId]);
  }
  return JSON.stringify(['sq.vault-wrap/2', kind, header.vaultId, header.keyId]);
}

export function validateHeader(h) {
  const reject = (message, code) => {
    const error = new Error(message);
    error.user = true;
    error.code = code;
    throw error;
  };
  if (!(
    !!h &&
    (h.format === HEADER_V1 || h.format === HEADER_V2) &&
    typeof h.vaultId === 'string' &&
    typeof h.keyId === 'string' &&
    h.kdf &&
    typeof h.kdf.salt === 'string' &&
    h.passwordWrap &&
    h.recoveryWrap &&
    (h.format === HEADER_V2 || /^[a-f0-9]{64}$/.test(h.workspaceId || ''))
  )) reject('保险箱头格式不正确', 'INVALID_HEADER');
  try {
    const validId = (value) => /^[A-Za-z0-9_-]{16,128}$/.test(value);
    const decode = (value) => {
      if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
      const bytes = fromBase64url(value);
      return base64url(bytes) === value ? bytes : null;
    };
    if (!validId(h.vaultId) || !validId(h.keyId)) reject('保险箱头格式不正确', 'INVALID_HEADER');
    if (h.kdf.name !== 'PBKDF2' || h.kdf.hash !== 'SHA-256' || !Number.isInteger(h.kdf.iterations) || h.kdf.iterations < KDF_MIN || h.kdf.iterations > KDF_MAX) {
      reject('不支持的密钥派生参数', 'KDF_UNSUPPORTED');
    }
    if (decode(h.kdf.salt)?.length !== 16) reject('保险箱头格式不正确', 'INVALID_HEADER');
    for (const box of [h.passwordWrap, h.recoveryWrap]) {
      if (decode(box.iv)?.length !== 12 || decode(box.ciphertext)?.length !== 48) reject('保险箱头格式不正确', 'INVALID_HEADER');
    }
  } catch (error) {
    if (error?.user) throw error;
    reject('保险箱头格式不正确', 'INVALID_HEADER');
  }
  return true;
}

export function isHeader(header) {
  try { validateHeader(header); return true; }
  catch { return false; }
}

function recoveryText(vaultId, raw) {
  return `SQ-RECOVERY-2.${vaultId}.${base64url(raw)}`;
}

export function parseRecovery(text) {
  const m = /^(?:SQ-RECOVERY-2|BCH-RECOVERY-1)\.([A-Za-z0-9_-]{16,128})\.([A-Za-z0-9_-]{43})$/.exec(String(text ?? '').replace(/\s+/g, ''));
  if (!m) return null;
  const raw = fromBase64url(m[2]);
  return raw.length === 32 ? { vaultId: m[1], raw } : null;
}

/** 新建保险箱：返回头信息、主密钥原始字节和恢复密钥。 */
export async function createVault(password) {
  const err = checkPassword(password);
  if (err) throw new Error(err);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const master = crypto.getRandomValues(new Uint8Array(32));
  const recovery = crypto.getRandomValues(new Uint8Array(32));
  const header = { format: HEADER_V2, vaultId: randomId(), keyId: randomId(), kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: KDF_ITERATIONS, salt: base64url(salt) } };
  header.passwordWrap = await seal(await derive(password, salt), master, wrapAad(header, 'password'));
  header.recoveryWrap = await seal(await aesKey(recovery, ['encrypt']), master, wrapAad(header, 'recovery'));
  header.createdAt = Date.now();
  return { header, master, recoveryKey: recoveryText(header.vaultId, recovery) };
}

/** 用主密码解开主密钥。密码错时抛出 WRONG_PASSWORD。 */
export async function unwrapWithPassword(header, password) {
  if (!isHeader(header)) {
    const e = new Error('不支持的加密参数');
    e.user = true;
    e.code = 'UNSUPPORTED_CRYPTO';
    throw e;
  }
  try {
    const key = await derive(password, fromBase64url(header.kdf.salt), header.kdf.iterations);
    const raw = await open(key, header.passwordWrap, wrapAad(header, 'password'));
    if (raw.length !== 32) throw new Error();
    return raw;
  } catch {
    const e = new Error('主密码不对');
    e.code = 'WRONG_PASSWORD';
    throw e;
  }
}

export async function unwrapWithRecovery(header, recoveryKey) {
  const parsed = parseRecovery(recoveryKey);
  if (!parsed || parsed.vaultId !== header.vaultId) {
    const e = new Error('恢复密钥格式不对，或者不是这个保险箱的');
    e.code = 'WRONG_RECOVERY';
    throw e;
  }
  try {
    const raw = await open(await aesKey(parsed.raw, ['decrypt']), header.recoveryWrap, wrapAad(header, 'recovery'));
    if (raw.length !== 32) throw new Error();
    return raw;
  } catch {
    const e = new Error('恢复密钥不对');
    e.code = 'WRONG_RECOVERY';
    throw e;
  }
}

/** 换主密码：保留原来的恢复密钥。 */
export async function rewrapPassword(header, master, newPassword) {
  const err = checkPassword(newPassword);
  if (err) throw new Error(err);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const next = { ...header, kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: KDF_ITERATIONS, salt: base64url(salt) } };
  next.passwordWrap = await seal(await derive(newPassword, salt), master, wrapAad(next, 'password'));
  next.updatedAt = Date.now();
  return next;
}

/** 重新生成恢复密钥：头信息升级成新格式，旧恢复密钥立即失效。需要主密码。 */
export async function regenerateRecovery(header, master, password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const recovery = crypto.getRandomValues(new Uint8Array(32));
  const next = {
    format: HEADER_V2,
    vaultId: header.vaultId,
    keyId: header.keyId,
    kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: KDF_ITERATIONS, salt: base64url(salt) },
    createdAt: header.createdAt,
    updatedAt: Date.now(),
  };
  next.passwordWrap = await seal(await derive(password, salt), master, wrapAad(next, 'password'));
  next.recoveryWrap = await seal(await aesKey(recovery, ['encrypt']), master, wrapAad(next, 'recovery'));
  return { header: next, recoveryKey: recoveryText(next.vaultId, recovery) };
}

function recordAad(vaultId, keyId, recordId) {
  return JSON.stringify(['sq.vault/2', vaultId, keyId, recordId]);
}

export async function encryptRecord(master, header, recordId, plaintext) {
  const key = await aesKey(master, ['encrypt']);
  const box = await seal(key, enc.encode(JSON.stringify(plaintext)), recordAad(header.vaultId, header.keyId, recordId));
  return { v: 2, vaultId: header.vaultId, keyId: header.keyId, iv: box.iv, ciphertext: box.ciphertext };
}

export async function decryptRecord(master, recordId, cipher) {
  const key = await aesKey(master, ['decrypt']);
  const raw = await open(key, cipher, recordAad(cipher.vaultId, cipher.keyId, recordId));
  return JSON.parse(dec.decode(raw));
}

