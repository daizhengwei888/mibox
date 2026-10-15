// 设置页：账号与同步、保险箱、收藏与导入、快捷键、隐私与数据、高级设置。外观在首页、收藏页右上角。

import { html, morph, bind, scheduler } from '../../kit/dom.js';
import { icon } from '../../kit/icons.js';
import { toast, toastError, modal, confirmBox, promptBox, downloadText, pickFile, copyText } from '../../kit/ui.js';
import { call, onChange } from '../../../shared/client.js';
import { formatWhen } from '../../../shared/util.js';
import { syncSummary } from '../store.js';
import { passwordScore } from './vault.js';

const SECTIONS = [
  ['account', '账号与同步', 'cloud'],
  ['vault', '保险箱', 'lock'],
  ['import', '收藏与导入', 'download'],
  ['keys', '快捷键', 'keyboard'],
  ['privacy', '隐私与数据', 'shield'],
  ['advanced', '高级设置', 'settings'],
];

const ROOT_FOLDERS = new Set(['书签', '书签栏', '其他书签', '移动设备书签', 'Bookmarks', 'Bookmarks bar', 'Bookmarks Bar', 'Bookmarks Toolbar', 'Other bookmarks', 'Other Bookmarks', 'Mobile bookmarks', '收藏夹栏', '其他收藏夹']);

/** 解析浏览器导出的书签文件（Netscape 格式）。 */
export function parseBookmarkHtml(text) {
  const doc = new DOMParser().parseFromString(text, 'text/html');
  const items = [];
  const folders = new Set();
  for (const a of doc.querySelectorAll('a[href]')) {
    const url = a.getAttribute('href');
    if (!/^https?:\/\//i.test(url || '')) continue;
    const path = [];
    let node = a;
    while ((node = node.parentElement)) {
      if (node.tagName === 'DL') {
        let title = null;
        const prev = node.previousElementSibling;
        if (prev && prev.tagName === 'H3') title = prev.textContent;
        else if (node.parentElement?.tagName === 'DT') title = node.parentElement.querySelector(':scope > h3')?.textContent || null;
        if (title) path.unshift(title.trim());
      }
    }
    const folder = path.find((p) => p && !ROOT_FOLDERS.has(p)) || null;
    if (folder) folders.add(folder);
    const add = Number(a.getAttribute('add_date'));
    const dd = a.closest('dt')?.nextElementSibling;
    items.push({
      url,
      title: a.textContent.trim(),
      createdAt: add > 0 ? add * 1000 : undefined,
      folder,
      note: dd && dd.tagName === 'DD' ? dd.textContent.trim().slice(0, 2000) : '',
    });
  }
  return { items, folders: [...folders] };
}

export default {
  title: '设置',
  mount(root, ctx) {
    const state = { preview: null, lastImport: null, foldersAsGroups: true, withVault: true, workspace: null, vault: null, historyPermission: null, historyPermissionError: '', busy: '', actionError: '' };
    let disposed = false;
    let historyPermissionSeq = 0;
    const render = scheduler(() => { if (!disposed) draw(); });
    const section = () => (SECTIONS.some((s) => s[0] === ctx.route.parts[0]) ? ctx.route.parts[0] : 'account');

    async function load() {
      const [preview, lastImport, workspace, vault] = await Promise.all([
        call('chrome.importPreview').catch(() => null),
        call('chrome.lastImport').catch(() => null),
        call('workspace.status').catch(() => null),
        call('vault.status').catch(() => null),
      ]);
      Object.assign(state, { preview, lastImport, workspace, vault });
      render();
    }

    async function loadHistoryPermission() {
      const seq = ++historyPermissionSeq;
      try {
        if (typeof chrome === 'undefined' || !chrome.permissions?.contains) throw new Error('当前环境无法读取浏览历史权限');
        const granted = await chrome.permissions.contains({ permissions: ['history'] });
        if (disposed || seq !== historyPermissionSeq) return;
        state.historyPermission = granted;
        state.historyPermissionError = '';
      } catch (e) {
        if (disposed || seq !== historyPermissionSeq) return;
        state.historyPermission = null;
        state.historyPermissionError = `无法读取权限状态：${e?.message || '请稍后重试'}`;
      }
      render();
    }

    const sw = (on, act, label, extra = '') => html`<button type="button" class="switch" role="switch" aria-checked="${on ? 'true' : 'false'}" aria-label="${label}" data-click="${act}" ${extra}></button>`;
    const rowT = (t, d) => html`<div class="txt"><span class="t">${t}</span>${d ? html`<span class="d">${d}</span>` : ''}</div>`;

    function account() {
      const s = ctx.store.sync || {};
      const st = ctx.store.settings;
      const sum = syncSummary(s);
      return html`<section class="set-section"><h2>账号与同步</h2>
        ${state.actionError ? html`<div class="notice danger" role="alert">${icon('alert', 16)}<span>${state.actionError}。可以用下面的按钮重试，资料会保留在本机。</span></div>` : ''}
        ${s.vaultConflict ? html`<div class="notice warn">${icon('alert', 16)}<span>云端保险箱与本机不同，两份内容已保留。<a href="#/vault">去保险箱处理</a></span></div>` : ''}
        <div class="set-card">
          ${s.signedIn
            ? html`<div class="set-row"><span class="avatar">${(s.user?.email || '?')[0].toUpperCase()}</span>${rowT(s.user?.email, s.otherAccount ? `Chrome 现在登录的是 ${s.otherAccount}。重新登录后切换到该账号独立的资料库，当前资料保留。` : s.reauth ? '登录已失效，重新登录后继续同步' : 'Chrome 里的 Google 账号，资料同步到这个账号')}
                ${s.reauth || s.otherAccount ? html`<button type="button" class="btn pri sm" data-click="signIn" ${state.busy ? 'disabled' : ''}>${state.busy === 'signin' ? html`<span class="spinner"></span>正在登录…` : '重新登录'}</button>` : ''}<button type="button" class="btn sm" data-click="signOut" ${state.busy ? 'disabled' : ''}>${icon('logOut', 14)}退出登录</button></div>`
            : !s.configured
              ? html`<div class="set-row">${rowT('Google 登录还没有配置', '资料先保存在这台电脑上。需要配置登录时，请到高级设置。')}<a class="btn sm" href="#/settings/advanced">高级设置</a></div>`
              : html`<div class="set-row">${rowT('还没有登录 Google', '用 Chrome 当前登录的 Google 账号登录。收藏、笔记、保险箱（加密后）和工具设置会存到你自己的 Google Drive 应用私有空间，换一台电脑登录同一个账号就都在。')}
                <button type="button" class="btn pri" data-click="signIn" ${state.busy ? 'disabled' : ''}>${state.busy === 'signin' ? html`<span class="spinner"></span>正在打开登录…` : html`${icon('user', 16)}用 Chrome 里的 Google 账号登录`}</button></div>`}
          <div class="set-row">${rowT('自动同步', '新增、修改、删除后几秒内上传。断网时先存在本机，联网后自动补传。')}${sw(st.sync.auto, 'toggleAuto', '自动同步', s.signedIn ? '' : 'disabled')}</div>
          ${s.signedIn
            ? html`<div class="set-row"><span class="row grow" style="gap:8px"><span class="dot ${sum.dot}"></span><span>${sum.detail}${s.lastSyncAt ? `上次同步：${formatWhen(s.lastSyncAt)}。` : ''}</span></span>
                <button type="button" class="btn sm" data-click="syncNow" ${s.syncing || state.busy || s.reauth || s.otherAccount ? 'disabled' : ''}>${s.syncing || state.busy === 'sync' ? html`<span class="spinner"></span>正在同步…` : html`${icon('refresh', 14)}${state.actionError || s.lastError ? '重试同步' : '立即同步'}`}</button></div>`
            : ''}
        </div>
        <details class="adv set-card" style="padding:0 18px"><summary>选择同步内容</summary><div>
          <div class="set-row"><fieldset style="border:0;padding:0;margin:0;display:flex;flex-direction:column;gap:10px"><legend class="t" style="font-weight:600;margin-bottom:10px">同步哪些内容</legend>
            ${[['bookmarks', '收藏和分组'], ['notes', '笔记'], ['vault', '保险箱（加密后上传）'], ['tools', '工具设置和签到任务']].map(
              ([k, t]) => html`<label class="check"><input type="checkbox" data-change="what" data-k="${k}" ${st.sync[k] ? 'checked' : ''}>${t}</label>`,
            )}</fieldset></div>
        </div></details>
        ${s.conflicts?.length ? html`<div class="set-card">
          <div class="set-row">${rowT('需要处理的笔记冲突', '两份笔记都已保留，请看过后选择保留的内容。')}</div>
          ${(s.conflicts || []).map(
            (c) => html`<div class="set-row" data-key="${c.id}" style="padding-left:34px">${icon('alert', 16)}<span class="grow">「${c.title}」· ${formatWhen(c.at)}</span>
              <a class="btn sm" href="#/notes/${c.noteId}">看原来的</a><a class="btn sm" href="#/notes/${c.copyId}">看副本</a><button type="button" class="btn sm ghost" data-click="dismiss" data-id="${c.id}">知道了</button></div>`,
          )}
        </div>` : ''}
      </section>`;
    }

    function workspaceCard() {
      const w = state.workspace;
      if (!w) return '';
      const a = w.account;
      const localCounts = w.localCounts || {};
      const hasLocal = Object.values(localCounts).some((n) => Number(n) > 0);
      // 登录前用过一段时间、这台电脑上还有「未登录时的资料」：可以复制到当前账号
      if (!(hasLocal && a)) return '';
      const localCountText = `收藏 ${localCounts.bookmarks || 0} 条、分组 ${localCounts.groups || 0} 个、笔记 ${localCounts.notes || 0} 条、签到 ${localCounts.tasks || 0} 个、保险箱 ${localCounts.vault || 0} 条`;
      return html`<div class="set-card">
        <div class="set-row">${rowT('当前资料归属', `${a.email || '当前 Google 账号'}。这个页面只显示当前账号的资料。`)}</div>
        <div class="set-row"><span class="txt"><span class="t">发现未登录时的资料</span><span class="d">${localCountText}。确认属于你后，可以复制到当前账号，不会读取其他账号的资料。</span></span>
          <button type="button" class="btn sm" data-click="copyLocal" ${state.busy === 'copyLocal' ? 'disabled' : ''}>复制到当前账号</button></div>
      </div>`;
    }

    function vaultSection() {
      const v = state.vault;
      const st = ctx.store.settings;
      const exists = v?.exists;
      return html`<section class="set-section"><h2>保险箱</h2>
        ${!exists ? html`<div class="notice">${icon('info', 16)}<span>还没有设置保险箱。<a href="#/vault">去设置</a></span></div>` : ''}
        <div class="set-card">
          <div class="set-row">${rowT('主密码', '解锁保险箱和填入账号都用这一个密码。')}<button type="button" class="btn sm" data-click="changePw" ${exists ? '' : 'disabled'}>修改主密码</button></div>
          <div class="set-row">${rowT('自动锁定', '没有操作多久后重新锁上。')}
            <select class="select" aria-label="自动锁定" data-change="lockTime">${[[5, '5 分钟'], [15, '15 分钟'], [60, '1 小时'], [240, '4 小时'], [0, '关闭浏览器时']].map(([n, t]) => html`<option value="${n}" ${st.autoLockMinutes === n ? 'selected' : ''}>${t}</option>`)}</select></div>
          <div class="set-row">${rowT('复制后清空剪贴板', '复制密码或密钥 30 秒后自动清空。')}${sw(st.clipboardClear, 'toggleClip', '复制后清空剪贴板')}</div>
          <div class="set-row">${rowT('恢复密钥', '忘记主密码时唯一的找回方式。重新生成后，旧的恢复密钥立即失效。')}<button type="button" class="btn sm" data-click="regenKey" ${exists ? '' : 'disabled'}>重新生成</button></div>
        </div></section>`;
    }

    function withVaultRow() {
      if (!state.vault?.exists) return '';
      return html`<div class="set-row" style="padding-top:0;border-top:0"><label class="check"><input type="checkbox" data-change="withVault" ${state.withVault ? 'checked' : ''}>完整备份里包含保险箱（加密的，导入时用主密码解锁）</label></div>`;
    }

    function importSection() {
      const p = state.preview;
      const li = state.lastImport;
      const st = ctx.store.settings;
      return html`<section class="set-section"><h2>收藏与导入</h2>
        ${workspaceCard()}
        <div class="set-card">
          <div class="set-row">${rowT('从 Chrome 导入书签', p ? `Chrome 里有 ${p.scanned} 个书签：${p.importable} 条可以导入，${p.duplicate} 条已经在这里了${p.skipped ? `，${p.skipped} 条不是网页` : ''}。已经存在的网址会跳过，可以放心重复导入。` : '已经存在的网址会跳过，可以放心重复导入。')}
            <button type="button" class="btn sm ${p && !p.importable ? '' : 'pri'}" data-click="importChrome" ${state.busy === 'chrome' || (p && !p.importable) ? 'disabled' : ''}>${state.busy === 'chrome' ? html`<span class="spinner"></span>` : ''}导入</button></div>
          <div class="set-row" style="padding-top:0;border-top:0"><label class="check"><input type="checkbox" data-change="folders" ${state.foldersAsGroups ? 'checked' : ''}>把 Chrome 文件夹变成分组</label>
            ${li ? html`<span class="small muted">上次导入：${formatWhen(li.at)}，新增 ${li.added} 条</span>` : ''}</div>
          <div class="set-row">${rowT('导入书签文件', '任何浏览器导出的书签文件（.html），文件夹会变成分组。已经存在的网址会跳过。')}
            <button type="button" class="btn sm" data-click="importFile" ${state.busy ? 'disabled' : ''}>${state.busy === 'file' ? html`<span class="spinner"></span>` : icon('fileUp', 14)}选择文件</button></div>
          <div class="set-row">${rowT('导入备份', '用下面「导出 › 完整备份」存下的 .json 文件恢复：收藏、分组、笔记和签到任务，带保险箱的备份用原来的主密码解锁。按网址合并，已经有的不会重复、也不会被覆盖，可以放心重复导入。')}
            <button type="button" class="btn sm" data-click="importBackup" ${state.busy ? 'disabled' : ''}>${state.busy === 'backup' ? html`<span class="spinner"></span>` : icon('fileUp', 14)}选择备份</button></div>
          <div class="set-row">${rowT('导出', '书签文件可以导入任何浏览器；完整备份包含收藏、分组、笔记和签到任务。')}
            <button type="button" class="btn sm" data-click="exportHtml">${icon('download', 14)}书签文件</button><button type="button" class="btn sm" data-click="exportJson">${icon('download', 14)}完整备份</button></div>
          ${withVaultRow()}
          <div class="set-row">${rowT('打开收藏时', '按住 Ctrl（Mac 上是 ⌘）点击总是在新标签页打开。')}
            <select class="select" aria-label="打开收藏时" data-change="openIn"><option value="new" ${st.openIn === 'new' ? 'selected' : ''}>在新标签页打开</option><option value="current" ${st.openIn === 'current' ? 'selected' : ''}>在当前标签页打开</option></select></div>
          <div class="set-row">${rowT('查找重复', '找出网址相同或只差参数的收藏，合并时保留备注。')}<button type="button" class="btn sm" data-click="dupes">开始查找</button></div>
        </div></section>`;
    }

    function keys() {
      const rows = [
        ['快速搜索', '任何网页', 'Alt + Shift + K'],
        ['收藏当前网页', '任何网页', 'Alt + Shift + S'],
        ['打开侧栏', '任何网页', 'Alt + Shift + B'],
        ['搜索全部', '完整页内', 'Ctrl + K'],
        ['聚焦当前搜索框', '完整页内', '/'],
        ['新建笔记', '完整页内', 'N'],
      ];
      return html`<section class="set-section"><h2>快捷键</h2>
        <table class="table keys-table"><tbody>${rows.map(([n, w, k]) => html`<tr><th scope="row" style="background:none;color:var(--text);font-size:14px">${n}</th><td class="muted">${w}</td><td style="text-align:right">${k.split(' + ').map((x, i) => html`${i ? ' + ' : ''}<kbd>${x}</kbd>`)}</td></tr>`)}</tbody></table>
        <p class="small muted">前三个全局快捷键可以在 <button type="button" class="link-btn" data-click="shortcuts">chrome://extensions/shortcuts</button> 修改。Mac 上 Ctrl 换成 ⌘。</p>
      </section>`;
    }

    function privacy() {
      const historyStatus = state.historyPermissionError || (state.historyPermission === null ? '正在检查权限状态…' : state.historyPermission ? '已开启。首页会根据近期访问记录计算已收藏站点的排行。' : '未开启。需要时仍可在首页授权查看。');
      const facts = [
        ['资料放在哪里', '这台电脑的浏览器里；登录 Google 后，另存一份在你自己的 Google Drive 应用私有空间。它不会出现在 Drive 文件列表里，只有本插件能读写。'],
        ['谁能看到', '收藏和笔记以普通格式保存在你的 Google 账号里。保险箱先在本机加密，没有主密码谁都打不开，包括 Google 和插件作者。'],
        ['会申请哪些权限', '安装时不申请访问所有网站。签到、填入账号这类功能，第一次用到某个网站时才单独询问，可以随时在扩展详情页撤销。'],
        ['最常使用如何计算', '授权后按近 90 天访问记录在本机计算已收藏站点的排行。权限状态、关闭入口和完整计算说明见上方“首页排行”。'],
        ['不会做什么', '不统计你在网页上的停留时间，不上传未保存的草稿，不使用任何第三方统计。'],
      ];
      return html`<section class="set-section"><h2>隐私与数据</h2>
        <h3 class="section-title">首页排行</h3>
        <div class="set-card"><div class="set-row">${rowT('浏览历史权限', historyStatus)}<button type="button" class="btn sm" data-click="removeHistory" ${state.historyPermission && !state.busy ? '' : 'disabled'}>${state.busy === 'removeHistory' ? html`<span class="spinner"></span>正在关闭…` : '关闭历史权限'}</button></div></div>
        <details class="adv set-card" style="padding:0 18px"><summary>关于这个排行</summary><div><p class="small muted" style="line-height:1.8">按当前 Chrome 个人资料近 90 天的逐次访问记录计算，包括浏览器同步到本机的访问。同一来源站点只显示一位，保留不同子域名；同源未收藏页面的访问也可能计入，打开时使用你保存的代表收藏。按 UTC 日每天最多计入 8 次，再按 14 天半衰期衰减；排除刷新、子框架和自动启动访问。排行缓存只存当前账号本机，不上传原始历史或统计。</p></div></details>
        <div class="set-card"><dl class="facts">${facts.map(([q, a]) => html`<dt>${q}</dt><dd>${a}</dd>`)}</dl></div>
        <details class="adv set-card" style="padding:0 18px"><summary>技术细节</summary><div><p class="small muted" style="line-height:1.8">
          保险箱使用 AES-256-GCM 加密，密钥由主密码经 PBKDF2-SHA256（60 万次迭代）在本机派生，只有密文会上传；解锁后的密钥只放在浏览器内存里，关闭浏览器即消失。
          同步使用 Google 的 drive.appdata 权限，只能访问本插件自己创建的文件；登录直接使用 Chrome 自带的 Google 账号（chrome.identity），令牌由 Chrome 管理，不经过任何中间服务器。站点权限按网站单独申请。</p></div></details>
        <div class="set-card">
          <div class="set-row">${rowT('导出全部资料', '收藏、分组、笔记和签到任务，一个 JSON 文件。')}<button type="button" class="btn sm" data-click="exportJson">${icon('download', 14)}导出</button></div>
          ${withVaultRow()}
          <div class="set-row">${rowT('清除本机资料', '删除这台电脑上的收藏、笔记、保险箱和设置。云端资料不受影响，重新登录后可以同步回来。')}<button type="button" class="btn sm danger" data-click="wipe">清除本机资料</button></div>
        </div></section>`;
    }

    function advanced() {
      const s = ctx.store.sync || {};
      return html`<section class="set-section"><h2>高级设置</h2>
        <div class="notice">${icon('info', 16)}<span>普通使用无需配置 Google 项目，在<a href="#/settings/account">账号与同步</a>里登录即可。</span></div>
        <div class="set-card">
          <div class="set-row">${rowT('自己的 Google 项目（可选）', '需要独立管理登录和同步时再配置。项目、权限和客户端 ID 都在向导里设置。')}<a class="btn sm" href="#/independent">开始配置</a></div>
          <div class="set-row">${rowT('更换配置前', '向导会先备份原配置和本机资料。更换后需要重新登录；新项目的云空间可能没有旧资料，请先保留完整备份。')}</div>
        </div>
        <details class="adv set-card" style="padding:0 18px"><summary>账号与云端数据操作</summary><div>
          <div class="set-row">${rowT('撤销 Google 授权', '关闭本插件的 Google 访问权限并退出当前账号。之后同步需要重新授权。')}<button type="button" class="btn sm danger" data-click="revoke" ${s.signedIn && !state.busy ? '' : 'disabled'}>撤销 Google 授权</button></div>
          <div class="set-row">${rowT('清除云端资料', '删除这个 Google 账号里本插件的同步文件，并暂停自动同步。这台电脑上的资料保留。')}
            <button type="button" class="btn sm danger" data-click="clearCloud" ${s.signedIn && !state.busy ? '' : 'disabled'}>清除云端资料</button></div>
        </div></details>
      </section>`;
    }

    function draw() {
      if (!ctx.store.settings) return;
      const cur = section();
      const body = { account, vault: vaultSection, import: importSection, keys, privacy, advanced }[cur]();
      morph(
        root,
        html`<div class="page"><div class="page-head"><h1>设置</h1></div>
          <div class="settings">
            <nav class="settings-tabs" aria-label="设置分区">${SECTIONS.map(([k, t, ic]) => html`<a href="#/settings/${k}" ${cur === k ? html`aria-current="page"` : ''}>${icon(ic, 16)}${t}</a>`)}</nav>
            <div>${body}</div>
          </div></div>`,
      );
    }

    const update = (patch, msg) =>
      call('settings.update', patch)
        .then(() => msg && toast(msg))
        .catch(toastError);

    function showKeyDialog(key, title) {
      modal({
        title,
        body: html`<p class="muted" style="line-height:1.7">请把新的恢复密钥抄下来或下载保存。旧的恢复密钥已经失效。</p>
          <div class="recovery-box">${key}</div>
          <div class="modal-foot"><button type="button" class="btn" data-x="copy">${icon('copy', 14)}复制</button><button type="button" class="btn" data-x="dl">${icon('download', 14)}下载</button><button type="button" class="btn pri" data-x="ok">我已保存</button></div>`,
        onMount(box, close) {
          box.querySelector('[data-x=copy]').addEventListener('click', () => copyText(key).then(() => toast('已复制')));
          box.querySelector('[data-x=dl]').addEventListener('click', () => downloadText('谜盒-保险箱恢复密钥.txt', `谜盒插件 · 保险箱恢复密钥\n\n${key}\n\n生成时间：${new Date().toLocaleString('zh-CN')}\n`));
          box.querySelector('[data-x=ok]').addEventListener('click', () => close());
        },
      });
    }

    function duplicatesDialog(groups) {
      if (!groups.length) {
        toast('没有找到重复的收藏');
        return;
      }
      const keep = new Map(groups.map((g) => [g.key, g.items[0].id]));
      modal({
        title: `找到 ${groups.length} 组重复`,
        wide: true,
        body: html`<p class="small muted">每组选一条保留，其他的备注会并到保留的那条，然后删除。删除后可以在提示里撤销。</p>
          <div class="col" style="gap:12px;max-height:60vh;overflow:auto" data-x="list">
          ${groups.map(
            (g, gi) => html`<fieldset class="panel" style="margin:0;display:flex;flex-direction:column;gap:6px"><legend class="small muted" style="padding:0 6px">${g.key}</legend>
              ${g.items.map((b, i) => html`<label class="check" style="align-items:flex-start"><input type="radio" name="g${gi}" value="${b.id}" ${i === 0 ? 'checked' : ''} data-g="${g.key}">
                <span class="grow"><span style="font-weight:600">${b.title}</span><span class="small muted ellipsis" style="display:block">${b.url} · ${formatWhen(b.createdAt)}</span></span></label>`)}
            </fieldset>`,
          )}</div>
          <div class="modal-foot"><button type="button" class="btn" data-x="cancel">取消</button><button type="button" class="btn pri" data-x="merge">全部合并</button></div>`,
        onMount(box, close) {
          box.querySelector('[data-x=list]').addEventListener('change', (e) => {
            if (e.target.dataset.g) keep.set(e.target.dataset.g, e.target.value);
          });
          box.querySelector('[data-x=cancel]').addEventListener('click', () => close());
          box.querySelector('[data-x=merge]').addEventListener('click', async () => {
            let removed = 0;
            for (const g of groups) {
              const k = keep.get(g.key);
              const r = await call('bookmarks.mergeDuplicates', { keepId: k, removeIds: g.items.map((b) => b.id).filter((id) => id !== k) }).catch(toastError);
              if (r) removed += r.removed;
            }
            close();
            toast(`已合并，删除了 ${removed} 条重复`);
          });
        },
      });
    }

    function vaultNote(v) {
      if (!v || !v.count) return '';
      if (v.mode === 'conflict') return `。文件里有另一个保险箱（${v.count} 条），请到保险箱页面决定怎么合并`;
      return `，保险箱 ${v.count} 条`;
    }

    /** 导入完整备份：先读出里面有什么，确认后再合并进来。 */
    async function importBackupFile(file) {
      let data;
      try {
        data = JSON.parse(await file.text());
      } catch {
        toastError(new Error('读不出这个文件：需要「完整备份」导出的 .json 文件'));
        return;
      }
      if (data?.format !== 'shuqian-backup/1') {
        toastError(new Error('这不是谜盒导出的完整备份（需要「导出 › 完整备份」存下的 .json 文件）'));
        return;
      }
      const n = (k) => (Array.isArray(data[k]) ? data[k].length : 0);
      const when = Date.parse(data.exportedAt);
      const parts = [`收藏 ${n('bookmarks')} 条`, `分组 ${n('groups')} 个`, `笔记 ${n('notes')} 条`, `签到任务 ${n('tasks')} 个`];
      if (data.vault) parts.push('加密的保险箱');
      const ok = await confirmBox({
        title: '导入这份备份？',
        text: `${Number.isFinite(when) ? `备份于 ${new Date(when).toLocaleString('zh-CN', { hour12: false })}。` : ''}包含${parts.join('、')}。按网址合并，已经有的不会重复或被覆盖；签到任务导入后先停用，确认网站授权后再打开。`,
        ok: '导入',
      });
      if (!ok) return;
      state.busy = 'backup';
      render();
      try {
        const r = await call('import.backup', { data });
        toast(`已导入：收藏 ${r.added} 条${r.skipped ? `（${r.skipped} 条已存在，跳过）` : ''}，笔记 ${r.notes} 条，签到任务 ${r.tasks} 个${vaultNote(r.vault)}`, { timeout: 6000 });
      } catch (e) {
        toastError(e);
      }
      state.busy = '';
      load();
    }

    async function importText(file) {
      const text = await file.text().catch(() => '');
      // 选错了文件也没关系：本插件的完整备份走「导入备份」的确认流程
      if (/\.json$/i.test(file.name) || text.trim().startsWith('{')) return importBackupFile(file);
      state.busy = 'file';
      render();
      try {
        const { items, folders } = parseBookmarkHtml(text);
        if (!items.length) throw new Error('文件里没有找到网页书签');
        const r = await call('bookmarks.importItems', { items, folders });
        toast(`已导入 ${r.added} 条${r.skipped ? `，跳过 ${r.skipped} 条已存在的` : ''}`);
      } catch (e) {
        toastError(e instanceof SyntaxError ? new Error('文件格式不对') : e);
      }
      state.busy = '';
      load();
    }

    const unbind = bind(root, {
      async signIn() {
        if (state.busy) return;
        state.busy = 'signin';
        state.actionError = '';
        render();
        try {
          await call('google.signIn');
          toast('已登录 Google，当前账号的资料库已打开');
        } catch (e) {
          state.actionError = e.message;
        }
        state.busy = '';
        render();
      },
      async signOut() {
        if (state.busy) return;
        const ok = await confirmBox({ title: '退出 Google 登录？', text: '会切换到独立的本机资料库；当前 Google 账号的资料副本会保留，之后重新登录该账号即可恢复。', ok: '退出登录' });
        if (ok) call('google.signOut').then(() => toast('已退出登录')).catch(toastError);
      },
      async revoke() {
        const ok = await confirmBox({ title: '撤销 Google 授权？', text: '会撤销本插件访问 Google Drive 应用私有空间的授权，并退出当前账号。之后需要重新授权才能同步。', ok: '撤销授权', danger: true });
        if (ok) call('google.revoke').then(() => toast('Google 授权已撤销')).catch(toastError);
      },
      async copyLocal() {
        const ok = await confirmBox({ title: '复制本机资料到当前账号？', text: '会把匿名本机资料复制到当前 Google 账号，重复执行不会重复添加。请确认这些资料属于你。', ok: '确认复制' });
        if (!ok) return;
        state.busy = 'copyLocal'; render();
        try { await call('workspace.copyLocal', { confirmed: true }); toast('本机匿名资料已复制到当前账号'); } catch (e) { toastError(e); }
        state.busy = '';
      },
      toggleAuto: () => call('sync.setAuto', { auto: !ctx.store.settings.sync.auto }).catch(toastError),
      async syncNow() {
        if (state.busy || ctx.store.sync?.syncing) return;
        state.busy = 'sync';
        state.actionError = '';
        render();
        try {
          await call('sync.now');
          toast('同步完成');
        } catch (e) {
          state.actionError = e.message;
        } finally {
          state.busy = '';
          render();
        }
      },
      what: (e, el) => call('sync.setWhat', { [el.dataset.k]: e.target.checked }).catch(toastError),
      dismiss: (e, el) => call('sync.dismissConflict', { id: el.dataset.id }).catch(toastError),
      async clearCloud() {
        const ok = await confirmBox({ title: '清除云端资料？', text: '删除这个 Google 账号里本插件的同步文件，并暂停自动同步。这台电脑上的资料保留。这一步不能撤销。', ok: '清除云端资料', danger: true });
        if (!ok) return;
        call('sync.clearCloud').then((r) => toast(r.removed ? '云端资料已清除，自动同步已暂停' : '云端本来就没有资料')).catch(toastError);
      },
      async changePw() {
        modal({
          title: '修改主密码',
          body: html`<form class="col" style="gap:14px" data-x="form" novalidate>
            <div class="field"><label for="cp-old">当前主密码</label><input id="cp-old" class="input" type="password" name="old" autocomplete="current-password" autofocus></div>
            <div class="field"><label for="cp-new">新的主密码</label><input id="cp-new" class="input" type="password" name="pw" autocomplete="new-password" placeholder="至少 12 个字符"><span class="hint" data-x="score"></span></div>
            <div class="field"><label for="cp-new2">再输入一次</label><input id="cp-new2" class="input" type="password" name="pw2" autocomplete="new-password"></div>
            <p class="small muted">恢复密钥不变。其他电脑同步后也要用新密码解锁。</p>
            <p class="error-text" data-x="err" hidden></p>
            <div class="modal-foot"><button type="button" class="btn" data-x="cancel">取消</button><button type="submit" class="btn pri">修改</button></div></form>`,
          onMount(box, close) {
            const form = box.querySelector('[data-x=form]');
            const err = box.querySelector('[data-x=err]');
            form.pw.addEventListener('input', () => (box.querySelector('[data-x=score]').textContent = passwordScore(form.pw.value).text));
            box.querySelector('[data-x=cancel]').addEventListener('click', () => close());
            form.addEventListener('submit', async (e) => {
              e.preventDefault();
              if (form.pw.value !== form.pw2.value) {
                err.textContent = '两次输入的新密码不一样';
                err.hidden = false;
                return;
              }
              const btn = form.querySelector('[type=submit]');
              btn.disabled = true;
              try {
                await call('vault.changePassword', { oldPassword: form.old.value, newPassword: form.pw.value });
                close();
                toast('主密码已修改');
              } catch (e2) {
                err.textContent = e2.message;
                err.hidden = false;
                btn.disabled = false;
              }
            });
          },
        });
      },
      lockTime: (e) => update({ autoLockMinutes: Number(e.target.value) }, '已更新自动锁定时间'),
      toggleClip: () => update({ clipboardClear: !ctx.store.settings.clipboardClear }),
      async regenKey() {
        const pw = await promptBox({ title: '重新生成恢复密钥', label: '主密码', type: 'password', ok: '重新生成', hint: '旧的恢复密钥会立即失效。' });
        if (pw === null) return;
        try {
          const r = await call('vault.regenerateRecovery', { password: pw });
          showKeyDialog(r.recoveryKey, '新的恢复密钥');
        } catch (e) {
          toastError(e);
        }
      },
      folders: (e) => (state.foldersAsGroups = e.target.checked),
      async importChrome() {
        state.busy = 'chrome';
        render();
        try {
          const r = await call('chrome.import', { foldersAsGroups: state.foldersAsGroups });
          toast(`已导入 ${r.added} 条${r.skipped ? `，跳过 ${r.skipped} 条已存在的` : ''}${r.groups ? `，${r.groups} 个分组` : ''}`);
        } catch (e) {
          toastError(e);
        }
        state.busy = '';
        load();
      },
      async importFile() {
        const file = await pickFile('.html,.htm,.json,text/html,application/json');
        if (file) await importText(file);
      },
      async importBackup() {
        const file = await pickFile('.json,application/json');
        if (file) await importBackupFile(file);
      },
      withVault: (e) => (state.withVault = e.target.checked),
      openIn: (e) => update({ openIn: e.target.value }),
      dupes: () => call('bookmarks.duplicates').then(duplicatesDialog).catch(toastError),
      async exportHtml() {
        const r = await call('export.html').catch(toastError);
        if (r) downloadText(r.filename, r.text, 'text/html');
      },
      async exportJson() {
        const r = await call('export.backup', { includeVault: state.withVault && !!state.vault?.exists }).catch(toastError);
        if (r) downloadText(r.filename, r.text, 'application/json');
      },
      shortcuts: () => chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }),
      async removeHistory() {
        if (state.busy || state.historyPermission !== true) return;
        state.busy = 'removeHistory';
        state.historyPermissionError = '';
        render();
        try {
          const removed = await chrome.permissions.remove({ permissions: ['history'] });
          if (!removed) throw new Error('关闭浏览历史权限失败，请重试。');
          if (disposed) return;
          state.historyPermission = false;
          toast('已关闭，已清空当前排行');
          ctx.refreshHomeNav?.();
        } catch (e) {
          if (disposed) return;
          state.historyPermissionError = e?.message || '关闭浏览历史权限失败，请重试。';
          toastError(e);
        } finally {
          if (!disposed) {
            state.busy = '';
            render();
          }
        }
      },
      async wipe() {
        const ok = await confirmBox({ title: '清除这台电脑上的资料？', text: '收藏、笔记、保险箱和设置都会从这台电脑删除。云端资料不受影响。建议先导出一份完整备份。', ok: '清除本机资料', danger: true });
        if (!ok) return;
        await call('data.wipeLocal').catch(toastError);
        toast('已清除本机资料');
        location.hash = '#/welcome';
      },
    });

    const syncHistoryPermission = (change, granted) => {
      const permissions = Array.isArray(change) ? change : change?.permissions;
      if (disposed || !permissions?.includes?.('history')) return;
      historyPermissionSeq++;
      state.historyPermission = granted;
      state.historyPermissionError = '';
      render();
      if (state.busy !== 'removeHistory') ctx.refreshHomeNav?.();
    };
    const onHistoryPermissionAdded = (change) => syncHistoryPermission(change, true);
    const onHistoryPermissionRemoved = (change) => syncHistoryPermission(change, false);
    if (typeof chrome !== 'undefined' && chrome.permissions) {
      chrome.permissions.onAdded?.addListener(onHistoryPermissionAdded);
      chrome.permissions.onRemoved?.addListener(onHistoryPermissionRemoved);
    }

    const unsub = ctx.subscribe(() => render());
    const off = onChange(['vault', 'bookmarks'], () => load().catch(() => {}));
    loadHistoryPermission();
    load().catch(toastError);
    draw();

    return {
      update: () => render(),
      unmount() {
        disposed = true;
        historyPermissionSeq++;
        unsub();
        off();
        unbind();
        if (typeof chrome !== 'undefined' && chrome.permissions) {
          chrome.permissions.onAdded?.removeListener(onHistoryPermissionAdded);
          chrome.permissions.onRemoved?.removeListener(onHistoryPermissionRemoved);
        }
      },
    };
  },
};
