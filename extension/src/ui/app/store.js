// 完整页共用的数据：收藏、分组、设置、计数、同步状态。后台一广播变化就刷新。

import { call, onChange } from '../../shared/client.js';
import { applyTheme } from '../kit/ui.js';

export const store = {
  ready: false,
  bookmarks: [],
  groups: [],
  settings: null,
  counts: { bookmarks: 0, notes: 0 },
  vault: { exists: false, unlocked: false },
  sync: null,
  error: '', // 上一次刷新失败的原因；页面据此提示，不要悄悄用旧数据重绘
};

const listeners = new Set();
export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
function notify(topics) {
  for (const fn of listeners) {
    try {
      fn(topics);
    } catch (e) {
      console.error(e);
    }
  }
}

export async function loadLibrary() {
  const lib = await call('library.get');
  store.bookmarks = lib.bookmarks;
  store.groups = lib.groups;
  store.settings = lib.settings;
  store.counts.bookmarks = lib.bookmarks.length;
  applyTheme(lib.settings.theme);
}

export async function loadSettings() {
  store.settings = await call('settings.get');
}

export async function loadCounts() {
  const c = await call('nav.counts');
  store.counts = { bookmarks: c.bookmarks, notes: c.notes };
  store.vault = c.vault;
  store.sync = c.sync;
}

export async function init() {
  await Promise.all([loadLibrary(), loadCounts()]);
  store.error = '';
  store.ready = true;
  notify(['init']);
  let pending = new Set();
  let timer = null;
  let refreshing = false;
  let queued = false;
  onChange([], (topics) => {
    for (const t of topics) pending.add(t);
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      if (pending.size === 0) return;
      queued = true;
      if (refreshing) return;
      refreshing = true;
      void (async () => {
        try {
          while (queued) {
            queued = false;
            const ts = [...pending];
            pending = new Set();
            try {
              const libraryChanged = ts.some((t) => ['bookmarks', 'groups'].includes(t));
              const settingsChanged = ts.includes('settings');
              const countsChanged = ts.some((t) => ['bookmarks', 'groups', 'notes', 'vault', 'sync'].includes(t));
              const tasks = [];
              if (libraryChanged) tasks.push(loadLibrary());
              else if (settingsChanged) tasks.push(loadSettings());
              if (countsChanged) tasks.push(loadCounts());
              await Promise.all(tasks);
              store.error = '';
            } catch (e) {
              // 后台重启或调用失败时不要装作成功：留着旧数据但把错误告诉页面。
              store.error = e?.message || '刷新数据失败，请重试。';
            }
            notify(ts);
          }
        } finally {
          refreshing = false;
        }
      })();
    }, 60);
  });
}

export function groupName(id) {
  return store.groups.find((g) => g.id === id)?.name || '';
}

/** 同步状态的一句话描述和颜色。 */
export function syncSummary(s) {
  if (!s || !s.signedIn) return { text: '只存在本机', dot: '', detail: '还没有登录 Google，资料只保存在这台电脑上。' };
  if (s.otherAccount) return { text: '需要确认账号', dot: 'warn', detail: `Chrome 现在登录的是 ${s.otherAccount}，不是 ${s.user?.email}。重新登录确认要用哪个账号后会继续同步。` };
  if (s.reauth) return { text: '需要重新登录', dot: 'warn', detail: 'Google 登录已失效，重新登录后会继续同步。' };
  if (s.syncing) return { text: '正在同步…', dot: 'warn', detail: '正在和 Google Drive 同步。' };
  if (s.lastError) return { text: '同步出错', dot: 'danger', detail: s.lastError };
  if (!s.auto) return { text: '同步已暂停', dot: '', detail: s.pending ? `自动同步已暂停，${s.pending} 项改动在本机等待上传。` : '自动同步已暂停。' };
  if (s.pending) return { text: `待上传 ${s.pending} 项`, dot: 'warn', detail: '改动会在几秒内自动上传。' };
  if (!s.lastSyncAt) return { text: '等待首次同步', dot: '', detail: '还没有完成首次同步。点「立即同步」，读取这个账号已有的云端资料。' };
  return { text: '已同步', dot: 'ok', detail: '所有改动都已上传。' };
}
