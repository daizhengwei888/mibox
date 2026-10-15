import * as workspace from './workspace.js';
// Google Drive 应用私有空间（appDataFolder）的最小客户端：查找、下载、上传、删除一个文件。

import { driveToken, markReauth } from './google.js';
import { UserError } from './errors.js';

const API = 'https://www.googleapis.com';
const MAX_UPLOAD = 5 * 1024 * 1024;

async function request(path, init = {}, retried = false, expected = workspace.current()) {
  if (workspace.current().epoch !== expected.epoch) throw new UserError("账号已切换，旧请求已停止", "WORKSPACE_CHANGED");
  const token = await driveToken({ force: retried });
  if (workspace.current().epoch !== expected.epoch) throw new UserError('账号已切换，旧请求已停止', 'WORKSPACE_CHANGED');
  if (token.googleSub !== expected.account?.googleSub) throw new UserError("登录身份与资料库不一致", "ACCOUNT_CHANGED");
  let res;
  try {
    res = await fetch(API + path, {
      ...init,
      redirect: 'manual',
      signal: AbortSignal.timeout(30000),
      headers: { ...(init.headers || {}), authorization: `Bearer ${token.accessToken}` },
    });
  } catch (e) {
    if (e?.name === 'TimeoutError') throw new UserError('连接 Google Drive 超时', 'NETWORK');
    throw new UserError('现在没有网络，改动先存在本机', 'NETWORK');
  }
  if (workspace.current().epoch !== expected.epoch) throw new UserError("账号已切换，旧响应已停止", "WORKSPACE_CHANGED");
  if (res.status === 401 && !retried) return request(path, init, true, expected);
  if (res.status === 401) {
    await markReauth();
    throw new UserError('Google 登录已过期，请重新登录', 'REAUTH');
  }
  if (res.status === 403 || res.status === 429) {
    const text = await res.text().catch(() => '');
    if (/insufficient|scope/i.test(text)) {
      await markReauth();
      throw new UserError('没有 Drive 应用私有空间的权限，请重新登录 Google', 'REAUTH');
    }
    if (/accessNotConfigured|has not been used|is disabled/i.test(text)) throw new UserError('Google Cloud 项目里还没有启用 Google Drive API（见 README「配置 Google 登录」第 2 步）', 'DRIVE_API_OFF');
    throw new UserError('Google Drive 暂时限制了请求，稍后会自动重试', 'RATE_LIMIT');
  }
  if (res.status >= 500) throw new UserError('Google Drive 暂时不可用，稍后会自动重试', 'SERVICE');
  return res;
}

export async function findFile(name) {
  const files = [];
  let pageToken = '';
  do {
    const q = new URLSearchParams({ spaces: 'appDataFolder', q: `name='${name.replace(/'/g, "\\'")}' and trashed=false`, fields: 'nextPageToken,files(id,name,modifiedTime,size)', orderBy: 'modifiedTime desc', pageSize: '100' });
    if (pageToken) q.set('pageToken', pageToken);
    const res = await request('/drive/v3/files?' + q.toString());
    if (!res.ok) throw new UserError('读取 Drive 文件列表失败（' + res.status + '）', 'DRIVE');
    const data = await res.json();
    files.push(...(Array.isArray(data.files) ? data.files : []));
    pageToken = data.nextPageToken || '';
    if (files.length > 1000) throw new UserError('同名云文件过多，请先人工处理', 'REMOTE_DUPLICATES');
  } while (pageToken);
  return files;
}

export async function download(fileId) {
  const res = await request(`/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`);
  if (res.status === 404) return null;
  if (!res.ok) throw new UserError('下载同步文件失败（' + res.status + '）', 'DRIVE');
  return new Uint8Array(await res.arrayBuffer());
}

export async function create(name, bytes) {
  if (bytes.byteLength > MAX_UPLOAD) throw new UserError('资料太多了，同步文件超过 5 MB', 'TOO_LARGE');
  const boundary = 'sq' + crypto.randomUUID().replace(/-/g, '');
  const meta = JSON.stringify({ name, parents: ['appDataFolder'], mimeType: 'application/gzip' });
  const body = new Blob([
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n`,
    `--${boundary}\r\nContent-Type: application/gzip\r\n\r\n`,
    bytes,
    `\r\n--${boundary}--`,
  ]);
  const res = await request('/upload/drive/v3/files?uploadType=multipart&fields=id,modifiedTime', {
    method: 'POST',
    headers: { 'content-type': `multipart/related; boundary=${boundary}` },
    body,
  });
  if (!res.ok) throw new UserError('上传同步文件失败（' + res.status + '）', 'DRIVE');
  return res.json();
}

export async function remove(fileId) {
  const res = await request(`/drive/v3/files/${encodeURIComponent(fileId)}`, { method: 'DELETE' });
  if (!res.ok && res.status !== 404) throw new UserError('删除云端资料失败（' + res.status + '）', 'DRIVE');
}

export async function gzip(text) {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function gunzip(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).text();
}
