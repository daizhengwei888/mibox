// 消息路由：网页内容脚本只允许点选器结果和绑定标签页的令牌交接。

import * as lib from './library.js';
import * as chromebm from './chromebm.js';
import * as backup from './backup.js';
import * as vault from './vault.js';
import * as google from './google.js';
import * as sync from './sync.js';
import * as checkin from './checkin.js';
import * as actions from './actions.js';
import * as clipboard from './clipboard.js';
import * as db from './db.js';
import * as workspace from './workspace.js';
import * as home from './frecency.js';
import * as publish from './publish.js';
import * as publishConnect from './publish-connect.js';
import { getSettings, updateSettings, resetSettingsCache } from './settings.js';
import { emit } from './events.js';
import { UserError } from './errors.js';
import { BUILD } from '../shared/defaults.js';

const EXT_ORIGIN = chrome.runtime.getURL('').replace(/\/$/, '');

/** 网页里的内容脚本可以发的消息。 */
const PAGE_ALLOWED = new Set(['picker.result', 'picker.cancel', 'publish.connect.capture']);
const TRANSITIONS = new Set(['google.signIn', 'google.signOut', 'google.revoke', 'workspace.copyLocal']);

const handlers = {
  'app.build': () => ({ build: BUILD }),
  'workspace.status': () => workspace.status(),
  'workspace.copyLocal': (p) => workspace.copyLocal(p),
  'home.top': (p) => home.top(p),
  'home.uiGet': () => home.getUi(),
  'home.uiSet': (p) => home.setUi(p),
  'publish.prepare': (p) => publish.prepare(p),
  'publish.start': (p) => publish.start(p),
  'publish.status': () => publish.status(),
  'publish.check': (p) => publish.check(p),
  'publish.clear': (p) => publish.clear(p),
  'publish.sites': (p) => publish.sites(p),
  'publish.siteCheck': (p) => publish.checkSite(p),
  'publish.remove': (p) => publish.removeSite(p),
  'publish.authorizeCreate': (p) => publish.authorizeCreate(p),
  'publish.deleteAccess': () => publish.deleteAccess(),
  'publish.authorizeDelete': (p) => publish.authorizeDelete(p),
  'publish.connect.state': (p) => publishConnect.state(p),
  'publish.connect.open': (p, sender) => publishConnect.open(p, sender),
  'publish.connect.save': (p) => publishConnect.save(p),
  'publish.connect.use': (p) => publishConnect.use(p),
  'publish.connect.capture': (p, sender) => publishConnect.capture(p, sender),
  'publish.targets': (p) => publishConnect.targets(p),
  // ── 总览 ──
  'library.get': async () => {
    const [bookmarks, groups, settings] = await Promise.all([lib.listBookmarks(), lib.listGroups(), getSettings()]);
    return { bookmarks, groups, settings };
  },
  'nav.counts': async () => {
    const [c, v, s] = await Promise.all([lib.counts(), vault.status(), sync.status()]);
    return { ...c, vault: { exists: v.exists, unlocked: v.unlocked }, sync: s };
  },

  // ── 收藏 ──
  'bookmarks.save': (p) => lib.saveBookmark(p),
  'bookmarks.update': (p) => lib.updateBookmark(p.id, p.patch || {}),
  'bookmarks.remove': (p) => lib.removeBookmarks(p.ids || []),
  'bookmarks.restore': (p) => lib.restoreBookmarks(p.ids || []),
  'bookmarks.favorite': (p) => lib.setFavorite(p.ids || [], !!p.value),
  'bookmarks.reorderFavorites': (p) => lib.reorderFavorites(p.ids || []),
  'bookmarks.move': (p) => lib.moveBookmarks(p.ids || [], p.groupId ?? null),
  'bookmarks.opened': (p) => lib.markOpened(p.id),
  'bookmarks.findByUrl': (p) => lib.findByUrl(p.url),
  'bookmarks.duplicates': () => lib.findDuplicates(),
  'bookmarks.mergeDuplicates': (p) => lib.mergeDuplicates(p.keepId, p.removeIds || []),
  'bookmarks.importItems': (p) => backup.importItems(p.items || [], p.folders || []),

  // ── 分组 ──
  'groups.create': (p) => lib.createGroup(p.name),
  'groups.rename': (p) => lib.renameGroup(p.id, p.name),
  'groups.remove': (p) => lib.removeGroup(p.id),
  'groups.reorder': (p) => lib.reorderGroups(p.ids || []),

  // ── 笔记 ──
  'notes.list': () => lib.listNotes(),
  'notes.save': (p) => lib.saveNote(p),
  'notes.remove': (p) => lib.removeNote(p.id),
  'notes.restore': (p) => lib.restoreNote(p.id),

  // ── Chrome 书签、导入导出 ──
  'chrome.importPreview': () => chromebm.preview(),
  'chrome.import': (p) => chromebm.importAll(p),
  'chrome.lastImport': () => db.kvGet('lastChromeImport'),
  'export.html': () => backup.exportHtml(),
  'export.backup': (p) => backup.exportBackup({ includeVault: !!p.includeVault }),
  'import.backup': (p) => backup.importBackup(p.data),

  // ── 保险箱 ──
  'vault.status': () => vault.status(),
  'vault.prepare': (p) => vault.prepareCreate(p.password),
  'vault.commit': () => vault.commitCreate(),
  'vault.cancelCreate': () => vault.cancelCreate(),
  'vault.unlock': (p) => vault.unlock(p.password),
  'vault.unlockWithRecovery': (p) => vault.unlockWithRecovery(p.recoveryKey, p.newPassword),
  'vault.lock': () => vault.lock(),
  'vault.list': () => vault.list(),
  'vault.reveal': (p) => vault.reveal(p.id),
  'vault.save': (p) => vault.save(p),
  'vault.setFill': (p) => vault.setFill(p.id, p.fill),
  'vault.remove': (p) => vault.remove(p.id),
  'vault.restore': (p) => vault.restore(p.id),
  'vault.changePassword': (p) => vault.changePassword(p.oldPassword, p.newPassword),
  'vault.regenerateRecovery': (p) => vault.regenerateRecovery(p.password),
  'vault.matchSite': (p) => vault.matchSite(p.url),
  'vault.fill': (p) => actions.fillLogin(p.tabId, p.id),
  'vault.mergeIntoRemote': (p) => db.exclusive(() => vault.mergeIntoRemote(p.password)),
  'vault.useRemote': () => vault.discardLocalForRemote(),
  'vault.dismissConflict': () => vault.dismissConflict(),
  'clipboard.scheduleClear': () => clipboard.scheduleClear(),

  // ── Google 与同步 ──
  'google.status': () => google.status(),
  'google.signIn': () => google.signIn(),
  'google.signOut': () => google.signOut(),
  'google.revoke': () => google.revoke(),
  'google.prepareClientChange': (p) => google.prepareClientChange(p),
  'sync.status': () => sync.status(),
  'sync.now': async () => {
    const r = await sync.syncNow('manual');
    if (!r.ok) throw new UserError(r.error || '同步失败', r.code);
    return sync.status();
  },
  'sync.setAuto': async (p) => {
    await updateSettings({ sync: { auto: !!p.auto } });
    if (p.auto) await sync.syncNow('resume');
    emit('sync');
    return sync.status();
  },
  'sync.setWhat': async (p) => {
    const allowed = ['bookmarks', 'notes', 'vault', 'tools'];
    const patch = {};
    for (const k of allowed) if (k in (p || {})) patch[k] = !!p[k];
    await updateSettings({ sync: patch });
    emit('sync');
    return sync.status();
  },
  'sync.dismissConflict': (p) => sync.dismissConflict(p.id),
  'sync.clearCloud': () => sync.clearCloud(),

  // ── 设置 ──
  'settings.get': () => getSettings(),
  'settings.update': async (p) => {
    const before = await getSettings();
    const next = await updateSettings(p || {});
    if ('autoLockMinutes' in (p || {})) await vault.applyLockSetting();
    if ('tools' in (p || {})) await actions.updateMenuVisibility();
    if ('tools' in (p || {}) || 'checkin' in (p || {})) {
      if (before.checkin.time !== next.checkin.time || before.tools.checkin !== next.tools.checkin) await checkin.reschedule();
    }
    return next;
  },

  // ── 签到与技能包 ──
  'tasks.list': () => checkin.list(),
  'tasks.save': (p) => checkin.save(p),
  'tasks.remove': (p) => checkin.remove(p.id),
  'tasks.restore': (p) => checkin.restore(p.id),
  'tasks.setEnabled': (p) => checkin.setEnabled(p.id, p.enabled),
  'tasks.run': (p) => checkin.run(p.id, { manual: true }),
  'tasks.runAll': () => checkin.startBatch({ trigger: 'manual' }),
  'tasks.runIds': (p) => checkin.startBatch({ ids: Array.isArray(p.ids) ? p.ids.map(String) : [], trigger: 'manual' }),
  'tasks.batch': () => checkin.batchStatus(),
  'tasks.batchStop': () => checkin.stopBatch(),
  'tasks.batchSeen': () => checkin.batchSeen(),
  'tasks.addMany': (p) => checkin.addMany({ items: p.items, login: p.login }),
  'tasks.history': (p) => checkin.history(p.id),
  'tasks.lastAuto': () => db.kvGet('checkinLastAuto'),
  'skills.import': (p) => checkin.importSkill(p.data),
  'picker.start': (p, sender) => checkin.startPicker(p, sender),
  'picker.result': (p, sender) => checkin.pickerResult(p, sender, false),
  'picker.cancel': (p, sender) => checkin.pickerResult(p, sender, true),

  // ── 浏览器入口 ──
  'page.selection': (p) => actions.readSelection(p.tabId),

  // ── 数据 ──
  'data.wipeLocal': async () => {
    for (const s of ['bookmarks', 'groups', 'notes', 'tasks', 'runs']) await db.clear(s);
    await vault.wipeLocal();
    await db.kvSet('syncState', null);
    await db.kvSet('settings', null);
    resetSettingsCache();
    emit(['bookmarks', 'groups', 'notes', 'tasks', 'vault', 'settings', 'sync']);
    return { ok: true };
  },
};

export function install() {
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || msg.sq !== 1 || typeof msg.type !== 'string') return false;
    const handler = handlers[msg.type];
    if (!handler) {
      sendResponse({ ok: false, error: '不支持的操作：' + msg.type, code: 'UNKNOWN' });
      return false;
    }
    const fromExtension = sender.id === chrome.runtime.id && typeof sender.url === 'string' && sender.url.startsWith(EXT_ORIGIN);
    // 扩展自己的页面里，嵌在网页中的那一层（搜索浮层）必须带一次性令牌，否则任何网站都能把它藏起来冒充按钮。
    const embedded = fromExtension && sender.tab != null && (sender.frameId ?? 0) > 0;
    if (msg.type.startsWith('publish.') && msg.type !== 'publish.connect.capture' && (!fromExtension || embedded || sender.url.split(/[?#]/)[0] !== chrome.runtime.getURL('src/ui/app/app.html'))) {
      sendResponse({ ok: false, error: '请从谜盒完整页的网页发布工具操作', code: 'FORBIDDEN' });
      return false;
    }
    const allowEmbedded = embedded ? actions.checkOverlayToken(msg.overlayToken, sender.tab.id) : Promise.resolve(true);
    if (!fromExtension && !(sender.id === chrome.runtime.id && PAGE_ALLOWED.has(msg.type))) {
      sendResponse({ ok: false, error: '没有权限', code: 'FORBIDDEN' });
      return false;
    }
    Promise.resolve()
      .then(async () => {
        if (embedded && !(await allowEmbedded)) {
          throw new UserError('这个搜索浮层没有通过验证，请从快捷键重新打开', 'FORBIDDEN');
        }
        await workspace.ready();
        if (msg.type === 'workspace.status') return handler();
        if (fromExtension && (typeof msg.epoch !== 'string' || msg.epoch !== workspace.current().epoch)) throw new UserError('页面资料库已切换，请重新打开后操作', 'WORKSPACE_CHANGED');
        if (TRANSITIONS.has(msg.type)) {
          const result = await handler(msg.payload || {}, sender);
          await workspace.run(async () => {
            await actions.updateMenuVisibility();
            await checkin.reschedule();
          });
          return result;
        }
        return workspace.run(() => handler(msg.payload || {}, sender), fromExtension ? msg.epoch : null);
      })
      .then(
        (data) => sendResponse({ ok: true, data: data ?? null, epoch: workspace.current().epoch }),
        (e) => {
          if (!e?.user) console.error('[谜盒]', msg.type, e);
          sendResponse({ ok: false, error: e?.user ? e.message : '出错了：' + (e?.message || '未知错误'), code: e?.code || 'ERROR', epoch: workspace.current().epoch });
        },
      );
    return true;
  });
}
