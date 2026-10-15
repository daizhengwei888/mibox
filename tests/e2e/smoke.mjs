// 冒烟测试：全新安装后打开每个页面、小窗口和常用浮层，确认没有报错；导出再导入一份备份。
// 运行：cd tests && npm run e2e:smoke
import { launch, check } from './lib.mjs';

const t = await launch({ viewport: { width: 1440, height: 900 } });
const { page, call, go, ctx, base, watch } = t;
const results = [];
try {
  await go('/welcome', 1200);
  check(results, '首次使用页能打开', await page.locator('text=用 Chrome 里的 Google 账号登录').count());
  // 准备一点资料
  const g = await call('groups.create', { name: '设计灵感' });
  for (const [title, url, fav] of [['Figma', 'https://www.figma.com/', true], ['LINUX SB - 更新的技术社区', 'https://linux.sb/', false], ['GitHub - owner/repo: 说明', 'https://github.com/owner/repo', false]]) {
    const saved = await call('bookmarks.save', { title, url, groupId: g.id });
    const b = saved.bookmark || saved;
    if (fav) await call('bookmarks.update', { id: b.id, patch: { favorite: true } });
  }
  await call('notes.save', { title: '笔记', body: '# 标题\n`code` **粗**' });
  await call('settings.update', { onboarded: true });

  for (const h of ['/home', '/bookmarks', '/bookmarks?group=fav', '/notes', '/vault', '/tools', '/tools/checkin', '/publish/github', '/publish/cloudflare', '/settings/account', '/settings/vault', '/settings/import', '/settings/keys', '/settings/privacy', '/settings/advanced', '/independent']) {
    await go(h, 900);
    check(results, `打开 ${h}`, !(await page.locator('.notice.danger').count()));
  }
  await go('/bookmarks');
  check(results, '卡片标题拆成主标题和简介', (await page.locator('.bm-card .subtitle').count()) >= 2);
  await page.keyboard.press('Control+K');
  await page.waitForTimeout(300);
  check(results, 'Ctrl+K 打开搜索', await page.locator('.search-holder').count());
  await page.keyboard.press('Escape');
  await page.click('.bm-top .appearance-btn');
  await page.waitForTimeout(300);
  check(results, '外观面板能打开', await page.locator('.appearance-pop').count());
  await page.keyboard.press('Escape');

  // 小窗口
  for (const u of ['src/ui/popup/popup.html', 'src/ui/sidepanel/sidepanel.html', 'src/ui/search/search.html?mode=window']) {
    const p = await ctx.newPage();
    watch(p, u);
    await p.goto(`${base}/${u}`);
    await p.waitForTimeout(800);
    await p.close();
  }

  // 备份往返
  const exp = await call('export.backup', { includeVault: false });
  const lib0 = await call('library.get');
  await call('bookmarks.remove', { ids: [lib0.bookmarks[0].id] });
  const r = await call('import.backup', { data: JSON.parse(exp.text) });
  check(results, '完整备份导出后能导回来', r.added === 1, JSON.stringify({ added: r.added, skipped: r.skipped }));
  check(results, '页面没有报错', !t.errors.length, t.errors.slice(0, 3).join(' | '));
} finally {
  await t.close();
}
const failed = results.filter((x) => !x.ok);
console.log(failed.length ? `\n${failed.length} 项没有通过` : `\n全部 ${results.length} 项通过`);
process.exit(failed.length ? 1 : 0);
