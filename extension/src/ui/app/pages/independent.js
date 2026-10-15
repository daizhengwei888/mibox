import { html, morph, bind, scheduler } from '../../kit/dom.js';
import { icon, brandMark } from '../../kit/icons.js';
import { copyText, downloadText } from '../../kit/ui.js';
import { call } from '../../../shared/client.js';

const STORAGE = 'sqIndependentSetup';
const SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
const STEPS = [
  { title: '先建一个自己的项目', text: '用你自己的 Google 账号打开后台。项目名称填「我的谜盒」，点「创建」。后面的每一页都选这个项目。', url: 'https://console.cloud.google.com/projectcreate', button: '打开 Google，创建项目' },
  { title: '打开 Drive 同步', text: '确认顶部选的是刚建的「我的谜盒」，点「启用」。如果已经显示「管理」，就可以继续。', url: 'https://console.cloud.google.com/flows/enableapi?apiid=drive.googleapis.com', button: '打开 Drive API' },
  { title: '给登录窗口起个名字', text: '点「开始」。应用名称填「我的谜盒」，邮箱都选或填你自己的，用户类型选「外部」，按页面提示完成创建。已初始化的项目可以直接继续。', url: 'https://console.cloud.google.com/auth/overview', button: '打开登录设置' },
  { title: '允许你自己登录', text: '保持「外部 · 测试」。在「测试用户」点「添加用户」，填你登录 Chrome 的 Google 邮箱，保存。个人使用不用发布，也不用搭网站。', url: 'https://console.cloud.google.com/auth/audience', button: '打开测试用户设置' },
  { title: '勾选这三个权限', text: '点「添加或移除范围」，找到并勾选下面三项，然后更新、保存。找不到 Drive 那项时，回到「打开 Drive 同步」那一步确认已启用。', url: 'https://console.cloud.google.com/auth/scopes', button: '打开权限设置' },
  { title: '创建登录客户端', text: '点「创建客户端」，类型选「Chrome 扩展程序」，名称填「我的谜盒」。商品 ID 粘贴下面这串，点「创建」，复制得到的「客户端 ID」。', url: 'https://console.cloud.google.com/auth/clients', button: '打开客户端设置' },
];

function validClient(id) {
  return /^\d+-[a-z0-9-]+\.apps\.googleusercontent\.com$/i.test(id) && !/REPLACE_WITH/i.test(id);
}

async function writeFile(handle, text) {
  const stream = await handle.createWritable();
  try {
    await stream.write(text);
    await stream.close();
  } catch (e) {
    await stream.abort().catch(() => {});
    throw e;
  }
  if (await (await handle.getFile()).text() !== text) throw new Error('文件保存后核对失败，请保留备份并重试');
}

export default {
  title: '高级设置 · 自己的同步配置',
  mount(root, ctx) {
    const manifest = chrome.runtime.getManifest();
    const state = { step: 0, clientId: '', busy: false, err: '', google: null, loaded: false, mode: '', folder: '', configBackup: '', dataBackup: '', syncRequested: false, pendingResume: false, completedSub: '', syncedAt: 0 };
    let disposed = false;
    const render = scheduler(() => { if (!disposed) draw(); });

    async function save(extra = {}) {
      Object.assign(state, extra);
      const { step, clientId, mode, folder, configBackup, dataBackup, syncRequested, pendingResume, completedSub, syncedAt } = state;
      await chrome.storage.local.set({ [STORAGE]: { step, clientId, mode, folder, configBackup, dataBackup, syncRequested, pendingResume, completedSub, syncedAt, extensionId: chrome.runtime.id } });
      render();
    }

    async function load() {
      try {
        const [stored, google] = await Promise.all([chrome.storage.local.get(STORAGE), call('google.status')]);
        const saved = stored[STORAGE];
        if (saved?.extensionId === chrome.runtime.id && Number.isInteger(saved.step) && saved.step >= 0 && saved.step <= 9) Object.assign(state, saved);
        state.google = google;
        state.pendingResume = false;
        if (state.step >= 7) {
          if (validClient(state.clientId) && manifest.oauth2?.client_id === state.clientId) {
            if (state.step !== 9 || !google.signedIn || google.reauth || google.user?.googleSub !== state.completedSub) state.step = 8;
          } else {
            state.step = 7;
            state.syncRequested = false;
          }
        }
        state.loaded = true;
        render();
        if (state.step === 8 && state.syncRequested && google.signedIn && !google.reauth) await busy(syncNow);
      } catch (e) {
        state.loaded = true;
        state.err = e.message;
        render();
      }
    }

    function googleStep() {
      const step = STEPS[state.step];
      return html`<p class="small muted">Google 后台 · ${state.step + 1} / ${STEPS.length}</p>
        <h1>${step.title}</h1><p class="lead">${step.text}</p>
        ${state.step === 4 ? html`<div class="col" style="gap:8px">${[[SCOPE, 'Drive 应用数据'], ['openid', 'openid'], ['https://www.googleapis.com/auth/userinfo.email', '邮箱']].map(([scope, label]) => html`<div class="notice"><span class="grow" style="overflow-wrap:anywhere">${label}<br><code>${scope}</code></span><button class="btn sm" type="button" data-click="copy" data-value="${scope}">复制</button></div>`)}</div>` : ''}
        ${state.step === 5 ? html`<div class="notice"><span class="grow" style="overflow-wrap:anywhere">商品 ID<br><code>${chrome.runtime.id}</code></span><button class="btn sm" type="button" data-click="copy" data-value="${chrome.runtime.id}">复制</button></div>` : ''}
        <a class="btn pri lg" href="${step.url}" target="_blank" rel="noopener noreferrer">${step.button}</a>
        <div class="row wrap"><button class="btn lg" type="button" data-click="next" ${state.busy ? 'disabled' : ''}>做好了，下一步 ${icon('chevronRight', 16)}</button>${state.step ? html`<button class="btn ghost" type="button" data-click="back">上一步</button>` : html`<button class="link-btn" type="button" data-click="haveClient">我已有客户端 ID</button>`}</div>`;
    }

    function configure() {
      return html`<h1>粘贴一下，就快好了</h1><p class="lead">把刚得到的客户端 ID 粘贴到下面。然后选你加载「谜盒」时用的文件夹，插件会备份、保存配置并自动重新加载。</p>
        <div class="field"><label for="own-client">客户端 ID</label><input id="own-client" class="input" type="text" value="${state.clientId}" data-input="client" autocomplete="off" spellcheck="false" placeholder="123456…apps.googleusercontent.com"><span class="hint">只粘贴客户端 ID，不需要密钥或密码。</span></div>
        <div class="row wrap">${typeof window.showDirectoryPicker === 'function' ? html`<button class="btn pri lg" type="button" data-click="saveFolder" ${state.busy ? 'disabled' : ''}>${state.busy ? html`<span class="spinner"></span>正在备份和保存…` : '选择插件文件夹并继续'}</button>` : html`<button class="btn pri lg" type="button" data-click="downloadConfig" ${state.busy ? 'disabled' : ''}>下载配置并继续</button>`}</div>
        <p class="small muted">完整备份会包含加密的保险箱。此功能用于「加载已解压的扩展程序」安装方式。</p>
        <div class="row wrap"><button class="link-btn" type="button" data-click="back" ${state.busy ? 'disabled' : ''}>上一步</button>${typeof window.showDirectoryPicker === 'function' ? html`<button class="link-btn" type="button" data-click="downloadConfig" ${state.busy ? 'disabled' : ''}>选不了文件夹？下载配置</button>` : ''}</div>`;
    }

    function reloadStep() {
      return html`<h1>让配置生效</h1><p class="lead">${state.mode === 'download' ? '把下载的 manifest.json 放到当前「谜盒」插件文件夹里，替换同名文件。旧配置和资料备份也已发起下载，请保留它们。' : `配置已写入「${state.folder}」，原配置和资料备份也保存在这个文件夹里。`}</p>
        <button class="btn pri lg" type="button" data-click="reload" ${state.busy ? 'disabled' : ''}>${state.busy ? html`<span class="spinner"></span>正在重新加载…` : '已放好，重新加载并继续'}</button>
        <p class="small muted">如果重新加载后还停在这里，说明选的是另一份文件夹。到扩展管理页加载刚才修改的文件夹，再打开本向导。</p>
        <div class="row wrap"><button class="link-btn" type="button" data-click="extensions">打开扩展管理页</button><button class="link-btn" type="button" data-click="changeFolder">重新选择文件夹</button></div>`;
    }

    function loginStep() {
      const ready = state.google?.signedIn && !state.google.reauth;
      return html`<h1>最后，登录一下</h1><p class="lead">${ready ? `当前账号：${state.google.user.email}。点下面按钮，完成一次实际 Drive 同步。` : '用 Chrome 里的 Google 账号登录，允许邮箱和应用数据权限。登录后会自动完成一次 Drive 同步。'}</p>
        <div class="notice">${icon('info', 16)}<span>会把当前登录账号在这台电脑上的资料同步到你自己的 Google 项目。换账号时使用那个账号自己的资料库。</span></div>
        <button class="btn pri lg" type="button" data-click="login" ${state.busy ? 'disabled' : ''}>${state.busy ? html`<span class="spinner"></span>正在完成…` : ready ? '完成同步' : '登录并完成同步'}</button>
        <details class="small muted"><summary>登录失败怎么办？</summary><p>检查 Google 后台是否选对项目、Drive API 是否启用、Chrome 账号是否已添加为测试用户、客户端类型是否为「Chrome 扩展程序」。测试授权到期时重新登录即可。</p><button class="link-btn" type="button" data-click="reviewGoogle">再看 Google 设置步骤</button></details>`;
    }

    function doneStep() {
      return html`<h1>配置好了</h1><div class="notice ok">${icon('check', 16)}<span>已登录 ${state.google?.user?.email || 'Google'}，并完成一次 Drive 同步。</span></div>
        <p class="lead">现在使用你提供的客户端。请在 Google 后台确认项目由你管理；插件不能读取项目所有者。其他电脑用同一份配置、登录同一账号即可同步。</p>
        <a class="btn pri lg" href="${ctx.store.settings.onboarded ? '#/bookmarks' : '#/welcome'}">继续使用</a>
        <p class="small muted">同步完成于 ${new Date(state.syncedAt).toLocaleString()}。保留配置和资料备份；个人测试授权到期时，按提示重新登录。</p>`;
    }

    function draw() {
      const group = state.step < 6 ? 0 : state.step < 8 ? 1 : 2;
      const body = !state.loaded ? html`<span class="spinner"></span>正在准备…` : state.step < 6 ? googleStep() : state.step === 6 ? configure() : state.step === 7 ? reloadStep() : state.step === 8 ? loginStep() : doneStep();
      morph(root, html`<div class="welcome"><aside class="welcome-side"><div class="brand">${brandMark(48)}<b>自己的同步空间</b><p>第一次跟着做，以后直接登录。</p></div><ol class="welcome-steps">${['Google 后台', '粘贴配置', '登录完成'].map((label, i) => html`<li class="${i < group ? 'done' : i === group ? 'cur' : ''}" ${i === group ? html`aria-current="step"` : ''}><span class="n">${i < group ? icon('check', 14) : i + 1}</span><span>${label}</span></li>`)}</ol></aside>
        <div class="welcome-main"><div class="row" style="justify-content:flex-end;margin:-40px 0 8px"><a class="link-btn" href="#/settings/advanced">返回高级设置</a></div>${body}${state.err ? html`<p class="error-text" role="alert">${state.err}</p>` : ''}</div></div>`);
    }

    function clientId() {
      const id = state.clientId.trim();
      if (!validClient(id)) throw new Error('请粘贴完整的客户端 ID，结尾应为 .apps.googleusercontent.com');
      if (id === manifest.oauth2?.client_id && state.step === 6) throw new Error('这个客户端已经在使用。要独立于作者，请粘贴你自己项目中新建的客户端 ID');
      return id;
    }

    async function busy(fn) {
      if (state.busy) return;
      state.busy = true;
      state.err = '';
      render();
      try { await fn(); }
      catch (e) { if (e.name !== 'AbortError') state.err = e.message; }
      finally { state.busy = false; render(); }
    }

    async function reload() {
      await call('google.prepareClientChange', { clientId: state.clientId });
      await save({ pendingResume: true });
      chrome.runtime.reload();
    }

    async function syncNow() {
      await save({ syncRequested: false });
      const google = await call('google.status');
      if (!google.signedIn || google.reauth || manifest.oauth2?.client_id !== state.clientId) throw new Error('请重新登录后再完成同步');
      const synced = await call('sync.now');
      state.google = { ...google, user: synced.user };
      await save({ step: 9, completedSub: synced.user.googleSub, syncedAt: Date.now(), pendingResume: false });
    }

    const unbind = bind(root, {
      next: () => busy(() => save({ step: Math.min(6, state.step + 1) })),
      back: () => busy(() => save({ step: Math.max(0, state.step - 1) })),
      haveClient: () => busy(() => save({ step: 6 })),
      client(e) { state.clientId = e.target.value; },
      copy: (e, el) => busy(() => copyText(el.dataset.value)),
      extensions: () => chrome.tabs.create({ url: 'chrome://extensions' }),
      changeFolder: () => busy(() => save({ step: 6 })),
      reviewGoogle: () => busy(() => save({ step: 0 })),
      reload: () => busy(reload),
      saveFolder: () => busy(async () => {
        const id = clientId();
        // 选择文件夹必须在等待后台之前发起，否则浏览器认为不是用户点击触发的。
        const directory = await window.showDirectoryPicker({ id: 'shuqian-independent', mode: 'readwrite' });
        const handle = await directory.getFileHandle('manifest.json');
        const oldText = await (await handle.getFile()).text();
        let selected;
        try { selected = JSON.parse(oldText); } catch { throw new Error('所选文件夹的 manifest.json 不是有效配置'); }
        if (!manifest.key || selected.key?.replace(/\s/g, '') !== manifest.key.replace(/\s/g, '') || selected.version !== manifest.version || selected.manifest_version !== 3 || !selected.oauth2) throw new Error('请选当前这个版本的「谜盒」插件文件夹，不要选上层目录或其他插件');
        const backup = await call('export.backup', { includeVault: true });
        if (disposed) throw new Error('页面已切换，请重新打开向导');
        const tag = new Date().toISOString().replace(/[:.]/g, '-') + '-' + crypto.randomUUID().slice(0, 8);
        const configBackup = `manifest.before-independent-${tag}.json`;
        const dataBackup = `谜盒备份-${tag}.json`;
        await writeFile(await directory.getFileHandle(configBackup, { create: true }), oldText);
        await writeFile(await directory.getFileHandle(dataBackup, { create: true }), backup.text);
        if (disposed) throw new Error('页面已切换，备份已保留，请重新打开向导');
        selected.oauth2.client_id = id;
        try { await writeFile(handle, JSON.stringify(selected, null, 2) + '\n'); }
        catch (e) {
          try { await writeFile(handle, oldText); }
          catch { throw new Error(`保存失败且未能恢复原配置，请使用 ${configBackup} 恢复 manifest.json`); }
          throw e;
        }
        await save({ clientId: id, step: 7, mode: 'folder', folder: directory.name, configBackup, dataBackup, syncRequested: false });
        await reload();
      }),
      downloadConfig: () => busy(async () => {
        const id = clientId();
        const backup = await call('export.backup', { includeVault: true });
        const tag = new Date().toISOString().replace(/[:.]/g, '-');
        const configBackup = `manifest.before-independent-${tag}.json`;
        downloadText(configBackup, JSON.stringify(manifest, null, 2), 'application/json');
        downloadText(backup.filename, backup.text, 'application/json');
        const next = structuredClone(manifest);
        next.oauth2.client_id = id;
        downloadText('manifest.json', JSON.stringify(next, null, 2) + '\n', 'application/json');
        await save({ clientId: id, step: 7, mode: 'download', folder: '', configBackup, dataBackup: backup.filename, syncRequested: false });
      }),
      login: () => busy(async () => {
        if (state.google?.signedIn && !state.google.reauth) return syncNow();
        await save({ syncRequested: true });
        try {
          await call('google.signIn');
          // 切换资料库会重新加载插件页面；记下的请求会在之后接着同步一次。
          location.reload();
        } catch (e) {
          await save({ syncRequested: false });
          throw e;
        }
      }),
    });
    draw();
    load();
    return { unmount() { disposed = true; unbind(); } };
  },
};
