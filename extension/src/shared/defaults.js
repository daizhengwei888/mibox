// 设置的默认值。新增设置时只在这里加一项，读取时会自动补齐。

export const DEFAULT_SETTINGS = {
  theme: 'system', // system | light | dark
  view: 'card', // card | list | compact
  sort: 'recent', // recent | name | group | opened
  openIn: 'new', // new | current
  favicons: true,
  autoLockMinutes: 15, // 0 = 关闭浏览器时
  clipboardClear: true,
  tools: {
    checkin: true,
    clip: true,
    autoCollect: false,
  },
  checkin: {
    time: '08:00', // 'HH:MM' 或 '' 表示不自动运行
    concurrency: 3, // 一次同时签几个网站（1–5）
    ai: true, // 找不到签到入口时交给 AI（需要先在保险箱里设置 AI 接口）
  },
  ai: {
    entryId: null, // 保险箱里存 AI 接口的那一条
  },
  sync: {
    auto: true,
    bookmarks: true,
    notes: true,
    vault: true,
    tools: true,
  },
  onboarded: false,
};

export function mergeSettings(saved) {
  const out = structuredClone(DEFAULT_SETTINGS);
  if (!saved || typeof saved !== 'object') return out;
  for (const [key, value] of Object.entries(saved)) {
    if (!(key in out)) continue;
    if (out[key] && typeof out[key] === 'object' && !Array.isArray(out[key]) && value && typeof value === 'object') {
      out[key] = { ...out[key], ...value };
    } else {
      out[key] = value;
    }
  }
  return out;
}

// 后台和界面各读一份。Chrome 更新已解压的插件后可能继续运行旧后台，两边不一致时完整页会提示重新启用插件。
// 只在后台代码有改动时改成当时的 manifest.json version；只改界面时保持不变，免得无谓地提示重新启用。
export const BUILD = '3.0.0';

export const SYNC_FILE_NAME = 'shuqian-sync-v3.json.gz';
export const SNAPSHOT_FILE_NAME = 'shuqian-sync-v4-snapshot.json.gz';

export const LIMITS = {
  title: 256,
  url: 4096,
  note: 2000, // 收藏备注
  noteBody: 65536, // 笔记正文（字节）
  groupName: 40,
  vaultName: 128,
  vaultSecret: 8192,
};
