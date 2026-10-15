// Google 登录：直接用 Chrome 自带的账号（chrome.identity.getAuthToken），不经过任何中间服务器。
// 令牌由 Chrome 自己缓存和续期。只申请 drive.appdata（只能读写本插件自己的文件）、openid 和 email。

import * as workspace from './workspace.js';
import { emit } from './events.js';
import { UserError } from './errors.js';

export const SCOPES = ['https://www.googleapis.com/auth/drive.appdata', 'openid', 'email'];
const USERINFO = 'https://www.googleapis.com/oauth2/v3/userinfo';
const REVOKE = 'https://oauth2.googleapis.com/revoke';

let tokenCache = null; // { accessToken, expiresAt, googleSub }

function runtimeClientId() {
  return String(chrome.runtime.getManifest().oauth2?.client_id || '');
}

function validClientId(id) {
  const value = String(id || '');
  return /^\d+-[a-z0-9-]+\.apps\.googleusercontent\.com$/i.test(value) && !/REPLACE_WITH/i.test(value);
}

/** manifest.json 里填了真正的客户端 ID 才能登录。 */
export function clientConfigured() {
  return validClientId(runtimeClientId());
}

async function readAuth() {
  return workspace.getAuth();
}

/** 绑定缺失或客户端已换代时停在当前资料库，要求用户显式重新登录。 */
async function reconcileClientBinding(auth) {
  const currentId = runtimeClientId();
  if (!auth?.user || !validClientId(currentId)) return auth;
  if (!auth.clientId) {
    const next = { ...auth, clientId: currentId, reauth: true };
    tokenCache = null;
    await workspace.setAuth(next);
    emit(['google', 'sync']);
    return next;
  }
  if (auth.clientId !== currentId && (!auth.reauth || !auth.clientChanged)) {
    const next = { ...auth, reauth: true, clientChanged: true };
    tokenCache = null;
    await workspace.setAuth(next);
    emit(['google', 'sync']);
    return next;
  }
  return auth;
}

export async function status() {
  const a = await reconcileClientBinding(await readAuth());
  return {
    configured: clientConfigured(),
    signedIn: !!a?.user,
    user: a?.user ?? null,
    reauth: !!a?.reauth,
    otherAccount: a?.otherAccount || null,
    extensionId: chrome.runtime.id,
  };
}

/** 把 Chrome 的报错换成能看懂的话。 */
function explain(e) {
  const msg = String(e?.message || e || '');
  if (/did not approve|cancel|closed by the user|user denied/i.test(msg)) return new UserError('登录已取消', 'CANCELLED');
  if (/client.?id|bad client|invalid_client|OAuth2 client|unauthorized_client/i.test(msg)) {
    return new UserError(`Google 后台的客户端设置不对。请确认客户端类型是「Chrome 扩展程序」，并且填的插件 ID 是 ${chrome.runtime.id}`, 'BAD_CLIENT');
  }
  if (/sign.?in|signed out|not signed|turned off browser signin|no account/i.test(msg)) {
    return new UserError('请先登录 Chrome：点浏览器右上角的头像，登录你的 Google 账号', 'CHROME_SIGNIN');
  }
  if (/network|offline|connection/i.test(msg)) return new UserError('现在没有网络，改动先存在本机', 'NETWORK');
  if (/not granted|revoked|interaction required|requires? (user )?interaction/i.test(msg)) return new UserError('Google 登录已失效，请重新登录', 'REAUTH');
  return new UserError('Google 登录没有完成：' + msg, 'GOOGLE');
}

async function getToken(interactive) {
  let res;
  try {
    res = await chrome.identity.getAuthToken({ interactive, scopes: SCOPES });
  } catch (e) {
    throw explain(e);
  }
  const token = typeof res === 'string' ? res : res?.token;
  if (!token) throw new UserError('Google 没有返回登录凭据', 'GOOGLE');
  return token;
}

async function fetchUser(token) {
  let res;
  try {
    res = await fetch(USERINFO, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15000) });
  } catch {
    throw new UserError('现在没有网络，改动先存在本机', 'NETWORK');
  }
  if (res.status === 401) {
    await chrome.identity.removeCachedAuthToken({ token }).catch(() => {});
    throw new UserError('Google 登录已失效，请重新登录', 'REAUTH');
  }
  if (!res.ok) throw new UserError('读取 Google 账号信息失败（' + res.status + '）', 'GOOGLE');
  const data = await res.json();
  if (!data?.sub || !data?.email) throw new UserError('Google 没有返回账号信息', 'GOOGLE');
  return { googleSub: String(data.sub), email: String(data.email), name: String(data.name || '') };
}

/** 用 Chrome 当前登录的 Google 账号登录。需要在用户点击时调用。 */
export async function signIn() {
  if (!clientConfigured()) {
    throw new UserError('这个插件还没有配置 Google 登录：manifest.json 里的 client_id 还没填（见 README「配置 Google 登录」）', 'NOT_CONFIGURED');
  }
  return workspace.transition(async () => {
    const prev = await readAuth();
    const clientId = runtimeClientId();
    const token = await getToken(true);
    const user = await fetchUser(token);
    await workspace.activate({ user, clientId, signedInAt: Date.now() });
    tokenCache = { accessToken: token, expiresAt: Date.now() + 45 * 60000, googleSub: user.googleSub };
    emit(['google', 'sync']);
    return { user, switched: !!(prev?.user && prev.user.googleSub !== user.googleSub) };
  });
}

/** manifest 换客户端后清除当前扩展的 Chrome token 缓存，保留账号资料并要求重新登录。 */
export async function prepareClientChange({ clientId } = {}) {
  if (!validClientId(clientId)) throw new UserError('Google 客户端 ID 格式不完整或仍是占位符', 'BAD_CLIENT');
  if (clientId === runtimeClientId()) return { changed: false };
  const a = await readAuth();
  if (a?.user) await workspace.setAuth({ ...a, clientId: a.clientId || runtimeClientId(), reauth: true, clientChanged: true });
  tokenCache = null;
  await chrome.identity.clearAllCachedAuthTokens();
  if (a?.user) emit(['google', 'sync']);
  return { changed: true, reauth: !!a?.user };
}

/** 本机退出保留账号副本，不撤销 Google 授权。 */
export async function signOut() {
  return workspace.transition(async () => {
    tokenCache = null;
    await workspace.activate(null);
    emit(['google', 'sync']);
    return { ok: true };
  });
}

export async function revoke() {
  return workspace.transition(async () => {
    const token = await driveToken({ force: true });
    const response = await fetch(REVOKE, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'token=' + encodeURIComponent(token.accessToken), signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new UserError('撤销授权失败，请稍后重试', 'REVOKE');
    await chrome.identity.clearAllCachedAuthTokens();
    tokenCache = null;
    await workspace.activate(null);
    emit(['google', 'sync']);
    return { ok: true };
  });
}

workspace.onSwitch(() => { tokenCache = null; });

export function installIdentityListener() {
  chrome.identity.onSignInChanged.addListener(() => {
    const epoch = workspace.current().epoch;
    tokenCache = null;
    workspace.run(markReauth, epoch).catch(() => {});
  });
}

/** Drive 换了新令牌还是被拒绝：提示用户重新登录。 */
export async function markReauth() {
  const a = await readAuth();
  if (!a?.user || a.reauth) return;
  await workspace.setAuth({ ...a, reauth: true });
  tokenCache = null;
  emit(['google', 'sync']);
}

/**
 * 给 Drive 请求用的访问令牌。force=true 表示上一个令牌被拒绝了，先从 Chrome 缓存里删掉再要新的。
 * Chrome 换了登录账号时停下来，让用户确认，避免把资料同步进别人的 Drive。
 */
export async function driveToken({ force = false } = {}) {
  const a = await reconcileClientBinding(await readAuth());
  if (!a?.user) throw new UserError('还没有登录 Google', 'NOT_SIGNED_IN');
  const expected = workspace.current();
  if (a.reauth) throw new UserError('请重新登录 Google 后同步', 'REAUTH');
  if (force && tokenCache?.accessToken) await chrome.identity.removeCachedAuthToken({ token: tokenCache.accessToken }).catch(() => {});
  tokenCache = null;
  let token;
  try {
    token = await getToken(false);
  } catch (e) {
    if (e.code === 'REAUTH' || e.code === 'CHROME_SIGNIN') {
      await workspace.setAuth({ ...a, reauth: true });
      emit(['google', 'sync']);
      throw new UserError(e.code === 'CHROME_SIGNIN' ? e.message : 'Google 登录已失效，请重新登录', 'REAUTH');
    }
    throw e;
  }
  let user;
  try { user = await fetchUser(token); }
  catch (e) {
    if (e.code === 'REAUTH') await markReauth();
    throw e;
  }
  if (workspace.current().epoch !== expected.epoch) throw new UserError('账号已切换，旧请求已停止', 'WORKSPACE_CHANGED');
  if (user.googleSub !== a.user.googleSub) {
    await workspace.setAuth({ ...a, reauth: true, otherAccount: user.email });
    emit(['google', 'sync']);
    throw new UserError(`Chrome 现在登录的是 ${user.email}，不是 ${a.user.email}。请在设置里重新登录确认要用哪个账号`, 'ACCOUNT_CHANGED');
  }
  if (a.reauth || a.otherAccount) {
    await workspace.setAuth({ user: a.user, clientId: a.clientId, signedInAt: a.signedInAt });
    emit(['google', 'sync']);
  }
  tokenCache = { accessToken: token, expiresAt: Date.now() + 45 * 60000, googleSub: user.googleSub };
  return tokenCache;
}
