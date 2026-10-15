// 导出书签文件 / 完整备份，导入备份。保险箱不在备份里（它本来就只有密文）。

import * as db from './db.js';
import * as lib from './library.js';
import { UserError } from './errors.js';
import { getSettings } from './settings.js';
import { emit } from './events.js';
import * as vault from './vault.js';
import { isWebUrl, uid } from '../shared/util.js';

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** 浏览器通用的 Netscape 书签文件，分组变成文件夹。 */
export async function exportHtml() {
  const [bookmarks, groups] = await Promise.all([lib.listBookmarks(), lib.listGroups()]);
  const sec = (ts) => Math.floor((ts || Date.now()) / 1000);
  const line = (b) => `        <DT><A HREF="${esc(b.url)}" ADD_DATE="${sec(b.createdAt)}">${esc(b.title)}</A>\n${b.note ? `        <DD>${esc(b.note)}\n` : ''}`;
  let out = '<!DOCTYPE NETSCAPE-Bookmark-file-1>\n<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">\n<TITLE>Bookmarks</TITLE>\n<H1>Bookmarks</H1>\n<DL><p>\n';
  out += `    <DT><H3 ADD_DATE="${sec()}">谜盒</H3>\n    <DL><p>\n`;
  for (const g of groups) {
    const items = bookmarks.filter((b) => b.groupId === g.id);
    if (!items.length) continue;
    out += `        <DT><H3>${esc(g.name)}</H3>\n        <DL><p>\n`;
    out += items.map((b) => '    ' + line(b)).join('');
    out += '        </DL><p>\n';
  }
  out += bookmarks.filter((b) => !b.groupId || !groups.some((g) => g.id === b.groupId)).map(line).join('');
  out += '    </DL><p>\n</DL><p>\n';
  return { filename: `谜盒-${new Date().toISOString().slice(0, 10)}.html`, text: out };
}

export async function exportBackup({ includeVault = false } = {}) {
  const [bookmarks, groups, notes, tasks, settings] = await Promise.all([
    lib.listBookmarks(),
    lib.listGroups(),
    lib.listNotes(),
    db.getLive('tasks'),
    getSettings(),
  ]);
  const data = {
    format: 'shuqian-backup/1',
    exportedAt: new Date().toISOString(),
    note: '谜盒插件完整备份。不包含保险箱。',
    bookmarks: bookmarks.map(({ openedAt, ...b }) => b),
    groups,
    notes,
    tasks,
    settings: { tools: settings.tools, checkin: settings.checkin },
  };
  if (includeVault) {
    // 保险箱只放密文和头信息，没有主密码打不开。
    const section = await vault.exportSection();
    if (section) {
      data.vault = section;
      data.note = '谜盒插件完整备份。保险箱是加密的，需要原来的主密码才能打开。';
    }
  }
  return { filename: `谜盒备份-${new Date().toISOString().slice(0, 10)}.json`, text: JSON.stringify(data, null, 2) };
}

/** 导入完整备份：按网址合并收藏，笔记按 id 合并，已存在的不会被覆盖。 */
export async function importBackup(data, { source = 'backup' } = {}) {
  if (!data || data.format !== 'shuqian-backup/1') throw new UserError('这不是本插件导出的备份文件');
  if (data.vault) vault.validateImportSection(data.vault);
  const groupIds = {};
  for (const g of Array.isArray(data.groups) ? data.groups : []) {
    if (!g || typeof g.name !== 'string') continue;
    const created = await lib.createGroup(g.name, { silent: true });
    groupIds[g.id] = created.id;
  }
  const items = (Array.isArray(data.bookmarks) ? data.bookmarks : [])
    .filter((b) => b && isWebUrl(b.url))
    .map((b) => ({ url: b.url, title: b.title, note: b.note, favorite: b.favorite, createdAt: b.createdAt, groupKey: b.groupId || null }));
  const result = await lib.importBookmarks(items, { groupIds });

  let notes = 0;
  const existingNotes = new Set((await db.getAll('notes')).map((n) => n.id));
  const t = Date.now();
  const newNotes = [];
  for (const n of Array.isArray(data.notes) ? data.notes : []) {
    if (!n || typeof n.body !== 'string') continue;
    const id = typeof n.id === 'string' && !existingNotes.has(n.id) ? n.id : uid();
    if (existingNotes.has(n.id)) continue;
    newNotes.push({
      id,
      title: String(n.title ?? '').slice(0, 200),
      body: n.body.slice(0, 65536),
      pinned: !!n.pinned,
      sourceUrl: isWebUrl(n.sourceUrl) ? n.sourceUrl : null,
      sourceTitle: n.sourceTitle ?? null,
      createdAt: typeof n.createdAt === 'number' ? n.createdAt : t,
      updatedAt: t,
      deleted: false,
    });
    notes++;
  }
  await db.putMany('notes', newNotes);

  let tasks = 0;
  const existingTasks = new Set((await db.getAll('tasks')).map((x) => x.id));
  const newTasks = [];
  for (const k of Array.isArray(data.tasks) ? data.tasks : []) {
    if (!k || typeof k.id !== 'string' || existingTasks.has(k.id) || !isWebUrl(k.url)) continue;
    newTasks.push({ ...k, enabled: false, lastRun: null, updatedAt: t, deleted: false });
    tasks++;
  }
  await db.putMany('tasks', newTasks);
  emit(['bookmarks', 'groups', 'notes', 'tasks'], { imported: true }, { local: true });
  const v = data.vault ? await vault.importVault(data.vault, source) : { mode: 'none', count: 0 };
  return { ...result, notes, tasks, vault: v };
}

/** 界面解析好的书签文件条目（DOMParser 只能在页面里用）。 */
export async function importItems(items, folders) {
  const groupIds = {};
  for (const name of [...new Set((folders || []).filter((f) => typeof f === 'string' && f.trim()))]) {
    const g = await lib.createGroup(name, { silent: true });
    groupIds[name] = g.id;
  }
  return lib.importBookmarks(
    (items || []).map((i) => ({ url: i.url, title: i.title, createdAt: i.createdAt, note: i.note, groupKey: i.folder || null })),
    { groupIds },
  );
}
