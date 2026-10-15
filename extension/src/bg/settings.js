import * as workspace from './workspace.js';
import * as db from './db.js';
import { kvGet, kvSet } from './db.js';
import { mergeSettings } from '../shared/defaults.js';
import { emit } from './events.js';

let cache = null;
const remoteToolListeners = new Set();

/** 从其他电脑同步来的工具设置生效后要做的事（更新右键菜单、重排签到时间）。 */
export function onRemoteToolSettings(fn) {
  remoteToolListeners.add(fn);
}

export async function getSettings() {
  if (!cache) cache = mergeSettings(await kvGet('settings'));
  return structuredClone(cache);
}

/** 部分更新，嵌套对象按一层合并：updateSettings({ tools: { clip: false } }) */
export async function updateSettings(patch) {
  // 读-合并-写必须串行：首页改主题和设置页改开关同时发生时，后写的不能把先写的键覆盖回旧值。
  const saved = await db.exclusive(async () => {
    const current = mergeSettings(await kvGet('settings'));
    const next = { ...current };
    for (const [key, value] of Object.entries(patch || {})) {
      if (!(key in current)) continue;
      if (current[key] && typeof current[key] === 'object' && !Array.isArray(current[key]) && value && typeof value === 'object') {
        next[key] = { ...current[key], ...value };
      } else {
        next[key] = value;
      }
    }
    const merged = mergeSettings(next);
    await kvSet('settings', merged);
    return merged;
  });
  cache = saved;
  // 工具开关和签到时间属于「工具设置」，需要同步到其他电脑。
  const toolsChanged = 'tools' in (patch || {}) || 'checkin' in (patch || {});
  if (toolsChanged) await kvSet('toolsUpdatedAt', Date.now());
  emit('settings', { keys: Object.keys(patch || {}) }, { local: toolsChanged });
  return structuredClone(cache);
}

/** 同步下载到更新的工具设置时直接替换，不触发再次上传。 */
export async function applyRemoteToolSettings(remote, remoteUpdatedAt) {
  const current = await getSettings();
  cache = mergeSettings({ ...current, tools: { ...current.tools, ...remote.tools }, checkin: { ...current.checkin, ...remote.checkin } });
  await kvSet('settings', cache);
  await kvSet('toolsUpdatedAt', remoteUpdatedAt);
  emit('settings', { keys: ['tools', 'checkin'] });
  for (const fn of remoteToolListeners) {
    try {
      await fn();
    } catch {}
  }
}

export async function deviceId() { return workspace.deviceId(); }

workspace.onSwitch(resetSettingsCache);

export function resetSettingsCache() {
  cache = null;
}
