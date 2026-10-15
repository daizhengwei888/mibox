// 纯函数单元测试：网址规范化、标题拆分、站点匹配等。运行：node --test tests/unit
import test from 'node:test';
import assert from 'node:assert/strict';
import { isWebUrl, coerceUrl, normalizeUrl, looseUrlKey, domainOf, splitTitle, siteMatches, clampText, plainText, formatWhen } from '../../extension/src/shared/util.js';

test('isWebUrl 只认 http / https', () => {
  assert.equal(isWebUrl('https://example.com'), true);
  assert.equal(isWebUrl('http://a.test:8800/x'), true);
  assert.equal(isWebUrl('javascript:alert(1)'), false);
  assert.equal(isWebUrl('chrome://extensions'), false);
  assert.equal(isWebUrl('not a url'), false);
});

test('coerceUrl 给裸域名补 https://，带端口也行', () => {
  assert.equal(coerceUrl('example.com'), 'https://example.com');
  assert.equal(coerceUrl('b01.test:8800/a'), 'https://b01.test:8800/a');
  assert.equal(coerceUrl('http://x.com'), 'http://x.com');
  assert.equal(coerceUrl(''), '');
});

test('normalizeUrl 去掉协议、www、末尾斜杠和跟踪参数，保留单页应用路由', () => {
  assert.equal(normalizeUrl('https://www.Example.com/a/?utm_source=x&b=2&a=1#top'), 'example.com/a?a=1&b=2');
  assert.equal(normalizeUrl('http://example.com:80/'), 'example.com');
  assert.equal(normalizeUrl('https://example.com:8443/'), 'example.com:8443');
  assert.equal(normalizeUrl('https://app.test/#/sign'), 'app.test#/sign');
  assert.equal(normalizeUrl('https://a.test/x'), normalizeUrl('http://a.test/x/'));
});

test('looseUrlKey 只看域名和路径', () => {
  assert.equal(looseUrlKey('https://www.a.com/p/?id=1'), looseUrlKey('http://a.com/p?id=2'));
});

test('domainOf 去掉 www，坏网址返回空串', () => {
  assert.equal(domainOf('https://www.zhihu.com/question/1'), 'zhihu.com');
  assert.equal(domainOf('nope'), '');
});

test('splitTitle 拆成主标题和简介', () => {
  assert.deepEqual(splitTitle('LINUX SB - 更新的技术社区', 'https://linux.sb/'), { main: 'LINUX SB', sub: '更新的技术社区' });
  assert.deepEqual(splitTitle('如何评价？ - 知乎', 'https://www.zhihu.com/question/1'), { main: '如何评价？', sub: '知乎' });
  assert.deepEqual(splitTitle('GitHub - owner/repo: A tool', 'https://github.com/owner/repo'), { main: 'owner/repo', sub: 'A tool · GitHub' });
  assert.deepEqual(splitTitle('owner/repo: 说明文字', 'https://github.com/owner/repo'), { main: 'owner/repo', sub: '说明文字' });
  assert.deepEqual(splitTitle('Figma', 'https://figma.com'), { main: 'Figma', sub: '' });
  assert.deepEqual(splitTitle('Re: 关于签到', 'https://x.test/t/1'), { main: 'Re: 关于签到', sub: '' });
});

test('siteMatches 子域名也算同一个网站', () => {
  assert.equal(siteMatches('example.com', 'https://login.example.com/x'), true);
  assert.equal(siteMatches('example.com', 'https://example.org'), false);
  assert.equal(siteMatches('https://www.example.com/', 'https://example.com'), true);
});

test('clampText 按字符截断', () => {
  assert.equal(clampText('一二三四五', 3), '一二三');
  assert.equal(clampText(null, 3), '');
});

test('plainText 去掉 Markdown 标记', () => {
  const t = plainText('# 标题\n**粗体** [链接](https://a.test)');
  assert.ok(t.includes('标题') && t.includes('粗体') && t.includes('链接'));
  assert.ok(!t.includes('**') && !t.includes('https://a.test'));
});

test('formatWhen 今天显示时刻', () => {
  const now = new Date('2026-10-15T10:00:00').getTime();
  assert.match(formatWhen(now - 60_000, now), /今天|刚刚|分钟/);
});
