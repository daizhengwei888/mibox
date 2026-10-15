// Static-page publishing. Drafts are local to this account; secrets never leave the worker.
import * as db from './db.js';
import * as vault from './vault.js';
import * as workspace from './workspace.js';
import { UserError } from './errors.js';
import { base64url, fromBase64url, sha256Hex } from '../shared/util.js';
import { stable } from './merge.js';
import { inspectGitHub, deployGitHub, checkGitHub, removeGitHub } from './publish-github.js';
import { inspectCloudflare, deployCloudflare, checkCloudflare, removeCloudflare } from './publish-cloudflare.js';

const ORIGINS = { github: 'https://api.github.com', cloudflare: 'https://api.cloudflare.com' };
const DRAFT_TTL = 30 * 60 * 1000;
const DELETE_TTL = 24 * 60 * 60 * 1000;
const storage = db.database('mibox-publish');
const active = new Map();
const checking = new Map();
const preparing = new Set();
const removing = new Set();
const MIME = { html: 'text/html', htm: 'text/html', css: 'text/css', js: 'application/javascript', mjs: 'application/javascript', json: 'application/json', map: 'application/json', txt: 'text/plain', xml: 'application/xml', svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', ico: 'image/x-icon', avif: 'image/avif', woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf', eot: 'application/vnd.ms-fontobject', pdf: 'application/pdf', mp3: 'audio/mpeg', mp4: 'video/mp4', webm: 'video/webm', ogg: 'audio/ogg', wasm: 'application/wasm', webmanifest: 'application/manifest+json' };

export function validateFiles(input) {
  if (!Array.isArray(input) || !input.length || input.length > 200) throw new UserError('请选择 1–200 个静态文件');
  const paths = new Set();
  let total = 0;
  const files = input.map((file) => {
    const path = file?.path;
    if (typeof path !== 'string' || path.length > 500 || path.startsWith('/') || /[\\\x00-\x1f\x7f?#]/.test(path) || path.split('/').some((part) => !part || part === '.' || part === '..')) throw new UserError('文件路径无效，请重新选择输出目录');
    const parts = path.split('/');
    if (parts.some((part) => (part.startsWith('.') && part !== '.well-known') || ['node_modules', '__MACOSX', 'functions'].includes(part)) || ['_worker.js', '.mibox-publish.json'].includes(path)) throw new UserError('所选目录包含私密配置、开发目录或服务端代码，请选择静态输出目录');
    if (paths.has(path)) throw new UserError('存在同名文件：' + path);
    paths.add(path);
    const ext = path.split('.').pop().toLowerCase();
    const type = MIME[ext] || (['_headers', '_redirects'].includes(path) ? 'text/plain' : null);
    if (!type) throw new UserError('暂不支持这种文件：' + path);
    if (typeof file.base64 !== 'string' || file.base64.length > 7 * 1024 * 1024 || file.base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(file.base64)) throw new UserError('文件内容无效：' + path);
    let size;
    try { size = atob(file.base64).length; } catch { throw new UserError('无法读取文件：' + path); }
    if (size > 5 * 1024 * 1024) throw new UserError('单个文件不能超过 5 MiB：' + path);
    total += size;
    if (total > 20 * 1024 * 1024) throw new UserError('本次文件总大小不能超过 20 MiB');
    return { path, type, size, base64: file.base64 };
  });
  if (!paths.has('index.html')) throw new UserError('输出目录根部需要 index.html；单个 HTML 文件可自动作为首页');
  return { files, totalBytes: total };
}

function targetFor(provider, input = {}) {
  if (provider === 'github') {
    const repo = String(input.repo || '').trim();
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9_.-]{1,100}$/.test(repo) || repo.split('/').some((s) => s === '.' || s === '..')) throw new UserError('仓库请填写 owner/repo，例如 your-name/my-page');
    return { repo, ...(input.createRepo === true ? { createRepo: true } : {}) };
  }
  if (provider === 'cloudflare') {
    const accountId = String(input.accountId || '').trim();
    const project = String(input.project || '').trim();
    if (!/^[a-fA-F0-9]{32}$/.test(accountId)) throw new UserError('Cloudflare Account ID 应为 32 位十六进制字符');
    if (!/^[a-z0-9](?:[a-z0-9-]{0,56}[a-z0-9])?$/.test(project)) throw new UserError('项目名请使用小写字母、数字和中划线，最多 58 位');
    return { accountId, project, ...(input.createProject === true ? { createProject: true } : {}) };
  }
  throw new UserError('不支持的发布平台');
}

function tokenOf(entry) {
  const token = entry?.kind === 'key' ? String(entry.secret?.secret || '').trim() : '';
  if (!token || token.length > 4096 || /\s/.test(token)) throw new UserError('请选择保险箱中保存访问令牌的「密钥和令牌」条目', 'BAD_TOKEN');
  return token;
}

function assertWorkspace(snapshot) {
  const current = workspace.current();
  if (snapshot.id !== current.id || snapshot.epoch !== current.epoch) throw new UserError('资料库已切换，请重新操作', 'WORKSPACE_CHANGED');
}

async function deviceKey(create = false) {
  return storage.exclusive(async () => {
    let key = await storage.kvGet('pub-device-key');
    if (!key && create) {
      key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
      await storage.kvSet('pub-device-key', key);
    }
    if (key && (key.type !== 'secret' || key.algorithm?.name !== 'AES-GCM' || key.extractable !== false)) throw new UserError('本机发布授权不可用，请重新授权', 'PUBLISH_AUTH_REQUIRED');
    return key;
  });
}

async function sealAccess(value, aad) {
  const key = await deviceKey(true), iv = crypto.getRandomValues(new Uint8Array(12));
  const bytes = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(aad) }, key, new TextEncoder().encode(JSON.stringify(value))));
  return { v: 1, iv: base64url(iv), ciphertext: base64url(bytes) };
}

async function openAccess(box, aad) {
  if (!box || box.v !== 1) return null;
  const key = await deviceKey();
  if (!key) return null;
  try {
    const bytes = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64url(box.iv), additionalData: new TextEncoder().encode(aad) }, key, fromBase64url(box.ciphertext));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch { return null; }
}

const credentialKey = (w, provider, tokenId) => `credential:${w.id}:${provider}:${tokenId}`;
async function credentialContext(provider, tokenId) {
  if (!Object.hasOwn(ORIGINS, provider)) throw new UserError('不支持的发布平台');
  const w = workspace.current();
  const [header, row] = await Promise.all([vault.getHeader(), db.get('vault', tokenId)]);
  if (!header || !row || row.deleted || row.kind !== 'key' || !row.cipher) return null;
  const revision = await sha256Hex(stable(row.cipher));
  assertWorkspace(w);
  return { w, row, aad: stable(['mibox-publish-credential/1', w.id, provider, tokenId, header.vaultId, header.keyId, revision]) };
}

export async function grantCredential(provider, tokenId, entry) {
  const context = await credentialContext(provider, tokenId);
  if (!context || !entry?.cipher || stable(context.row.cipher) !== stable(entry.cipher)) throw new UserError('访问令牌已变化，请重新连接或授权', 'PUBLISH_CREDENTIAL_CHANGED');
  const box = await sealAccess({ token: tokenOf(entry) }, context.aad);
  assertWorkspace(context.w);
  await storage.kvSet(credentialKey(context.w, provider, tokenId), box);
  return { ready: true };
}

async function cachedCredential(provider, tokenId) {
  const w = workspace.current();
  const box = await storage.kvGet(credentialKey(w, provider, tokenId));
  if (!box) return null;
  const context = await credentialContext(provider, tokenId);
  if (!context) return null;
  const value = await openAccess(box, context.aad);
  assertWorkspace(w);
  return typeof value?.token === 'string' && value.token && value.token.length <= 4096 && !/\s/.test(value.token) ? value.token : null;
}

export async function credentialReady(provider, tokenId) {
  if (await cachedCredential(provider, tokenId)) return true;
  if (!(await vault.status()).unlocked) return false;
  try { await grantCredential(provider, tokenId, await vault.secretFor(tokenId)); return true; }
  catch (error) {
    if (['LOCKED', 'NOT_FOUND', 'BAD_TOKEN', 'DECRYPT_FAILED', 'PUBLISH_CREDENTIAL_CHANGED'].includes(error.code)) return false;
    throw error;
  }
}

export async function authorizeCreate({ provider, tokenId, password } = {}) {
  if (!Object.hasOwn(ORIGINS, provider)) throw new UserError('请选择 GitHub 或 Cloudflare');
  const w = workspace.current(), saved = await db.kvGet('publish.connection.' + provider);
  tokenId ||= saved?.tokenId;
  if (!saved || saved.tokenId !== tokenId) throw new UserError('请先连接这个平台', 'NOT_CONNECTED');
  const { entries } = await vault.verifyPassword(password, [tokenId]);
  assertWorkspace(w);
  const entry = entries.find((row) => row.id === tokenId);
  if (!entry) throw new UserError('发布凭证无法读取，请重新连接平台', 'BAD_TOKEN');
  return grantCredential(provider, tokenId, entry);
}

async function deleteContext() {
  const w = workspace.current(), header = await vault.getHeader();
  if (!header) return null;
  const fingerprint = await sha256Hex(stable(header));
  assertWorkspace(w);
  return { w, header, aad: stable(['mibox-publish-delete/1', w.id, w.epoch, fingerprint]) };
}

export async function deleteAccess() {
  const context = await deleteContext();
  if (!context) return { authorized: false, expiresAt: 0 };
  const value = await openAccess(await storage.kvGet('delete-access:' + context.w.id), context.aad);
  const now = Date.now();
  const authorized = Number.isSafeInteger(value?.authorizedAt) && Number.isSafeInteger(value?.expiresAt) && value.authorizedAt <= now && value.expiresAt === value.authorizedAt + DELETE_TTL && value.expiresAt > now;
  assertWorkspace(context.w);
  return { authorized, expiresAt: authorized ? value.expiresAt : 0 };
}

export async function authorizeDelete({ password } = {}) {
  const w = workspace.current();
  const [github, cloudflare, sites] = await Promise.all([db.kvGet('publish.connection.github'), db.kvGet('publish.connection.cloudflare'), storage.kvGet(sitesKey())]);
  const bindings = [...(sites || []).filter((site) => site.status !== 'removed').map((site) => ({ provider: site.provider, tokenId: site.tokenId })), { provider: 'github', tokenId: github?.tokenId }, { provider: 'cloudflare', tokenId: cloudflare?.tokenId }].filter((entry) => Object.hasOwn(ORIGINS, entry.provider) && entry.tokenId);
  const proof = await vault.verifyPassword(password, [...new Set(bindings.map((entry) => entry.tokenId))]);
  assertWorkspace(w);
  for (const binding of new Map(bindings.map((entry) => [entry.provider + ':' + entry.tokenId, entry])).values()) {
    const entry = proof.entries.find((row) => row.id === binding.tokenId);
    if (!entry) continue;
    try { await grantCredential(binding.provider, binding.tokenId, entry); }
    catch (error) { if (!['BAD_TOKEN', 'PUBLISH_CREDENTIAL_CHANGED'].includes(error.code)) throw error; }
  }
  const context = await deleteContext();
  if (!context || stable(context.header) !== stable(proof.header)) throw new UserError('保险箱已变化，请重新验证', 'PUBLISH_DELETE_AUTH_REQUIRED');
  const authorizedAt = Date.now(), expiresAt = authorizedAt + DELETE_TTL;
  const box = await sealAccess({ authorizedAt, expiresAt }, context.aad);
  assertWorkspace(w);
  await storage.kvSet('delete-access:' + w.id, box);
  return { authorized: true, expiresAt };
}

export async function apiFor(provider, tokenId) {
  const origin = Object.hasOwn(ORIGINS, provider) ? ORIGINS[provider] : '';
  if (!origin || !(await chrome.permissions.contains({ origins: [origin + '/*'] }))) throw new UserError('尚未允许访问发布平台，请点击检查目标并授权', 'NO_PERMISSION');
  let token = await cachedCredential(provider, tokenId);
  if (!token) {
    try {
      const entry = await vault.secretFor(tokenId);
      token = tokenOf(entry);
      const saved = await db.kvGet('publish.connection.' + provider);
      const knownSite = saved?.tokenId === tokenId || (await storage.kvGet(sitesKey()) || []).some((site) => site.provider === provider && site.tokenId === tokenId && site.status !== 'removed');
      if (knownSite) await grantCredential(provider, tokenId, entry);
    } catch (error) {
      if (error.code === 'LOCKED') throw new UserError('这个连接需要完成一次发布授权，之后创建网页无需解锁保险箱', 'PUBLISH_AUTH_REQUIRED');
      throw error;
    }
  }
  return platformApi(provider, token);
}

function cloudflareOperation(path, method) {
  const endpoint = path.split('?')[0];
  if (endpoint === '/accounts') return '读取账号列表';
  if (endpoint === '/user/tokens/verify') return '验证令牌';
  if (/\/pages\/projects$/.test(endpoint)) return method === 'GET' ? '读取 Pages 项目列表' : '创建 Pages 项目';
  if (/\/pages\/projects\/[^/]+$/.test(endpoint)) return method === 'DELETE' ? '删除 Pages 项目' : '检查 Pages 项目';
  if (endpoint.endsWith('/upload-token')) return '获取上传凭证';
  if (endpoint.startsWith('/pages/assets/')) return '上传网页资源';
  if (endpoint.includes('/deployments')) return method === 'POST' ? '提交网页部署' : '读取构建状态';
  return '处理请求';
}

function cloudflareDetails(data, secrets) {
  const errors = Array.isArray(data?.errors) ? data.errors.slice(0, 2).flatMap((error) => [error, ...(Array.isArray(error?.error_chain) ? error.error_chain.slice(0, 2) : [])]).slice(0, 3) : [];
  const clean = (message) => {
    let value = message;
    for (const secret of secrets.filter(Boolean)) {
      value = value.replaceAll(secret, '<redacted>').replaceAll(encodeURIComponent(secret), '<redacted>');
    }
    return value.replace(/Bearer\s+[^\s"'<>]+/gi, 'Bearer <redacted>').replace(/[A-Za-z0-9_-]{32,}/g, '<redacted>').replace(/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300);
  };
  const providerCode = errors.find((error) => Number.isSafeInteger(error?.code) && error.code > 0)?.code;
  const detail = errors.filter((error) => typeof error?.message === 'string').map((error) => clean(error.message)).filter(Boolean).join('；');
  return { providerCode, detail };
}

export function platformApi(provider, token) {
  const origin = Object.hasOwn(ORIGINS, provider) ? ORIGINS[provider] : '';
  if (!origin || typeof token !== 'string' || !token || /\s/.test(token)) throw new UserError('访问凭证格式无效', 'BAD_TOKEN');
  return async (path, { method = 'GET', body, allow404 = false, jwt } = {}) => {
    if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\') || (jwt && (provider !== 'cloudflare' || !path.startsWith('/pages/assets/')))) throw new UserError('发布请求地址无效');
    const headers = { Authorization: 'Bearer ' + (jwt || token) };
    if (provider === 'github') { headers.Accept = 'application/vnd.github+json'; headers['X-GitHub-Api-Version'] = '2026-03-10'; }
    const form = body instanceof FormData;
    if (body !== undefined && !form) headers['Content-Type'] = 'application/json';
    let response;
    try {
      response = await fetch(origin + (provider === 'cloudflare' ? '/client/v4' : '') + path, { method, headers, redirect: 'error', signal: AbortSignal.timeout(30000), ...(body === undefined ? {} : { body: form ? body : JSON.stringify(body) }) });
    } catch {
      throw new UserError('连接发布平台失败或超时。若已提交，请先检查服务商状态再重试', 'PUBLISH_NETWORK');
    }
    if (response.status === 404 && allow404) return null;
    if (response.status === 204) return null;
    const data = await response.json().catch(() => null);
    if (!response.ok || (provider === 'cloudflare' && data?.success === false)) {
      const message = response.status === 401 ? '访问令牌无效或已过期，请检查保险箱中的令牌'
        : response.status === 403 ? '发布平台拒绝访问，请检查令牌权限、目标范围或请求额度'
        : response.status === 429 ? '发布平台暂时限制请求，请稍后重新检查'
        : response.status === 404 ? '找不到目标，或访问令牌无权读取它'
        : `发布平台未接受请求（HTTP ${response.status}），请重新检查目标与权限`;
      const info = provider === 'cloudflare' ? cloudflareDetails(data, [token, jwt]) : null;
      const description = info ? `Cloudflare ${cloudflareOperation(path, method)}失败（HTTP ${response.status}${info.providerCode ? `，错误码 ${info.providerCode}` : ''}）：${info.detail || message}` : message;
      const error = new UserError(description, 'PUBLISH_HTTP');
      error.status = response.status;
      if (info?.providerCode) error.providerCode = info.providerCode;
      throw error;
    }
    if (!data) throw new UserError('发布平台返回了无法识别的响应', 'PUBLISH_RESPONSE');
    return provider === 'cloudflare' ? data.result : data;
  };
}

function key() { return 'draft:' + workspace.current().id; }
function sitesKey() { return 'sites:' + workspace.current().id; }
function siteId(provider, target) { return provider + ':' + (provider === 'github' ? target.repo.toLowerCase() : target.accountId.toLowerCase() + '/' + target.project); }
function pageName(value, target) { return String(value || target.repo?.split('/')[1] || target.project || '未命名网页').trim().slice(0, 80); }
function publicJob(job) {
  if (!job) return null;
  const { id, name, provider, target, tokenId, status, review, totalBytes, createdAt, progress, result, error } = job;
  return { id, name: pageName(name, target), provider, target, tokenId, status, review, totalBytes, createdAt, progress, result, error, files: (job.files || []).map(({ path, size, type }) => ({ path, size, type })) };
}

function publicSite(site) {
  const { id, name, provider, target, status, url, createdAt, updatedAt, error } = site;
  return { id, name, provider, target, status, url, createdAt, updatedAt, error };
}

async function rememberSite(job) {
  if (!job?.result || !['building', 'live', 'failed'].includes(job.status)) return;
  const target = targetFor(job.provider, job.target);
  delete target.createRepo; delete target.createProject;
  const id = siteId(job.provider, target);
  await storage.exclusive(async () => {
    const rows = await storage.kvGet(sitesKey()) || [];
    const previous = rows.find((row) => row.id === id);
    if (previous?.status === 'removed' && (previous.jobId ? previous.jobId === job.id : previous.removedAt >= job.createdAt)) return;
    if (previous?.status !== 'removed' && previous?.jobCreatedAt > job.createdAt) return;
    const next = { id, name: pageName(job.name, target), provider: job.provider, target, tokenId: job.tokenId, status: job.status, url: job.result.url || '', result: job.result, error: job.error || '', jobId: job.id, jobCreatedAt: job.createdAt, createdAt: previous?.createdAt || job.createdAt, updatedAt: Date.now() };
    await storage.kvSet(sitesKey(), [next, ...rows.filter((row) => row.id !== id)]);
  });
}

export async function sites({ provider } = {}) {
  if (provider && !ORIGINS[provider]) throw new UserError('不支持的发布平台');
  const latest = await storage.kvGet(key());
  if (!removing.has(sitesKey())) await rememberSite(latest);
  const rows = await storage.kvGet(sitesKey()) || [];
  return rows.filter((row) => row.status !== 'removed' && (!provider || row.provider === provider)).sort((a, b) => b.updatedAt - a.updatedAt).map(publicSite);
}

export async function removeSite({ id, tokenId, confirmed = false } = {}) {
  if (confirmed !== true) throw new UserError('请先确认删除公开网页', 'CONFIRM_REQUIRED');
  const identity = sitesKey();
  if (removing.has(identity) || preparing.has(key())) throw new UserError('正在处理网页操作，请稍候', 'PUBLISH_BUSY');
  removing.add(identity);
  try {
    const draft = await storage.kvGet(key());
    if (draft && active.has(draft.id)) throw new UserError('正在上传网页，请完成后再删除', 'PUBLISH_BUSY');
    if (draft && checking.has(draft.id)) await checking.get(draft.id);
    const rows = await storage.kvGet(identity) || [];
    const site = rows.find((row) => row.id === id && row.status !== 'removed');
    if (!site) throw new UserError('这一网页记录已不存在，请刷新后重试', 'NOT_FOUND');
    if (!(await deleteAccess()).authorized) throw new UserError('请先输入主密码验证删除权限，验证后 24 小时内无需重复输入', 'PUBLISH_DELETE_AUTH_REQUIRED');
    const siteCheck = checking.get(identity + ':' + id);
    if (siteCheck) await siteCheck;
    const target = targetFor(site.provider, site.target);
    const api = await apiFor(site.provider, tokenId || site.tokenId);
    const result = site.provider === 'github' ? await removeGitHub(target, api) : await removeCloudflare(target, api);
    await storage.exclusive(async () => {
      const currentRows = await storage.kvGet(identity) || [];
      const removedAt = Date.now();
      await storage.kvSet(identity, currentRows.map((row) => row.id === id ? { ...row, status: 'removed', removedAt, updatedAt: removedAt, result: null, error: '' } : row));
      const current = await storage.kvGet(key());
      if (current && siteId(current.provider, current.target) === id) {
        await storage.kvSet(key(), { ...current, status: 'removed', error: '', result: current.result ? { ...current.result, status: 'removed', message: '网页已删除' } : null, progress: { message: '网页已删除' }, files: current.files.map(({ base64, ...file }) => file) });
      }
    });
    return { ...result, id };
  } finally { removing.delete(identity); }
}

export async function checkSite({ id, tokenId } = {}) {
  const identity = sitesKey();
  if (removing.has(identity)) throw new UserError('正在删除网页，请稍候', 'PUBLISH_BUSY');
  const tag = identity + ':' + id;
  if (checking.has(tag)) return checking.get(tag);
  const task = (async () => {
    const rows = await storage.kvGet(identity) || [];
    const site = rows.find((row) => row.id === id && row.status !== 'removed');
    if (!site) throw new UserError('这一网页记录已不存在', 'NOT_FOUND');
    if (site.status !== 'building') return publicSite(site);
    const api = await apiFor(site.provider, tokenId || site.tokenId);
    const result = site.provider === 'github' ? await checkGitHub(site.result, api) : await checkCloudflare(site.result, api);
    let next;
    await storage.exclusive(async () => {
      const currentRows = await storage.kvGet(identity) || [];
      const current = currentRows.find((row) => row.id === id && row.status !== 'removed');
      if (!current) throw new UserError('网页已删除，请刷新列表', 'NOT_FOUND');
      if (current.jobCreatedAt !== site.jobCreatedAt) { next = current; return; }
      next = { ...current, result, status: result.status === 'live' ? 'live' : result.status === 'failed' ? 'failed' : 'building', error: result.status === 'failed' ? result.message || '构建失败' : '', updatedAt: Date.now() };
      await storage.kvSet(identity, currentRows.map((row) => row.id === id ? next : row));
      const draft = await storage.kvGet(key());
      if (draft && draft.status === 'building' && siteId(draft.provider, draft.target) === id && draft.createdAt === site.jobCreatedAt) {
        await storage.kvSet(key(), { ...draft, status: next.status, result, error: next.error, progress: { completed: draft.files.length, total: draft.files.length, message: result.message || '正在构建网页' } });
      }
    });
    return publicSite(next);
  })().finally(() => checking.delete(tag));
  checking.set(tag, task);
  return task;
}
function livePlan(job, id) {
  if (!job || job.id !== id || job.epoch !== workspace.current().epoch) throw new UserError('发布草稿已变化，请重新检查目标', 'PLAN_CHANGED');
  return job;
}
async function save(job, replace = false) {
  return storage.exclusive(async () => {
    const existing = await storage.kvGet(key());
    if (!replace && existing?.id !== job.id) throw new UserError('发布记录已变化，请刷新后继续', 'PLAN_CHANGED');
    await storage.kvSet(key(), job);
  });
}

export async function status() {
  let job = await storage.kvGet(key());
  if (!job) return null;
  if (job.status === 'uploading' && !active.has(job.id)) { job = { ...job, status: 'interrupted', error: '后台上传已中断。远端可能已完成部分步骤，请重新检查目标后再发布' }; await save(job); }
  if (job.files?.some((f) => f.base64) && Date.now() - job.createdAt > DRAFT_TTL && !active.has(job.id)) {
    job = { ...job, files: job.files.map(({ base64, ...rest }) => rest), ...(job.status === 'ready' ? { status: 'failed', error: '发布草稿已过期，请重新选择文件并检查目标' } : {}) };
    await save(job);
  }
  return publicJob(job);
}

export async function prepare(payload = {}) {
  const identity = key();
  const old = await storage.kvGet(identity);
  if (preparing.has(identity) || removing.has(sitesKey()) || (old && active.has(old.id))) throw new UserError('正在处理另一次网页操作，请稍后重试', 'PUBLISH_BUSY');
  preparing.add(identity);
  try {
    await rememberSite(old);
    const target = targetFor(payload.provider, payload.target);
    const { files, totalBytes } = validateFiles(payload.files);
    const api = await apiFor(payload.provider, payload.tokenId);
    const review = payload.provider === 'github' ? await inspectGitHub(target, api) : await inspectCloudflare(target, api);
    const job = { id: crypto.randomUUID(), name: pageName(payload.name, target), epoch: workspace.current().epoch, provider: payload.provider, target, tokenId: payload.tokenId, files, totalBytes, review, status: 'ready', createdAt: Date.now() };
    await save(job, true);
    return publicJob(job);
  } finally { preparing.delete(identity); }
}

export async function start({ id, confirmed = false, confirmSourceChange = false } = {}) {
  if (confirmed !== true) throw new UserError('请先核对文件清单并确认公开发布', 'CONFIRM_REQUIRED');
  if (preparing.has(key()) || removing.has(sitesKey())) throw new UserError('正在处理网页操作，请稍后确认', 'PUBLISH_BUSY');
  const job = livePlan(await storage.kvGet(key()), id);
  if (job.status !== 'ready' || active.has(id)) throw new UserError('请重新检查目标后发布；不要重复提交', 'PUBLISH_BUSY');
  if (Date.now() - job.createdAt > DRAFT_TTL || job.files.some((f) => typeof f.base64 !== 'string')) throw new UserError('发布草稿已过期，请重新检查');
  if (job.review.needsSourceChange && confirmSourceChange !== true) throw new UserError('请确认是否切换现有网站的发布来源', 'CONFIRM_REQUIRED');
  const api = await apiFor(job.provider, job.tokenId);
  const epoch = workspace.current().epoch;
  if (active.has(id) || preparing.has(key()) || removing.has(sitesKey())) throw new UserError('正在处理网页任务，请稍后确认', 'PUBLISH_BUSY');
  active.set(id, true);
  job.status = 'uploading'; job.error = ''; job.progress = { completed: 0, total: job.files.length, message: '准备上传' };
  try { await save(job); } catch (error) { active.delete(id); throw error; }
  void workspace.run(async () => {
    const progress = async (value) => { job.progress = { ...job.progress, ...value }; await save(job); };
    try {
      const plan = { ...job.review, confirmSourceChange };
      job.result = job.provider === 'github' ? await deployGitHub(plan, job.files, api, progress) : await deployCloudflare(plan, job.files, api, progress);
      job.status = job.result.status === 'live' ? 'live' : 'building';
      job.progress = { completed: job.files.length, total: job.files.length, message: job.status === 'live' ? '网站已上线' : '上传已提交，等待平台构建' };
      job.files = job.files.map(({ base64, ...rest }) => rest);
      await save(job);
      await rememberSite(job);
    } catch (error) {
      job.status = 'failed';
      job.error = error?.user ? error.message : '发布未完成，请重新检查目标后再试';
      await save(job);
    } finally { active.delete(id); }
  }, epoch).catch(async () => { active.delete(id); });
  return publicJob(job);
}

export async function check({ id } = {}) {
  if (removing.has(sitesKey())) throw new UserError('正在删除网页，请稍候', 'PUBLISH_BUSY');
  const job = livePlan(await storage.kvGet(key()), id);
  if (job.status !== 'building') return publicJob(job);
  if (checking.has(id)) return checking.get(id);
  const pending = (async () => {
    const api = await apiFor(job.provider, job.tokenId);
    const result = job.provider === 'github' ? await checkGitHub(job.result, api) : await checkCloudflare(job.result, api);
    job.result = { ...job.result, ...result };
    job.status = result.status === 'live' ? 'live' : result.status === 'failed' ? 'failed' : 'building';
    job.progress = { completed: job.files.length, total: job.files.length, message: result.message || (job.status === 'live' ? '网页已上线' : '正在构建网页') };
    if (job.status === 'failed') job.error = result.message || '平台构建失败，请查看服务商控制台';
    await save(job);
    await rememberSite(job);
    return publicJob(job);
  })().finally(() => checking.delete(id));
  checking.set(id, pending);
  return pending;
}

export async function clear({ id } = {}) {
  livePlan(await storage.kvGet(key()), id); // 只校验 id 对得上，不对会抛错
  if (active.has(id) || preparing.has(key())) throw new UserError('上传仍在进行，暂不能清除本机记录', 'PUBLISH_BUSY');
  await storage.kvSet(key(), null);
  return { cleared: true };
}
