// 界面与后台通信。所有读写都经过后台，界面只负责显示。

export class CallError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code || 'ERROR';
  }
}

let workspaceEpoch = null;
let workspaceId = null;
let workspaceSwitching = false;
let workspaceInvalidated = false;
let handshake = null;
const TRANSITION_TYPES = new Set(['google.signIn', 'google.signOut', 'google.revoke', 'workspace.copyLocal']);

// 网页里那个搜索浮层嵌在别人的页面里，后台要求它每条消息都带上一次性令牌。
let overlayToken = null;

export function setOverlayToken(token) {
  overlayToken = token || null;
}

export function getWorkspaceEpoch() {
  return workspaceEpoch;
}

export function getWorkspaceId() {
  return workspaceId;
}

function showWorkspaceSwitching() {
  if (typeof document === 'undefined' || document.getElementById('workspace-switching')) return;
  const cover = document.createElement('div');
  cover.id = 'workspace-switching';
  cover.setAttribute('role', 'status');
  cover.textContent = '正在切换账号…';
  Object.assign(cover.style, {
    position: 'fixed', inset: '0', zIndex: '2147483647', display: 'grid', placeItems: 'center',
    background: 'var(--bg, #fff)', color: 'var(--text, #222)', font: '600 16px system-ui',
  });
  document.documentElement.appendChild(cover);
}

function invalidateWorkspace() {
  workspaceInvalidated = true;
  showWorkspaceSwitching();
  if (typeof location !== 'undefined') setTimeout(() => location.reload(), 0);
}

async function send(type, payload, epoch) {
  try {
    return await chrome.runtime.sendMessage({ sq: 1, type, payload, ...(epoch === undefined ? {} : { epoch }), ...(overlayToken ? { overlayToken } : {}) });
  } catch (e) {
    throw new CallError('插件后台没有响应，请稍后再试', 'NO_BACKGROUND');
  }
}

async function ensureWorkspace() {
  if (workspaceSwitching || workspaceInvalidated) throw new CallError('账号正在切换，请稍后继续', 'WORKSPACE_CHANGED');
  if (workspaceEpoch !== null) return workspaceEpoch;
  if (!handshake) {
    handshake = send('workspace.status', {}).then((res) => {
      if (workspaceInvalidated) throw new CallError('资料库已切换，请刷新后继续', 'WORKSPACE_CHANGED');
      if (!res?.ok) throw new CallError(res?.error || '工作区状态读取失败', res?.code);
      const epoch = res.data?.epoch;
      if (epoch === undefined || epoch === null) throw new CallError('工作区状态无效，请刷新页面', 'WORKSPACE_CHANGED');
      if (res.data?.switching) {
        workspaceSwitching = true;
        workspaceInvalidated = true;
        showWorkspaceSwitching();
        throw new CallError('账号正在切换，请稍后继续', 'WORKSPACE_CHANGED');
      }
      workspaceId = res.data?.id ?? workspaceId;
      workspaceEpoch = epoch;
      return epoch;
    }).finally(() => { handshake = null; });
  }
  return handshake;
}

/** 调用后台：call('bookmarks.save', { url, title }) */
export async function call(type, payload = {}) {
  const transition = TRANSITION_TYPES.has(type);
  if (transition && workspaceInvalidated) throw new CallError('账号正在切换，请刷新后继续', 'WORKSPACE_CHANGED');
  const epoch = type === 'workspace.status' ? undefined : await ensureWorkspace();
  const res = type === 'workspace.status' ? await send(type, payload) : await send(type, payload, epoch);
  if (!res) throw new CallError('插件后台没有响应，请稍后再试', 'NO_BACKGROUND');
  if (!res.ok) {
    if (res.code === 'WORKSPACE_CHANGED') invalidateWorkspace();
    throw new CallError(res.error || '操作失败', res.code);
  }
  if (type === 'workspace.status') {
    workspaceId = res.data?.id ?? workspaceId;
    workspaceSwitching = !!res.data?.switching;
    if (workspaceSwitching) workspaceInvalidated = true;
    if (res.data?.epoch !== undefined) workspaceEpoch = res.data.epoch;
    if (workspaceSwitching) showWorkspaceSwitching();
  } else if (!transition && (workspaceInvalidated || (res.epoch ?? res.data?.epoch) !== epoch)) {
    workspaceEpoch = null;
    invalidateWorkspace();
    throw new CallError('账号已切换，请刷新后继续', 'WORKSPACE_CHANGED');
  }
  return res.data;
}

/** 监听后台广播的变化：onChange(['bookmarks','notes'], () => reload()) */
export function onChange(topics, handler) {
  const wanted = new Set(topics);
  const listener = (msg) => {
    if (!msg || msg.sqEvent !== 'changed') return;
    if (!topics.length || msg.topics.some((t) => wanted.has(t))) handler(msg.topics, msg.detail || {});
  };
  chrome.runtime.onMessage.addListener(listener);
  return () => chrome.runtime.onMessage.removeListener(listener);
}

// 每个页面模块只注册一次：页面里有好几个数据监听时，同一次资料库切换也只处理一遍。
chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.sqEvent !== 'changed' || !msg.topics?.includes('workspace')) return;
  const switching = msg.detail?.phase === 'switching';
  workspaceSwitching = switching;
  workspaceInvalidated = true;
  if (switching) workspaceEpoch = null;
  showWorkspaceSwitching();
  window.dispatchEvent(new CustomEvent('workspace-changed', { detail: msg.detail || {} }));
  if (!switching && typeof location !== 'undefined') setTimeout(() => location.reload(), 0);
});

/** 监听后台的其他通知（选取结果等）。 */
export function onNotice(kind, handler) {
  const listener = (msg) => {
    if (msg && msg.sqEvent === 'notice' && msg.kind === kind) handler(msg.detail || {});
  };
  chrome.runtime.onMessage.addListener(listener);
  return () => chrome.runtime.onMessage.removeListener(listener);
}
