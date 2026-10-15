// 浏览器里的入口：右键菜单、快捷键、快速搜索浮层、侧栏、填入账号。

import * as lib from './library.js';
import * as vault from './vault.js';
import * as ops from './pageops.js';
import { getSettings } from './settings.js';
import { UserError } from './errors.js';
import { isWebUrl, siteMatches } from '../shared/util.js';
import { run as workspaceRun, assertWorkAllowed } from './workspace.js';

const MENU = {
  savePage: 'sq-save-page',
  saveLink: 'sq-save-link',
  saveSelection: 'sq-save-selection',
  sidePanel: 'sq-open-sidepanel',
  search: 'sq-quick-search',
};

// 网页里那个搜索浮层的一次性令牌。任何网页都能嵌入扩展页，所以不带令牌的浮层一律拒绝。
const OVERLAY_KEY = 'sqOverlayToken';

async function installMenus_() {
  await chrome.contextMenus.removeAll();
  const s = await getSettings();
  const make = (props) => chrome.contextMenus.create(props, () => void chrome.runtime.lastError);
  make({ id: MENU.savePage, title: '收藏此网页', contexts: ['page'], documentUrlPatterns: ['http://*/*', 'https://*/*'] });
  make({ id: MENU.saveLink, title: '收藏此链接', contexts: ['link'], targetUrlPatterns: ['http://*/*', 'https://*/*'] });
  make({ id: MENU.saveSelection, title: '把选中的文字存为笔记', contexts: ['selection'], visible: !!s.tools.clip });
  make({ id: MENU.search, title: '快速搜索收藏和笔记', contexts: ['page'] });
  make({ id: MENU.sidePanel, title: '打开侧栏', contexts: ['page'] });
}

export const installMenus = (...args) => workspaceRun(() => installMenus_(...args));

async function updateMenuVisibility_() {
  const s = await getSettings();
  chrome.contextMenus.update(MENU.saveSelection, { visible: !!s.tools.clip }, () => void chrome.runtime.lastError);
}

export const updateMenuVisibility = (...args) => workspaceRun(() => updateMenuVisibility_(...args));

export function flashBadge(tabId, ok = true) {
  if (tabId == null) return;
  chrome.action.setBadgeBackgroundColor({ tabId, color: ok ? '#0B6B57' : '#A3261B' }).catch(() => {});
  chrome.action.setBadgeText({ tabId, text: ok ? '✓' : '!' }).catch(() => {});
  setTimeout(() => chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {}), 2500);
}

export function onMenuClicked(info, tab) {
  // 打开侧栏必须在用户操作的同一时刻调用，不能先 await。
  if (info.menuItemId === MENU.sidePanel && tab) {
    chrome.sidePanel.open({ tabId: tab.id }).catch(() => {});
    return;
  }
  workspaceRun(async () => {
    if (info.menuItemId === MENU.savePage && tab) {
      const r = await lib.saveBookmark({ url: tab.url, title: tab.title });
      flashBadge(tab.id, true);
      return r;
    }
    if (info.menuItemId === MENU.saveLink && tab) {
      await lib.saveBookmark({ url: info.linkUrl, title: info.selectionText || '' });
      flashBadge(tab.id, true);
      return;
    }
    if (info.menuItemId === MENU.saveSelection && tab) {
      const s = await getSettings();
      if (!s.tools.clip) return;
      await lib.saveNote({ title: '', body: info.selectionText || '', sourceUrl: tab.url, sourceTitle: tab.title });
      flashBadge(tab.id, true);
      return;
    }
    if (info.menuItemId === MENU.search) await openQuickSearch(tab);
  }).catch(() => tab && flashBadge(tab.id, false));
}

export function onCommand(command, tab) {
  if (command === 'open-sidepanel') {
    if (tab) chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {});
    return;
  }
  if (command === 'quick-search') workspaceRun(() => openQuickSearch_(tab)).catch(() => {});
}

async function openQuickSearch_(tab) {
  if (tab?.id != null && isWebUrl(tab.url)) {
    try {
      // 浮层是嵌在网页里的扩展页，必须带一次性令牌，否则任何网站都能把它藏起来冒充按钮。
      const token = crypto.randomUUID();
      await chrome.storage.session.set({ [OVERLAY_KEY]: { token, tabId: tab.id, at: Date.now() } });
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: (t) => { window.__sqOverlayToken = t; }, args: [token] });
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['src/content/qs-host.js'] });
      return { mode: 'overlay' };
    } catch {}
  }
  await chrome.windows.create({ url: chrome.runtime.getURL('src/ui/search/search.html?mode=window'), type: 'popup', width: 720, height: 620, focused: true });
  return { mode: 'window' };
}

/** 校验来自网页内嵌浮层的一次性令牌。返回值表示这条消息是否来自合法的浮层。 */
export async function checkOverlayToken(token, tabId) {
  const rec = (await chrome.storage.session.get(OVERLAY_KEY))[OVERLAY_KEY];
  if (!rec || !token) return false;
  if (rec.tabId !== tabId) return false;
  if (Date.now() - (rec.at || 0) > 6 * 3600 * 1000) return false;
  return rec.token === token;
}

export const openQuickSearch = (...args) => workspaceRun(() => openQuickSearch_(...args));

/** 在当前网页填入保险箱里的账号。只在网址和账号的网站对得上时填。 */
async function fillLogin_(tabId, entryId) {
  await assertWorkAllowed();
  const tab = await chrome.tabs.get(tabId);
  const entry = await vault.reveal(entryId);
  if (entry.kind !== 'login') throw new UserError('这一条不是网站登录');
  if (!entry.site || !siteMatches(entry.site, tab.url)) throw new UserError('当前网页不是「' + (entry.site || entry.name) + '」，为了安全没有填入');
  let result;
  try {
    const [res] = await chrome.scripting.executeScript({ target: { tabId }, func: ops.fillLoginInPage, args: [entry.secret.username || '', entry.secret.password || '', false] });
    result = res?.result;
  } catch {
    throw new UserError('这个网页不允许插件填入，请复制后手动粘贴');
  }
  if (!result || (!result.user && !result.password)) throw new UserError('这个网页上没找到登录框');
  return result;
}

export const fillLogin = (...args) => workspaceRun(() => fillLogin_(...args));

async function readSelection_(tabId) {
  try {
    const [res] = await chrome.scripting.executeScript({ target: { tabId }, func: ops.readSelectionInPage });
    return res?.result || null;
  } catch {
    return null;
  }
}

export const readSelection = (...args) => workspaceRun(() => readSelection_(...args));
