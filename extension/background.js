// 谜盒后台入口（Manifest V3 service worker）。所有监听器必须在这里同步注册。

import * as router from './src/bg/router.js';
import * as sync from './src/bg/sync.js';
import * as vault from './src/bg/vault.js';
import * as google from './src/bg/google.js';
import * as checkin from './src/bg/checkin.js';
import * as chromebm from './src/bg/chromebm.js';
import * as actions from './src/bg/actions.js';
import * as clipboard from './src/bg/clipboard.js';
import { onRemoteToolSettings, getSettings } from './src/bg/settings.js';
import * as workspace from './src/bg/workspace.js';
import * as publishConnect from './src/bg/publish-connect.js';

async function accountWorkBlocked() {
  const g = await google.status();
  if (!g.signedIn) return false;
  try {
    await workspace.assertSyncAllowed();
    return false;
  } catch (e) {
    if (e?.code === 'REAUTH') return true;
    throw e;
  }
}

router.install();
publishConnect.install();
sync.install();
chromebm.installAutoCollect();
google.installIdentityListener();
checkin.installPickerWatcher();
onRemoteToolSettings(async () => {
  await workspace.run(async () => {
    await actions.updateMenuVisibility();
    if (!(await accountWorkBlocked())) await checkin.reschedule();
  });
});

chrome.contextMenus.onClicked.addListener(actions.onMenuClicked);
chrome.commands.onCommand.addListener(actions.onCommand);

chrome.alarms.onAlarm.addListener((alarm) => {
  workspace.run(async () => {
    if (await vault.onAlarm(alarm)) return;
    if (await clipboard.onAlarm(alarm)) return;
    if (await accountWorkBlocked()) return;
    if (await sync.onAlarm(alarm)) return;
    await checkin.onAlarm(alarm);
  }).catch((e) => console.warn('[谜盒] alarm', alarm.name, e));
});

chrome.runtime.onInstalled.addListener((details) => {
  workspace.run(async () => {
    await actions.installMenus();
    if (!(await accountWorkBlocked())) await checkin.reschedule();
    const s = await getSettings();
    const pending = (await chrome.storage.local.get('sqIndependentSetup')).sqIndependentSetup;
    if (pending?.pendingResume && pending.extensionId === chrome.runtime.id) {
      await chrome.storage.local.set({ sqIndependentSetup: { ...pending, pendingResume: false } });
      const url = chrome.runtime.getURL('src/ui/app/app.html#/independent');
      const existing = (await chrome.tabs.query({})).find((tab) => tab.url === url);
      if (existing) await chrome.tabs.update(existing.id, { url, active: true });
      else await chrome.tabs.create({ url });
    }
    if (!pending?.pendingResume && details.reason === 'install' && !s.onboarded) {
      await chrome.tabs.create({ url: chrome.runtime.getURL('src/ui/app/app.html#/welcome') });
    }
    const g = await google.status();
    if (g.signedIn && !(await accountWorkBlocked())) {
      try {
        await workspace.assertSyncAllowed();
        await sync.syncNow('install');
      } catch (e) {
        if (e?.code !== 'REAUTH') throw e;
      }
    }
  }).catch((e) => console.error('[谜盒] 安装处理失败', e));
});

chrome.runtime.onStartup.addListener(() => {
  workspace.run(async () => {
    const blocked = await accountWorkBlocked();
    if (blocked) {
      await chrome.alarms.clear('sq-checkin-daily');
      await chrome.alarms.clear('sq-checkin-catchup');
    } else {
      await checkin.reschedule({ catchUp: true });
    }
    const s = await getSettings();
    if (s.sync.auto && !blocked) {
      try {
        await workspace.assertSyncAllowed();
        await sync.syncNow('startup');
      } catch (e) {
        if (e?.code !== 'REAUTH') throw e;
      }
    }
  }).catch(() => {});
});

workspace.ready().then(() => workspace.run(async () => {
  await actions.updateMenuVisibility();
  if (await accountWorkBlocked()) {
    await chrome.alarms.clear('sq-checkin-daily');
    await chrome.alarms.clear('sq-checkin-catchup');
  } else {
    await checkin.reschedule();
  }
})).catch((e) => console.error('[谜盒] 启动初始化失败', e));

chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: false }).catch(() => {});
