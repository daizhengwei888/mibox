// 笔记预览：先转义再加标签，笔记里的 HTML 和 javascript: 链接不会生效。
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown } from '../../extension/src/ui/kit/markdown.js';

test('HTML 被转义', () => {
  const out = renderMarkdown('<img src=x onerror=alert(1)> <script>x</script>');
  assert.ok(!out.includes('<img') && !out.includes('<script'));
  assert.ok(out.includes('&lt;img'));
});

test('只认 http / https 链接', () => {
  assert.ok(!renderMarkdown('[点我](javascript:alert(1))').includes('href="javascript'));
  assert.ok(renderMarkdown('[谜盒](https://example.com)').includes('<a href="https://example.com"'));
});

test('属性里不能逃出引号', () => {
  const out = renderMarkdown('[x](https://a.test/"onmouseover="alert(1))');
  assert.ok(!/href="[^"]*"onmouseover=/.test(out));
});

test('常用语法', () => {
  const out = renderMarkdown('# 标题\n- [x] 完成\n- 普通\n\n**粗** *斜* `code`\n\n```\n<b>\n```');
  assert.ok(out.includes('<h1>标题</h1>'));
  assert.ok(out.includes('type="checkbox" disabled checked'));
  assert.ok(out.includes('<strong>粗</strong>') && out.includes('<em>斜</em>') && out.includes('<code>code</code>'));
  assert.ok(out.includes('<pre><code>&lt;b&gt;</code></pre>'));
});
