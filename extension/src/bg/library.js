// 收藏、分组、笔记的增删改。删除一律是软删除（deleted 标记），可以撤销，也能同步到其他电脑。

import * as db from './db.js';
import { emit } from './events.js';
import { UserError } from './errors.js';
import { isWebUrl, normalizeUrl, clampText, uid, looseUrlKey, byteLength, domainOf } from '../shared/util.js';
import { LIMITS } from '../shared/defaults.js';
import { stampNote } from './merge.js';

const now = () => Date.now();

function cleanTitle(title, url) {
  const t = clampText(String(title ?? '').replace(/\s+/g, ' ').trim(), LIMITS.title);
  return t || domainOf(url) || url;
}

function cleanNote(text) {
  return clampText(String(text ?? '').trim(), LIMITS.note);
}

async function liveGroupId(groupId) {
  if (!groupId) return null;
  const g = await db.get('groups', groupId);
  return g && !g.deleted ? g.id : null;
}

// ───────────── 收藏 ─────────────

export async function listBookmarks() {
  const all = await db.getLive('bookmarks');
  all.sort((a, b) => b.createdAt - a.createdAt);
  return all;
}

export async function findByUrl(url) {
  if (!isWebUrl(url)) return null;
  const nurl = normalizeUrl(url);
  const rows = await db.getByIndex('bookmarks', 'nurl', nurl);
  return rows.find((r) => !r.deleted) ?? null;
}

/**
 * 保存一个网页。已收藏过的网址不会重复保存，返回 status: 'exists'。
 */
async function saveBookmark_(input) {
  const url = String(input?.url ?? '').trim();
  if (!isWebUrl(url)) throw new UserError('只能收藏以 http 或 https 开头的网页地址');
  if (url.length > LIMITS.url) throw new UserError('网址太长了');
  const nurl = normalizeUrl(url);
  const groupId = await liveGroupId(input.groupId);
  const t = now();
  const existing = await db.getByIndex('bookmarks', 'nurl', nurl);
  const live = existing.find((r) => !r.deleted);
  if (live) return { status: 'exists', bookmark: live };

  const revived = existing.sort((a, b) => b.updatedAt - a.updatedAt)[0];
  const record = {
    id: revived ? revived.id : uid(),
    url,
    nurl,
    title: cleanTitle(input.title, url),
    groupId,
    favorite: !!input.favorite,
    favOrder: input.favorite ? t : 0,
    note: cleanNote(input.note),
    createdAt: t,
    updatedAt: t,
    deleted: false,
  };
  await db.put('bookmarks', record);
  emit('bookmarks', { created: [record.id] }, { local: true });
  return { status: 'created', bookmark: record };
}

/** 批量写入（导入、迁移用），按网址去重。返回新增和跳过的数量。 */
async function importBookmarks_(items, { groupIds = {}, silent = false } = {}) {
  const existing = await db.getAll('bookmarks');
  const usedIds = new Set(existing.map((e) => e.id));
  const byNurl = new Map();
  for (const r of existing) {
    const prev = byNurl.get(r.nurl);
    if (!prev || (prev.deleted && !r.deleted)) byNurl.set(r.nurl, r);
  }
  const t = now();
  const out = [];
  let added = 0;
  let skipped = 0;
  let invalid = 0;
  let i = 0;
  for (const item of items) {
    const url = String(item.url ?? '').trim();
    if (!isWebUrl(url) || url.length > LIMITS.url) {
      invalid++;
      continue;
    }
    const nurl = normalizeUrl(url);
    const prev = byNurl.get(nurl);
    if (prev && !prev.deleted) {
      // 已存在：补上缺的常用标记和备注，不覆盖用户改过的标题。
      let changed = false;
      const next = { ...prev };
      if (item.favorite && !prev.favorite) {
        next.favorite = true;
        next.favOrder = t + i;
        changed = true;
      }
      if (item.note && !prev.note) {
        next.note = cleanNote(item.note);
        changed = true;
      }
      if (!prev.groupId && item.groupKey && groupIds[item.groupKey]) {
        next.groupId = groupIds[item.groupKey];
        changed = true;
      }
      if (changed) {
        next.updatedAt = t;
        out.push(next);
        byNurl.set(nurl, next);
      }
      skipped++;
      continue;
    }
    const created = typeof item.createdAt === 'number' && item.createdAt > 0 ? item.createdAt : t - i;
    const record = {
      id: prev ? prev.id : typeof item.id === 'string' && item.id && !usedIds.has(item.id) ? item.id : uid(),
      url,
      nurl,
      title: cleanTitle(item.title, url),
      groupId: item.groupKey ? groupIds[item.groupKey] ?? null : null,
      favorite: !!item.favorite,
      favOrder: item.favorite ? t + i : 0,
      note: cleanNote(item.note),
      createdAt: created,
      updatedAt: t,
      deleted: false,
    };
    out.push(record);
    usedIds.add(record.id);
    byNurl.set(nurl, record);
    added++;
    i++;
  }
  // 分批写入，避免一个事务太大。
  for (let k = 0; k < out.length; k += 500) await db.putMany('bookmarks', out.slice(k, k + 500));
  if (out.length && !silent) emit('bookmarks', { imported: added }, { local: true });
  return { added, skipped, invalid };
}

async function updateBookmark_(id, patch) {
  const rec = await db.get('bookmarks', id);
  if (!rec || rec.deleted) throw new UserError('这条收藏已经不存在了', 'NOT_FOUND');
  const next = { ...rec };
  if ('url' in patch) {
    const url = String(patch.url ?? '').trim();
    if (!isWebUrl(url)) throw new UserError('网址需要以 http 或 https 开头');
    const nurl = normalizeUrl(url);
    if (nurl !== rec.nurl) {
      const other = (await db.getByIndex('bookmarks', 'nurl', nurl)).find((r) => !r.deleted && r.id !== id);
      if (other) throw new UserError('已经有一条相同网址的收藏：' + other.title, 'DUPLICATE');
    }
    next.url = url;
    next.nurl = nurl;
  }
  if ('title' in patch) next.title = cleanTitle(patch.title, next.url);
  if ('note' in patch) next.note = cleanNote(patch.note);
  if ('groupId' in patch) next.groupId = await liveGroupId(patch.groupId);
  if ('favorite' in patch) {
    next.favorite = !!patch.favorite;
    if (next.favorite && !rec.favorite) next.favOrder = now();
  }
  const changed = ['url', 'title', 'note', 'groupId', 'favorite'].some((k) => next[k] !== rec[k]);
  if (!changed) return rec;
  next.updatedAt = now();
  await db.put('bookmarks', next);
  emit('bookmarks', { updated: [id] }, { local: true });
  return next;
}

async function updateMany(ids, fn, topicDetail) {
  const t = now();
  const changed = [];
  await db.transact(['bookmarks'], async (tx) => {
    for (const id of ids) {
      const rec = await tx.get('bookmarks', id);
      if (!rec) continue;
      const next = fn({ ...rec }, t);
      if (!next) continue;
      next.updatedAt = t;
      tx.put('bookmarks', next);
      changed.push(next.id);
    }
  });
  if (changed.length) emit('bookmarks', { ...topicDetail, ids: changed }, { local: true });
  return changed;
}

async function removeBookmarks_(ids) {
  const changed = await updateMany(ids, (r, t) => (r.deleted ? null : Object.assign(r, { deleted: true, deletedAt: t })), { removed: true });
  return { removed: changed.length, ids: changed };
}

async function restoreBookmarks_(ids) {
  const live = new Set((await db.getLive('bookmarks')).map((r) => r.nurl));
  const changed = await updateMany(
    ids,
    (r) => {
      if (!r.deleted || live.has(r.nurl)) return null;
      live.add(r.nurl);
      r.deleted = false;
      delete r.deletedAt;
      return r;
    },
    { restored: true },
  );
  return { restored: changed.length };
}

async function setFavorite_(ids, value) {
  let order = now();
  const changed = await updateMany(ids, (r) => {
    if (r.deleted || r.favorite === !!value) return null;
    r.favorite = !!value;
    r.favOrder = value ? order++ : 0;
    return r;
  });
  return { changed: changed.length };
}

async function reorderFavorites_(ids) {
  const base = now();
  const index = new Map(ids.map((id, i) => [id, i]));
  await updateMany(ids, (r) => {
    if (!r.favorite) return null;
    r.favOrder = base + index.get(r.id);
    return r;
  });
  return { ok: true };
}

async function moveBookmarks_(ids, groupId) {
  const gid = await liveGroupId(groupId);
  const changed = await updateMany(ids, (r) => (r.deleted || r.groupId === gid ? null : Object.assign(r, { groupId: gid })));
  return { moved: changed.length };
}

/** 打开记录只存在本机，不参与同步。 */
async function markOpened_(id) {
  const rec = await db.get('bookmarks', id);
  if (!rec) return;
  rec.openedAt = now();
  await db.put('bookmarks', rec);
}

/** 网址相同或只差参数的收藏。 */
export async function findDuplicates() {
  const live = await db.getLive('bookmarks');
  const groups = new Map();
  for (const r of live) {
    const key = looseUrlKey(r.url);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  return [...groups.entries()]
    .filter(([, items]) => items.length > 1)
    .map(([key, items]) => ({ key, items: items.sort((a, b) => a.createdAt - b.createdAt) }));
}

/** 合并重复：保留 keepId，其他的备注追加进来，然后删除其他的。 */
async function mergeDuplicates_(keepId, removeIds) {
  const keep = await db.get('bookmarks', keepId);
  if (!keep || keep.deleted) throw new UserError('要保留的那条收藏不存在了');
  const others = (await Promise.all(removeIds.map((id) => db.get('bookmarks', id)))).filter((r) => r && !r.deleted && r.id !== keepId);
  const notes = [keep.note, ...others.map((o) => o.note)].map((n) => (n || '').trim()).filter(Boolean);
  const uniqueNotes = [...new Set(notes)];
  const next = {
    ...keep,
    note: cleanNote(uniqueNotes.join('\n')),
    favorite: keep.favorite || others.some((o) => o.favorite),
    groupId: keep.groupId || others.find((o) => o.groupId)?.groupId || null,
    updatedAt: now(),
  };
  if (next.favorite && !keep.favorite) next.favOrder = now();
  await db.put('bookmarks', next);
  await removeBookmarks_(others.map((o) => o.id));
  return { kept: keepId, removed: others.length };
}

// ───────────── 分组 ─────────────

export async function listGroups() {
  const all = await db.getLive('groups');
  all.sort((a, b) => a.order - b.order || a.createdAt - b.createdAt);
  return all;
}

function cleanGroupName(name) {
  const n = String(name ?? '').replace(/\s+/g, ' ').trim();
  if (!n) throw new UserError('分组名称不能为空');
  return clampText(n, LIMITS.groupName);
}

async function createGroup_(name, { silent = false } = {}) {
  const clean = cleanGroupName(name);
  const groups = await listGroups();
  const same = groups.find((g) => g.name.toLowerCase() === clean.toLowerCase());
  if (same) return same;
  const t = now();
  const order = groups.reduce((m, g) => Math.max(m, g.order), 0) + 1;
  const rec = { id: uid(), name: clean, order, createdAt: t, updatedAt: t, deleted: false };
  await db.put('groups', rec);
  if (!silent) emit('groups', { created: rec.id }, { local: true });
  return rec;
}

async function renameGroup_(id, name) {
  const clean = cleanGroupName(name);
  const rec = await db.get('groups', id);
  if (!rec || rec.deleted) throw new UserError('这个分组已经不存在了', 'NOT_FOUND');
  const groups = await listGroups();
  if (groups.some((g) => g.id !== id && g.name.toLowerCase() === clean.toLowerCase())) throw new UserError('已经有同名的分组');
  if (rec.name === clean) return rec;
  const next = { ...rec, name: clean, updatedAt: now() };
  await db.put('groups', next);
  emit('groups', { updated: id }, { local: true });
  return next;
}

async function removeGroup_(id) {
  const rec = await db.get('groups', id);
  if (!rec || rec.deleted) return { removed: false };
  const t = now();
  await db.transact(['groups', 'bookmarks'], async (tx) => {
    tx.put('groups', { ...rec, deleted: true, deletedAt: t, updatedAt: t });
    const all = await tx.getAll('bookmarks');
    for (const b of all) {
      if (b.groupId === id && !b.deleted) tx.put('bookmarks', { ...b, groupId: null, updatedAt: t });
    }
  });
  emit(['groups', 'bookmarks'], { removedGroup: id }, { local: true });
  return { removed: true };
}

async function reorderGroups_(ids) {
  const t = now();
  await db.transact(['groups'], async (tx) => {
    let order = 1;
    for (const id of ids) {
      const g = await tx.get('groups', id);
      if (!g || g.deleted) continue;
      if (g.order !== order) tx.put('groups', { ...g, order, updatedAt: t });
      order++;
    }
  });
  emit('groups', { reordered: true }, { local: true });
  return { ok: true };
}

// ───────────── 笔记 ─────────────

export async function listNotes() {
  const all = await db.getLive('notes');
  all.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || b.updatedAt - a.updatedAt);
  return all;
}

async function saveNote_(input) {
  const title = clampText(String(input?.title ?? '').trim(), 200);
  const body = String(input?.body ?? '');
  if (byteLength(body) > LIMITS.noteBody) throw new UserError('笔记太长了，单条上限 64 KB');
  const t = now();
  if (input.id) {
    const rec = await db.get('notes', input.id);
    if (rec && !rec.deleted) {
      const next = await stampNote({ ...rec, title, body }, rec);
      if ('pinned' in input) next.pinned = !!input.pinned;
      if (next.title === rec.title && next.body === rec.body && next.pinned === rec.pinned) return rec;
      next.updatedAt = t;
      await db.put('notes', next);
      emit('notes', { updated: rec.id }, { local: true });
      return next;
    }
  }
  if (!title && !body.trim()) throw new UserError('笔记是空的');
  const sourceUrl = isWebUrl(input.sourceUrl) ? String(input.sourceUrl).slice(0, LIMITS.url) : null;
  const rec = {
    id: input.id || uid(),
    title,
    body,
    pinned: !!input.pinned,
    sourceUrl,
    sourceTitle: sourceUrl ? clampText(String(input.sourceTitle ?? '').trim(), 256) : null,
    createdAt: t,
    updatedAt: t,
    deleted: false,
  };
  Object.assign(rec, await stampNote(rec));
  await db.put('notes', rec);
  emit('notes', { created: rec.id }, { local: true });
  return rec;
}

async function removeNote_(id) {
  const rec = await db.get('notes', id);
  if (!rec || rec.deleted) return { removed: false };
  const t = now();
  await db.put('notes', { ...rec, deleted: true, deletedAt: t, updatedAt: t });
  emit('notes', { removed: id }, { local: true });
  return { removed: true };
}

async function restoreNote_(id) {
  const rec = await db.get('notes', id);
  if (!rec || !rec.deleted) return { restored: false };
  const next = { ...rec, deleted: false, updatedAt: now() };
  delete next.deletedAt;
  await db.put('notes', next);
  emit('notes', { restored: id }, { local: true });
  return { restored: true };
}

export async function counts() {
  const [b, n] = await Promise.all([db.summary('bookmarks'), db.summary('notes')]);
  return { bookmarks: b.live, notes: n.live };
}

// 对外的写操作都排队执行。
export const saveBookmark = (...args) => db.exclusive(() => saveBookmark_(...args));
export const importBookmarks = (...args) => db.exclusive(() => importBookmarks_(...args));
export const updateBookmark = (...args) => db.exclusive(() => updateBookmark_(...args));
export const removeBookmarks = (...args) => db.exclusive(() => removeBookmarks_(...args));
export const restoreBookmarks = (...args) => db.exclusive(() => restoreBookmarks_(...args));
export const setFavorite = (...args) => db.exclusive(() => setFavorite_(...args));
export const reorderFavorites = (...args) => db.exclusive(() => reorderFavorites_(...args));
export const moveBookmarks = (...args) => db.exclusive(() => moveBookmarks_(...args));
export const markOpened = (...args) => db.exclusive(() => markOpened_(...args));
export const mergeDuplicates = (...args) => db.exclusive(() => mergeDuplicates_(...args));
export const createGroup = (...args) => db.exclusive(() => createGroup_(...args));
export const renameGroup = (...args) => db.exclusive(() => renameGroup_(...args));
export const removeGroup = (...args) => db.exclusive(() => removeGroup_(...args));
export const reorderGroups = (...args) => db.exclusive(() => reorderGroups_(...args));
export const saveNote = (...args) => db.exclusive(() => saveNote_(...args));
export const removeNote = (...args) => db.exclusive(() => removeNote_(...args));
export const restoreNote = (...args) => db.exclusive(() => restoreNote_(...args));
