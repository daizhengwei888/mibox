// Explicit, tab-bound credential handoff from the provider's token creation page.
import * as db from './db.js';
import * as vault from './vault.js';
import * as workspace from './workspace.js';
import { apiFor, platformApi, grantCredential, credentialReady } from './publish.js';
import { UserError } from './errors.js';
import { emit } from './events.js';

const FLOW_KEY = 'mibox.publishConnect';
const TTL = 15 * 60 * 1000;
const HOSTS = { github: ['https://github.com/*', 'https://api.github.com/*'], cloudflare: ['https://dash.cloudflare.com/*', 'https://api.cloudflare.com/*'] };
const capturing = new Set();
const saving = new Set();

function providerOf(provider) {
  if (!Object.hasOwn(HOSTS, provider)) throw new UserError('请选择 GitHub 或 Cloudflare');
  return provider;
}
const connectionKey = (provider) => 'publish.connection.' + provider;
const saveKey = (provider) => workspace.current().epoch + ':' + provider;
function sameWorkspace(flow) { const w = workspace.current(); return flow?.workspaceId === w.id && flow?.epoch === w.epoch; }
export function issuerUrl(provider, value) {
  try {
    const url = new URL(value);
    return provider === 'github'
      ? url.origin === 'https://github.com' && /^\/settings\/personal-access-tokens(?:\/|$)/.test(url.pathname)
      : provider === 'cloudflare' && url.origin === 'https://dash.cloudflare.com' && /^\/profile\/api-tokens(?:\/|$)/.test(url.pathname);
  } catch { return false; }
}

export function connectUrl(provider) {
  providerOf(provider);
  if (provider === 'cloudflare') return 'https://dash.cloudflare.com/profile/api-tokens';
  const url = new URL('https://github.com/settings/personal-access-tokens/new');
  url.search = new URLSearchParams({ name: '谜盒网页发布', description: 'Publish static sites with Mibox', expires_in: '90', contents: 'write', pages: 'write', administration: 'write' });
  return url.href;
}

async function flow() {
  const rec = (await chrome.storage.session.get(FLOW_KEY))[FLOW_KEY];
  return rec && sameWorkspace(rec) && rec.expiresAt > Date.now() ? rec : null;
}

async function connection(provider) {
  const saved = await db.kvGet(connectionKey(provider));
  if (!saved?.tokenId) return null;
  const entry = await db.get('vault', saved.tokenId);
  return entry && !entry.deleted && entry.kind === 'key' ? saved : null;
}

export async function state({ provider } = {}) {
  providerOf(provider);
  const rec = await flow();
  const saved = await connection(provider);
  return {
    connection: saved ? { tokenId: saved.tokenId, profile: saved.profile, connectedAt: saved.connectedAt } : null,
    pending: rec?.provider === provider ? { provider, status: saved?.captureId === rec.nonce ? 'saved' : rec.status === 'capturing' && !capturing.has(rec.nonce) ? 'waiting' : rec.status, message: saved?.captureId === rec.nonce ? '凭证已加密存入保险箱' : rec.message || '' } : null,
    unlocked: (await vault.status()).unlocked,
    publishReady: saved ? await credentialReady(provider, saved.tokenId) : false,
  };
}

async function requirePermission(provider, all = false) {
  const origins = all ? HOSTS[provider] : [HOSTS[provider][1]];
  if (!(await chrome.permissions.contains({ origins }))) throw new UserError('请先允许连接平台所需的网站访问权限', 'NO_PERMISSION');
}

async function profileFor(provider, api) {
  if (provider === 'github') {
    const user = await api('/user');
    if (!user?.login || !/^[A-Za-z0-9-]{1,39}$/.test(user.login)) throw new UserError('无法确认 GitHub 账号');
    return { login: user.login, label: user.login, id: String(user.id || user.login) };
  }
  const verified = await api('/user/tokens/verify');
  if (verified?.status !== 'active') throw new UserError('Cloudflare 令牌尚未生效或已过期');
  return { label: 'Cloudflare', id: String(verified.id || '') };
}

async function validatedToken(provider, value) {
  providerOf(provider);
  if (typeof value !== 'string') throw new UserError('请使用官网刚生成的访问令牌', 'BAD_TOKEN');
  const token = value.trim();
  if (token.length < 20 || token.length > 4096 || /\s/.test(token)) throw new UserError('请只填写访问令牌本身，不要包含 Bearer 或说明文字', 'BAD_TOKEN');
  await requirePermission(provider);
  if (!(await vault.status()).unlocked) throw new UserError('请先解锁保险箱，再连接网站', 'LOCKED');
  return { token, profile: await profileFor(provider, platformApi(provider, token)) };
}

async function storeToken(provider, token, profile, captureId) {
  const entry = await vault.save({ kind: 'key', name: `${provider === 'github' ? 'GitHub' : 'Cloudflare'} 网页发布${profile.login ? ' · ' + profile.login : ''}`, secret: { secret: token, note: '由谜盒官网连接助手保存，用于静态网页发布。', fields: [{ label: '用途', value: 'mibox-pages:' + provider }] } });
  await grantCredential(provider, entry.id, await vault.secretFor(entry.id));
  const saved = { tokenId: entry.id, profile, connectedAt: Date.now(), ...(captureId ? { captureId } : {}) };
  await db.kvSet(connectionKey(provider), saved);
  emit('publish');
  return saved;
}

async function clearPending(provider) {
  const rec = await flow();
  if (rec?.provider === provider) await chrome.storage.session.remove(FLOW_KEY);
}

export async function save({ provider, token } = {}) {
  providerOf(provider);
  const key = saveKey(provider);
  if (saving.has(key)) throw new UserError('正在保存连接，请稍候', 'CONNECT_BUSY');
  saving.add(key);
  try {
    const valid = await validatedToken(provider, token);
    const saved = await storeToken(provider, valid.token, valid.profile);
    await clearPending(provider);
    return saved;
  } finally { saving.delete(key); }
}

export async function use({ provider, tokenId } = {}) {
  providerOf(provider);
  const key = saveKey(provider);
  if (saving.has(key)) throw new UserError('正在保存连接，请稍候', 'CONNECT_BUSY');
  saving.add(key);
  try {
    await requirePermission(provider);
    if (!(await vault.status()).unlocked) throw new UserError('请先解锁保险箱，再配置连接', 'LOCKED');
    const api = await apiFor(provider, tokenId);
    const profile = await profileFor(provider, api);
    await grantCredential(provider, tokenId, await vault.secretFor(tokenId));
    const saved = { tokenId, profile, connectedAt: Date.now() };
    await db.kvSet(connectionKey(provider), saved);
    await clearPending(provider);
    emit('publish');
    return saved;
  } finally { saving.delete(key); }
}

async function inject(rec, tab) {
  if (rec.status === 'saved' || !sameWorkspace(rec) || rec.expiresAt <= Date.now() || !issuerUrl(rec.provider, tab.url)) return;
  await chrome.scripting.executeScript({ target: { tabId: rec.tabId }, func: (config) => { window.__miboxPublishConnect = config; }, args: [{ provider: rec.provider, nonce: rec.nonce, expiresAt: rec.expiresAt }] });
  await chrome.scripting.executeScript({ target: { tabId: rec.tabId }, files: ['src/content/publish-connect.js'] });
}

export async function open({ provider } = {}, sender) {
  providerOf(provider);
  await requirePermission(provider, true);
  if (!(await vault.status()).unlocked) throw new UserError('请先创建或解锁保险箱，凭证才能加密保存', 'LOCKED');
  const current = await flow();
  if (saving.has(saveKey(provider)) || (current && capturing.has(current.nonce))) throw new UserError('正在保存官网凭证，请稍候', 'CONNECT_BUSY');
  // 先开空白页，绑定记录存好之前不会有任何跳转完成。
  const tab = await chrome.tabs.create({ url: 'about:blank', active: true });
  const w = workspace.current();
  const rec = { provider, tabId: tab.id, openerTabId: sender?.tab?.id, nonce: crypto.randomUUID(), workspaceId: w.id, epoch: w.epoch, expiresAt: Date.now() + TTL, status: 'waiting' };
  await chrome.storage.session.set({ [FLOW_KEY]: rec });
  try {
    const updated = await chrome.tabs.update(tab.id, { url: connectUrl(provider) });
    if (updated.status === 'complete') await inject(rec, updated);
  } catch {
    await chrome.storage.session.remove(FLOW_KEY);
    throw new UserError('无法打开官网连接助手，请重试');
  }
  return { opened: true };
}

export async function capture({ nonce, token } = {}, sender) {
  const rec = await flow();
  if (!rec || sender?.id !== chrome.runtime.id || sender?.tab?.id !== rec.tabId || sender.frameId !== 0 || nonce !== rec.nonce || !issuerUrl(rec.provider, sender.url)) throw new UserError('这次连接已过期，请从谜盒重新打开官网', 'FLOW_EXPIRED');
  if (rec.status === 'saved' || (await connection(rec.provider))?.captureId === nonce) return { saved: true };
  const key = saveKey(rec.provider);
  if (capturing.has(nonce) || saving.has(key)) throw new UserError('正在验证并保存，请稍候', 'CONNECT_BUSY');
  capturing.add(nonce);
  saving.add(key);
  try {
    await chrome.storage.session.set({ [FLOW_KEY]: { ...rec, status: 'capturing', message: '正在验证凭证并加密保存' } });
    const valid = await validatedToken(rec.provider, token);
    if ((await flow())?.nonce !== nonce) throw new UserError('这次连接已过期，请重新连接', 'FLOW_EXPIRED');
    await storeToken(rec.provider, valid.token, valid.profile, nonce);
    // 会话状态更新失败时，以已保存的连接回执为准。
    await chrome.storage.session.set({ [FLOW_KEY]: { ...rec, status: 'saved', message: '凭证已加密存入保险箱' } }).catch(() => {});
    const appUrl = chrome.runtime.getURL('src/ui/app/app.html');
    try {
      const opener = rec.openerTabId != null ? await chrome.tabs.get(rec.openerTabId) : null;
      if (opener?.url?.split(/[?#]/)[0] === appUrl) await chrome.tabs.update(opener.id, { active: true });
      else await chrome.tabs.create({ url: appUrl + '#/publish/' + rec.provider, active: true });
    } catch { await chrome.tabs.create({ url: appUrl + '#/publish/' + rec.provider, active: true }).catch(() => {}); }
    return { saved: true };
  } catch (error) {
    const message = error?.user ? error.message : '凭证未保存，请返回谜盒解锁或重新连接';
    if ((await flow())?.nonce === nonce) await chrome.storage.session.set({ [FLOW_KEY]: { ...rec, status: 'waiting', message } });
    throw new UserError(message, error?.user ? error.code : 'CONNECT_FAILED');
  } finally { capturing.delete(nonce); saving.delete(key); }
}

async function listPages(api, path, limit = 5, pageSize = 100) {
  const rows = [];
  for (let page = 1; page <= limit; page++) {
    const next = await api(path + (path.includes('?') ? '&' : '?') + 'per_page=' + pageSize + '&page=' + page);
    if (!Array.isArray(next)) throw new UserError('平台返回的列表格式无效');
    rows.push(...next);
    if (next.length < pageSize) return { rows, truncated: false };
  }
  return { rows, truncated: true };
}

export async function targets({ provider, tokenId, accountId } = {}) {
  providerOf(provider);
  const saved = await connection(provider);
  tokenId ||= saved?.tokenId;
  if (!tokenId) throw new UserError('请先连接账号');
  const api = await apiFor(provider, tokenId);
  if (provider === 'github') {
    const profile = await profileFor(provider, api);
    const { rows, truncated } = await listPages(api, '/user/repos?visibility=public&affiliation=owner,collaborator&sort=updated');
    return { profile, repositories: rows.filter((r) => !r.private && !r.archived && r.full_name && (r.permissions ? r.permissions.push || r.permissions.admin : r.owner?.login === profile.login)).map((r) => ({ repo: r.full_name, label: r.full_name, initialized: !!r.size })), truncated };
  }
  let accounts = [], needsAccountRead = false, accountsTruncated = false, accountDiscoveryError = '';
  try { const list = await listPages(api, '/accounts', 5, 50); accountsTruncated = list.truncated; accounts = list.rows.map((a) => ({ id: a.id, name: a.name || a.id })); }
  catch (error) {
    if (error.status === 403) needsAccountRead = true;
    else if (error.status === 400) accountDiscoveryError = error.message;
    else throw error;
  }
  if (!accountId && accounts.length === 1) accountId = accounts[0].id;
  if (!accountId) return { accounts, needsAccountRead, ...(accountDiscoveryError ? { accountDiscoveryError } : {}), ...(accountsTruncated ? { truncated: true } : {}) };
  if (!/^[a-fA-F0-9]{32}$/.test(accountId)) throw new UserError('账号编号无效');
  if (accounts.length && !accountsTruncated && !accounts.some((a) => a.id === accountId)) throw new UserError('这个账号不在授权范围内');
  const { rows, truncated } = await listPages(api, `/accounts/${accountId}/pages/projects`, 25, 10);
  return { accounts, needsAccountRead, accountId, ...(accountDiscoveryError ? { accountDiscoveryError } : {}), projects: rows.filter((p) => !p.source).map((p) => ({ name: p.name, label: p.name })), truncated };
}

export function install() {
  chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
    if (change.status !== 'complete') return;
    void workspace.run(async () => { const rec = await flow(); if (rec?.tabId === tabId) await inject(rec, tab); }).catch(() => {});
  });
  chrome.tabs.onRemoved.addListener((tabId) => {
    void workspace.run(async () => { const rec = await flow(); if (rec?.tabId === tabId) await chrome.storage.session.remove(FLOW_KEY); }).catch(() => {});
  });
}
workspace.onSwitch(async () => { await chrome.storage.session.remove(FLOW_KEY); });
