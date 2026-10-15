// 端到端测试的公共部分：把 extension/ 复制到临时目录（额外授权 http://*/*，方便访问本机模拟网站），
// 用全新的浏览器配置加载，返回调用后台接口、打开页面的小工具。
import { chromium } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const EXTENSION_ID = 'mdhhcfefflbkpbhgkflolailnmagdbbb';
const BASE = `chrome-extension://${EXTENSION_ID}`;

export async function launch({ hostRules = 'MAP *.test 127.0.0.1, MAP * ~NOTFOUND', viewport = { width: 1360, height: 900 } } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mibox-e2e-'));
  const ext = path.join(tmp, 'extension');
  fs.cpSync(path.join(ROOT, 'extension'), ext, { recursive: true });
  const manifestPath = path.join(ext, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.host_permissions = [...(manifest.host_permissions || []), 'http://*/*'];
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  // 插件只能在完整的 Chromium 里加载（channel: 'chromium' 用新版无头模式），精简版无头浏览器不支持。
  const ctx = await chromium.launchPersistentContext(path.join(tmp, 'profile'), {
    channel: 'chromium',
    headless: true,
    viewport,
    locale: 'zh-CN',
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, `--host-resolver-rules=${hostRules}`, '--no-proxy-server'],
  });
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker');
  const page = ctx.pages()[0] || (await ctx.newPage());
  const errors = [];
  const watch = (p, tag) => {
    p.on('pageerror', (e) => errors.push(`${tag}: ${e.message}`));
    p.on('console', (m) => m.type() === 'error' && errors.push(`${tag} console: ${m.text()}`));
  };
  watch(page, 'app');
  const call = (type, payload) =>
    Promise.race([
      page.evaluate(async ([t, p]) => (await import('/src/shared/client.js')).call(t, p), [type, payload]),
      new Promise((_, reject) => setTimeout(() => reject(new Error('后台没有响应：' + type)), 60000)),
    ]);
  const go = async (hash, wait = 900) => {
    await page.goto('about:blank');
    await page.goto(`${BASE}/src/ui/app/app.html#${hash}`);
    await page.waitForTimeout(wait);
  };
  const close = async () => {
    await ctx.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  };
  return { ctx, sw, page, call, go, errors, watch, close, base: BASE };
}

export function check(results, name, ok, info = '') {
  results.push({ name, ok: !!ok, info });
  console.log(`${ok ? '✓' : '✗'} ${name}${info ? '  ' + info : ''}`);
}
