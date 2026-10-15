// 同步合并规则的单元测试：谁改得晚用谁的、删除也是一条记录、笔记冲突另存、同网址收藏合并。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeStore, dedupeBookmarks, dedupeGroups, stampNote, stable, recordHash } from '../../extension/src/bg/merge.js';

const ctx = () => ({ lastSyncAt: 0, noteConflicts: [] });

test('谁改得晚用谁的；只在一边的记录保留', () => {
  const local = [{ id: 'a', title: '本机', updatedAt: 10 }, { id: 'b', title: '只在本机', updatedAt: 5 }];
  const remote = [{ id: 'a', title: '云端', updatedAt: 20 }, { id: 'c', title: '只在云端', updatedAt: 7 }];
  const { merged, toLocal } = mergeStore('bookmarks', local, remote, ctx());
  assert.equal(merged.get('a').title, '云端');
  assert.equal(merged.get('b').title, '只在本机');
  assert.equal(merged.get('c').title, '只在云端');
  assert.deepEqual(toLocal.map((r) => r.id).sort(), ['a', 'c']);
});

test('删除同步过去；本机专用字段不被云端覆盖', () => {
  const local = [{ id: 'a', url: 'https://a.test', openedAt: 99, updatedAt: 1 }];
  const remote = [{ id: 'a', url: 'https://a.test', deleted: true, updatedAt: 2 }];
  const { merged } = mergeStore('bookmarks', local, remote, ctx());
  assert.equal(merged.get('a').deleted, true);
  assert.equal(merged.get('a').openedAt, 99);
});

test('两边同时改了同一条笔记：留下晚的，另一份记为冲突', async () => {
  const base = await stampNote({ id: 'n', title: '原来', body: '原来' });
  const l = await stampNote({ ...base, body: '本机改的', updatedAt: 10 }, base);
  const r = await stampNote({ ...base, body: '云端改的', updatedAt: 20 }, base);
  const c = ctx();
  const { merged } = mergeStore('notes', [l], [r], c);
  assert.equal(merged.get('n').body, '云端改的');
  assert.equal(c.noteConflicts.length, 1);
  assert.equal(c.noteConflicts[0].other.body, '本机改的');
});

test('笔记是在对方基础上改的：不算冲突', async () => {
  const base = await stampNote({ id: 'n', title: 't', body: 'v1', updatedAt: 10 });
  const next = await stampNote({ ...base, body: 'v2', updatedAt: 5 }, base); // 时间更早，但版本更新
  const c = ctx();
  const { merged } = mergeStore('notes', [base], [next], c);
  assert.equal(merged.get('n').body, 'v2');
  assert.equal(c.noteConflicts.length, 0);
});

test('同一个网址收藏了两次：留最早的，星标和备注并过去', () => {
  const m = new Map([
    ['x', { id: 'x', nurl: 'a.test', createdAt: 1, note: '甲', favorite: false }],
    ['y', { id: 'y', nurl: 'a.test', createdAt: 2, note: '乙', favorite: true }],
  ]);
  const changed = dedupeBookmarks(m, 100);
  assert.equal(changed.length, 2);
  assert.equal(m.get('x').favorite, true);
  assert.equal(m.get('x').note, '甲\n乙');
  assert.equal(m.get('y').deleted, true);
});

test('同名分组合并，收藏挪到留下的分组', () => {
  const groups = new Map([
    ['g1', { id: 'g1', name: '设计', createdAt: 1 }],
    ['g2', { id: 'g2', name: ' 设计 ', createdAt: 2 }],
  ]);
  const bookmarks = new Map([['b', { id: 'b', groupId: 'g2' }]]);
  const r = dedupeGroups(groups, bookmarks, 100);
  assert.equal(r.changedGroups[0].id, 'g2');
  assert.equal(bookmarks.get('b').groupId, 'g1');
});

test('stable 与键顺序无关，recordHash 忽略本机专用字段', async () => {
  assert.equal(stable({ b: 1, a: [2, { d: 1, c: 2 }] }), stable({ a: [2, { c: 2, d: 1 }], b: 1 }));
  const h1 = await recordHash('bookmarks', { id: 'a', url: 'u', openedAt: 1 });
  const h2 = await recordHash('bookmarks', { id: 'a', url: 'u', openedAt: 2 });
  assert.equal(h1, h2);
});
