// 本机数据库（IndexedDB）。所有记录都带 id、createdAt、updatedAt，删除时只打 deleted 标记，
// 这样撤销和多台电脑同步都能正确处理。

import { recordHash } from './merge.js';

export const STORES = ['bookmarks', 'groups', 'notes', 'vault', 'tasks', 'runs', 'kv'];

export function createDatabase(DB_NAME) {
const DB_VERSION = 1;
let dbPromise = null;
let chain = Promise.resolve();
const summaries = new Map();
const versions = new Map();
function invalidate(stores) {
  for (const store of stores) { versions.set(store, (versions.get(store) || 0) + 1); summaries.delete(store); }
}

/** 读改写操作排队执行，避免两个请求同时改同一条记录时互相覆盖。 */
function exclusive(fn) {
  const run = chain.then(fn, fn);
  chain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function req(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('数据库请求失败'));
  });
}

function done(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error || new Error('数据库事务被中断'));
    tx.onerror = () => reject(tx.error || new Error('数据库事务失败'));
  });
}

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const open = indexedDB.open(DB_NAME, DB_VERSION);
    open.onupgradeneeded = () => {
      const db = open.result;
      const make = (name, opts, indexes = []) => {
        if (db.objectStoreNames.contains(name)) return;
        const store = db.createObjectStore(name, opts);
        for (const [idx, path] of indexes) store.createIndex(idx, path, { unique: false });
      };
      make('bookmarks', { keyPath: 'id' }, [['nurl', 'nurl'], ['groupId', 'groupId'], ['updatedAt', 'updatedAt']]);
      make('groups', { keyPath: 'id' });
      make('notes', { keyPath: 'id' }, [['updatedAt', 'updatedAt']]);
      make('vault', { keyPath: 'id' });
      make('tasks', { keyPath: 'id' });
      make('runs', { keyPath: 'id' }, [['taskId', 'taskId'], ['at', 'at']]);
      make('kv', { keyPath: 'key' });
    };
    open.onsuccess = () => {
      const db = open.result;
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };
    open.onerror = () => {
      dbPromise = null;
      reject(open.error || new Error('打不开本机数据库'));
    };
    open.onblocked = () => {
      dbPromise = null;
      open.onsuccess = () => open.result.close();
      reject(new Error('本机数据库被占用，请关闭插件的其他页面后重试'));
    };
  });
  return dbPromise;
}

async function getAll(store) {
  const db = await openDb();
  return req(db.transaction(store, 'readonly').objectStore(store).getAll());
}

/** 未删除的记录。 */
async function getLive(store) {
  return (await getAll(store)).filter((r) => !r.deleted);
}

/** 只缓存计数和内容指纹，不长期保留笔记正文或保险箱密文。 */
function summary(store) {
  if (summaries.has(store)) return summaries.get(store);
  const version = versions.get(store) || 0;
  const pending = (async () => {
    const rows = await getAll(store);
    const entries = await Promise.all(rows.map(async (r) => ({ id: r.id, deleted: !!r.deleted, legacy: !!r.legacy, hash: await recordHash(store, r) })));
    if ((versions.get(store) || 0) !== version) return summary(store);
    return { live: entries.filter((r) => !r.deleted).length, legacy: entries.filter((r) => !r.deleted && r.legacy).length, entries };
  })().catch((error) => { if (summaries.get(store) === pending) summaries.delete(store); throw error; });
  summaries.set(store, pending);
  return pending;
}

async function get(store, id) {
  const db = await openDb();
  return (await req(db.transaction(store, 'readonly').objectStore(store).get(id))) ?? null;
}

async function getByIndex(store, index, value) {
  const db = await openDb();
  return req(db.transaction(store, 'readonly').objectStore(store).index(index).getAll(value));
}

async function put(store, record) {
  invalidate([store]);
  const db = await openDb();
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).put(record);
  await done(tx);
  invalidate([store]);
  return record;
}

async function putMany(store, records) {
  if (!records.length) return;
  invalidate([store]);
  const db = await openDb();
  const tx = db.transaction(store, 'readwrite');
  const os = tx.objectStore(store);
  for (const r of records) os.put(r);
  await done(tx);
  invalidate([store]);
}

async function remove(store, id) {
  invalidate([store]);
  const db = await openDb();
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).delete(id);
  await done(tx);
  invalidate([store]);
}

async function removeMany(store, ids) {
  if (!ids.length) return;
  invalidate([store]);
  const db = await openDb();
  const tx = db.transaction(store, 'readwrite');
  const os = tx.objectStore(store);
  for (const id of ids) os.delete(id);
  await done(tx);
  invalidate([store]);
}

async function clear(store) {
  invalidate([store]);
  const db = await openDb();
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).clear();
  await done(tx);
  invalidate([store]);
}

/**
 * 在一个事务里读改写多张表。fn 收到 {store(name)} 和 helpers，返回值会在事务完成后返回。
 */
async function transact(stores, fn) {
  invalidate(stores);
  const db = await openDb();
  const tx = db.transaction(stores, 'readwrite');
  const api = {
    get: (s, id) => req(tx.objectStore(s).get(id)).then((v) => v ?? null),
    getAll: (s) => req(tx.objectStore(s).getAll()),
    put: (s, rec) => {
      tx.objectStore(s).put(rec);
      return rec;
    },
    delete: (s, id) => tx.objectStore(s).delete(id),
  };
  let result;
  try {
    result = await fn(api);
  } catch (e) {
    try {
      tx.abort();
    } catch {}
    throw e;
  }
  await done(tx);
  invalidate(stores);
  return result;
}

async function kvGet(key, fallback = null) {
  const row = await get('kv', key);
  return row ? row.value : fallback;
}

async function kvSet(key, value) {
  await put('kv', { key, value });
  return value;
}

async function kvUpdate(key, fn, fallback = null) {
  return transact(['kv'], async (t) => {
    const row = await t.get('kv', key);
    const next = fn(row ? row.value : fallback);
    t.put('kv', { key, value: next });
    return next;
  });
}

return { exclusive, openDb, getAll, getLive, summary, get, getByIndex, put, putMany, remove, removeMany, clear, transact, kvGet, kvSet, kvUpdate };
}

const databases = new Map();
let activeName = "shuqian-local";
export function database(name) {
  if (!databases.has(name)) databases.set(name, createDatabase(name));
  return databases.get(name);
}
export function activate(name) { activeName = name; }
export function currentDatabase() { return activeName; }
export const exclusive = (...args) => database(activeName).exclusive(...args);
export const openDb = (...args) => database(activeName).openDb(...args);
export const getAll = (...args) => database(activeName).getAll(...args);
export const getLive = (...args) => database(activeName).getLive(...args);
export const summary = (...args) => database(activeName).summary(...args);
export const get = (...args) => database(activeName).get(...args);
export const getByIndex = (...args) => database(activeName).getByIndex(...args);
export const put = (...args) => database(activeName).put(...args);
export const putMany = (...args) => database(activeName).putMany(...args);
export const remove = (...args) => database(activeName).remove(...args);
export const removeMany = (...args) => database(activeName).removeMany(...args);
export const clear = (...args) => database(activeName).clear(...args);
export const transact = (...args) => database(activeName).transact(...args);
export const kvGet = (...args) => database(activeName).kvGet(...args);
export const kvSet = (...args) => database(activeName).kvSet(...args);
export const kvUpdate = (...args) => database(activeName).kvUpdate(...args);
