// 复制密码 30 秒后清空剪贴板。弹窗可能已经关了，所以由后台用定时器 + 离屏页面来清。

import { getSettings } from './settings.js';
import { current, onSwitch, run as workspaceRun } from './workspace.js';

const ALARM = 'sq-clipboard-clear';
const OFFSCREEN = 'offscreen.html';
const SESSION_KEY = 'sq.clipboardClear';

async function scheduleClear_() {
  const s = await getSettings();
  if (!s.clipboardClear) return { scheduled: false };
  const w = current();
  const clearAt = Date.now() + 30000;
  await chrome.storage.session.set({ [SESSION_KEY]: { workspaceId: w.id, workspaceEpoch: w.epoch, clearAt } });
  await chrome.alarms.create(ALARM, { when: clearAt });
  return { scheduled: true };
}

export const scheduleClear = (...args) => workspaceRun(() => scheduleClear_(...args));

async function onAlarm_(alarm) {
  if (alarm.name !== ALARM) return false;
  const got = await chrome.storage.session.get(SESSION_KEY);
  const pending = got[SESSION_KEY];
  const w = current();
  if (!pending || pending.workspaceId !== w.id || pending.workspaceEpoch !== w.epoch || (typeof alarm.scheduledTime === 'number' && pending.clearAt !== alarm.scheduledTime)) {
    if (pending && (pending.workspaceId !== w.id || pending.workspaceEpoch !== w.epoch)) await chrome.storage.session.remove(SESSION_KEY);
    return true;
  }
  await chrome.storage.session.remove(SESSION_KEY);
  try {
    const has = await chrome.offscreen.hasDocument();
    if (!has) {
      await chrome.offscreen.createDocument({ url: OFFSCREEN, reasons: ['CLIPBOARD'], justification: '复制的密码 30 秒后清空剪贴板' });
    }
    await chrome.runtime.sendMessage({ sqOffscreen: 'clear-clipboard' });
  } catch {
  } finally {
    try {
      await chrome.offscreen.closeDocument();
    } catch {}
  }
  return true;
}

export const onAlarm = (...args) => workspaceRun(() => onAlarm_(...args));

onSwitch(async () => {
  await chrome.storage.session.remove(SESSION_KEY);
  await chrome.alarms.clear(ALARM);
});
