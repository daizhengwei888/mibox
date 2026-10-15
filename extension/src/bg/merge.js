// 同步合并用的纯函数（不碰数据库和网络），方便单独测试。

import { sha256Hex } from '../shared/util.js';

export const LOCAL_ONLY = { bookmarks: ['openedAt'], tasks: ['lastRun'] };

// ───────────── 稳定的 JSON（用来比较内容是否变化） ─────────────

export function stable(value) {
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).filter((k) => value[k] !== undefined).sort().map((k) => JSON.stringify(k) + ':' + stable(value[k])).join(',') + '}';
  }
  return JSON.stringify(value ?? null);
}

export function forUpload(store, rec) {
  const strip = LOCAL_ONLY[store] || [];
  if (!strip.length) return rec;
  const out = { ...rec };
  for (const k of strip) delete out[k];
  return out;
}

export function sortById(list) {
  return [...list].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export function recordHash(store, record) {
  const value = { ...forUpload(store, record) };
  if (store === 'notes') { delete value.revision; delete value.ancestors; }
  return sha256Hex(stable(value));
}


// ───────────── 合并 ─────────────

export function sameNote(a, b) {
  return (a.title || '') === (b.title || '') && (a.body || '') === (b.body || '');
}

export async function stampNote(note, previous = null) {
  const revision = await sha256Hex(stable([note.title || '', note.body || '']));
  const ancestors = new Set(Array.isArray(note.ancestors) ? note.ancestors : []);
  if (previous) {
    for (const value of previous.ancestors || []) ancestors.add(value);
    ancestors.add(await sha256Hex(stable([previous.title || '', previous.body || ''])));
  }
  ancestors.delete(revision);
  return { ...note, revision, ancestors: [...ancestors].slice(-64) };
}

/** 按 id 合并两边的记录，返回合并结果和需要写入本机的记录。 */
export function mergeStore(store, localList, remoteList, ctx) {
  const local = new Map(localList.map((r) => [r.id, r]));
  const remote = new Map((remoteList || []).filter((r) => r && typeof r.id === 'string').map((r) => [r.id, r]));
  const merged = new Map();
  const toLocal = [];
  for (const id of new Set([...local.keys(), ...remote.keys()])) {
    const l = local.get(id);
    const r = remote.get(id);
    if (!r) {
      merged.set(id, l);
      continue;
    }
    if (!l) {
      merged.set(id, r);
      toLocal.push(r);
      continue;
    }
    const lu = l.updatedAt || 0;
    const ru = r.updatedAt || 0;
    const rightDescends = store === 'notes' && !l.deleted && !r.deleted && l.revision && r.ancestors?.includes(l.revision);
    const leftDescends = store === 'notes' && !l.deleted && !r.deleted && r.revision && l.ancestors?.includes(r.revision);
    const rightWins = rightDescends && !leftDescends ? true : leftDescends && !rightDescends ? false
      : ru > lu || (ru === lu && (l.deleted !== r.deleted ? !!r.deleted : stable(forUpload(store, r)) > stable(forUpload(store, l))));
    if (store === 'notes' && !l.deleted && !r.deleted && !sameNote(l, r) && !rightDescends && !leftDescends) {
      ctx.noteConflicts.push({ keep: rightWins ? r : l, other: rightWins ? l : r });
    }
    if (rightWins) {
      // 本机专用字段保留本机的值。
      const next = { ...r };
      for (const k of LOCAL_ONLY[store] || []) if (l[k] !== undefined) next[k] = l[k];
      merged.set(id, next);
      toLocal.push(next);
    } else {
      merged.set(id, l);
    }
  }
  return { merged, toLocal };
}

/** 两台电脑各自收藏了同一个网址：留最早的那条，把常用、备注、分组并过去。 */
export function dedupeBookmarks(merged, now) {
  const byNurl = new Map();
  const changed = [];
  for (const r of merged.values()) {
    if (r.deleted) continue;
    const prev = byNurl.get(r.nurl);
    if (!prev) {
      byNurl.set(r.nurl, r);
      continue;
    }
    const [keep, drop] = prev.createdAt < r.createdAt || (prev.createdAt === r.createdAt && prev.id < r.id) ? [prev, r] : [r, prev];
    const notes = [...new Set([keep.note, drop.note].map((n) => (n || '').trim()).filter(Boolean))];
    const kept = { ...keep, favorite: keep.favorite || drop.favorite, note: notes.join('\n').slice(0, 2000), groupId: keep.groupId || drop.groupId || null, updatedAt: now };
    if (kept.favorite && !keep.favorite) kept.favOrder = drop.favOrder || now;
    const dropped = { ...drop, deleted: true, deletedAt: now, updatedAt: now };
    merged.set(kept.id, kept);
    merged.set(dropped.id, dropped);
    byNurl.set(kept.nurl, kept);
    changed.push(kept, dropped);
  }
  return changed;
}

/** 同名分组合并成一个。 */
export function dedupeGroups(groups, bookmarks, now) {
  const byName = new Map();
  const changedGroups = [];
  const changedBookmarks = [];
  for (const g of groups.values()) {
    if (g.deleted) continue;
    const key = g.name.trim().toLowerCase();
    const prev = byName.get(key);
    if (!prev) {
      byName.set(key, g);
      continue;
    }
    const [keep, drop] = prev.createdAt < g.createdAt || (prev.createdAt === g.createdAt && prev.id < g.id) ? [prev, g] : [g, prev];
    const dropped = { ...drop, deleted: true, deletedAt: now, updatedAt: now };
    groups.set(dropped.id, dropped);
    byName.set(key, keep);
    changedGroups.push(dropped);
    for (const b of bookmarks.values()) {
      if (b.groupId === drop.id) {
        const nb = { ...b, groupId: keep.id, updatedAt: now };
        bookmarks.set(nb.id, nb);
        changedBookmarks.push(nb);
      }
    }
  }
  return { changedGroups, changedBookmarks };
}

export function purgeTombstones(map, now) {
  // 没有所有设备的确认水位，按时间清理会让离线设备复活旧记录。
  return [];
}
