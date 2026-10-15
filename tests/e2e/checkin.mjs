// 签到助手端到端测试：50 个模拟网站 + 模拟 AI。
// 批量添加 → 一键签到 → 同一天再跑（应全部「今天已签过」）→ 第二天按记住的做法再跑。
// 运行：cd tests && npm install && npx playwright install chromium && npm run e2e:checkin
import { launch, check } from './lib.mjs';
import { startMockSites, SITES } from './mock-sites.mjs';

const PASSWORD = 'Test-Password-2026!';
const mock = await startMockSites({ port: Number(process.env.MOCK_PORT || 8800) });
const admin = async (p) => (await fetch(`http://127.0.0.1:${mock.port}${p}`)).text();
const t = await launch();
const { page, call, go, sw } = t;
const results = [];
const expectOf = Object.fromEntries(SITES.map((s) => [s.host, s.expect]));
const hostOf = (u) => new URL(u).hostname;

try {
  await go('/tools');
  await call('vault.prepare', { password: PASSWORD });
  await call('vault.commit');
  const ai = await call('vault.save', { kind: 'key', name: '测试 AI', secret: { secret: 'sk-test', fields: [], ai: { baseUrl: `http://ai.test:${mock.port}/v1`, model: 'fake-1' } } });
  await call('vault.save', { kind: 'login', name: 'lg2 账号', site: 'lg2.test', secret: { username: 'tester', password: 'pw-123456', url: `http://lg2.test:${mock.port}/` } });
  await call('settings.update', { onboarded: true, ai: { entryId: ai.id }, tools: { checkin: true }, checkin: { time: '', concurrency: 3, ai: true } });

  // 批量添加：在界面上粘贴
  await go('/tools/checkin', 1200);
  await page.click('button[data-click=batchAdd]');
  await page.fill('#ba-text', await admin('/list'));
  await page.waitForTimeout(300);
  check(results, '批量添加按钮显示数量', /添加 50 个网站/.test(await page.locator('[data-click=baAdd]').innerText()));
  await page.click('[data-click=baAdd]');
  await page.waitForTimeout(1500);
  const tasks = (await call('tasks.list')).filter((x) => x.kind === 'checkin');
  check(results, '添加了 50 个自动识别任务', tasks.length === 50 && tasks.every((x) => x.mode === 'auto'), String(tasks.length));

  async function round(expectFn, label) {
    await go('/tools/checkin', 800);
    await page.click('button[data-click=runAll]');
    const t0 = Date.now();
    let b;
    do {
      await page.waitForTimeout(2000);
      b = await call('tasks.batch');
    } while (b.running && Date.now() - t0 < 10 * 60000);
    const wrong = b.items.filter((i) => expectFn(hostOf(i.url)) !== i.status);
    check(results, `${label}：${b.items.length - wrong.length}/${b.items.length} 符合预期`, !wrong.length, `${Math.round((Date.now() - t0) / 1000)}s`);
    for (const i of wrong) console.log(`    ${hostOf(i.url)} 预期 ${expectFn(hostOf(i.url))}，实际 ${i.status}：${i.message}`);
    return b;
  }

  await round((h) => expectOf[h], '第一天');
  await round((h) => (['ok', 'already'].includes(expectOf[h]) ? 'already' : expectOf[h]), '同一天再跑');
  await admin('/reset');
  const aiBefore = JSON.parse(await admin('/state')).aiCalls;
  const b3 = await round((h) => expectOf[h], '第二天');
  check(results, '第二天大多按记住的做法', b3.items.filter((i) => /记住的做法/.test(i.message)).length >= 25);
  check(results, '第二天几乎不再问 AI', JSON.parse(await admin('/state')).aiCalls - aiBefore <= 2);

  const aiLog = JSON.parse(await admin('/ai'));
  check(results, '发给 AI 的内容里没有账号、密码和密钥', aiLog.length > 0 && !aiLog.some((x) => /pw-123456|sk-test|tester/.test(x)), `${aiLog.length} 次请求`);

  // 停止
  await admin('/reset');
  await go('/tools/checkin', 800);
  await page.click('button[data-click=runAll]');
  await page.waitForTimeout(3000);
  await page.click('[data-click=stopBatch]');
  let bs;
  for (let i = 0; i < 60; i++) {
    await page.waitForTimeout(1000);
    bs = await call('tasks.batch');
    if (!bs.running) break;
  }
  check(results, '可以中途停止', !bs.running && bs.items.some((i) => i.status === 'skipped'));
  check(results, '批量窗口已关闭', (await sw.evaluate(async () => (await chrome.windows.getAll()).length)) === 1);
  check(results, '页面没有报错', !t.errors.length, t.errors.slice(0, 3).join(' | '));
} finally {
  await t.close();
  await mock.close();
}
const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `\n${failed.length} 项没有通过` : `\n全部 ${results.length} 项通过`);
process.exit(failed.length ? 1 : 0);
