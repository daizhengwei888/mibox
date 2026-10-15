// 从 Chrome 书签导入，以及「自动收录 Chrome 书签」工具。

import { isWebUrl, normalizeUrl } from '../shared/util.js';
import * as db from './db.js';
import * as lib from './library.js';
import { getSettings } from './settings.js';
import { run as workspaceRun } from './workspace.js';

function flatten(nodes, path, out, depth = 0) {
  for (const node of nodes) {
    if (node.url) {
      out.push({ title: node.title, url: node.url, path, createdAt: node.dateAdded || 0 });
    } else if (node.children) {
      // 根节点（书签栏、其他书签、移动设备书签）不算分组。
      const nextPath = depth <= 1 ? path : [...path, node.title];
      flatten(node.children, depth === 0 ? [] : nextPath, out, depth + 1);
    }
  }
  return out;
}

async function readTree() {
  const tree = await chrome.bookmarks.getTree();
  return flatten(tree, [], []);
}

async function preview_() {
  const items = await readTree();
  const live = new Set((await db.getLive('bookmarks')).map((b) => b.nurl));
  const seen = new Set();
  const folders = new Set();
  let importable = 0;
  let duplicate = 0;
  let skipped = 0;
  for (const it of items) {
    if (!isWebUrl(it.url)) {
      skipped++;
      continue;
    }
    const n = normalizeUrl(it.url);
    if (live.has(n) || seen.has(n)) {
      duplicate++;
      continue;
    }
    seen.add(n);
    importable++;
    if (it.path.length) folders.add(it.path[0]);
  }
  return { scanned: items.length, importable, duplicate, skipped, folders: folders.size };
}

export const preview = (...args) => workspaceRun(() => preview_(...args));

async function importAll_({ foldersAsGroups = true } = {}) {
  const items = await readTree();
  const groupIds = {};
  if (foldersAsGroups) {
    const names = [...new Set(items.filter((i) => i.path.length && isWebUrl(i.url)).map((i) => i.path[0].trim()).filter(Boolean))];
    for (const name of names) {
      const g = await lib.createGroup(name, { silent: true });
      groupIds[name] = g.id;
    }
  }
  const result = await lib.importBookmarks(
    items.map((i) => ({ title: i.title, url: i.url, createdAt: i.createdAt, groupKey: foldersAsGroups && i.path.length ? i.path[0].trim() : null })),
    { groupIds },
  );
  await db.kvSet('lastChromeImport', { at: Date.now(), ...result });
  return { ...result, groups: Object.keys(groupIds).length };
}

export const importAll = (...args) => workspaceRun(() => importAll_(...args));

/** Chrome 里新加星标时同时存一份（工具开关打开时）。 */
export function installAutoCollect() {
  chrome.bookmarks.onCreated.addListener((id, node) => {
    workspaceRun(async () => {
      if (!node.url || !isWebUrl(node.url)) return;
      const s = await getSettings();
      if (!s.tools.autoCollect) return;
      let groupId = null;
      try {
        const [parent] = await chrome.bookmarks.get(node.parentId);
        if (parent && parent.title && !['1', '2', '3'].includes(parent.id)) {
          const groups = await lib.listGroups();
          groupId = groups.find((g) => g.name === parent.title)?.id ?? null;
        }
      } catch {}
      await lib.saveBookmark({ url: node.url, title: node.title, groupId });
    }).catch(() => {});
  });
}
