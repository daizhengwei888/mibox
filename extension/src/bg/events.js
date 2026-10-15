// 后台广播：数据变了就通知所有打开的界面，并告诉同步模块有新改动。

const localChangeListeners = new Set();

/** 有本机改动需要同步时调用的回调（同步模块注册）。 */
export function onLocalChange(fn) {
  localChangeListeners.add(fn);
  return () => localChangeListeners.delete(fn);
}

function broadcast(message) {
  try {
    chrome.runtime.sendMessage(message).catch(() => {});
  } catch {}
}

/**
 * topics: 'bookmarks' | 'groups' | 'notes' | 'vault' | 'tasks' | 'settings' | 'sync' | 'google'
 * opts.local=true 表示用户在这台电脑上改的，需要上传。
 */
export function emit(topics, detail = {}, opts = {}) {
  const list = Array.isArray(topics) ? topics : [topics];
  broadcast({ sqEvent: 'changed', topics: list, detail });
  if (opts.local) {
    for (const fn of localChangeListeners) {
      try {
        fn(list);
      } catch {}
    }
  }
}

export function notice(kind, detail = {}) {
  broadcast({ sqEvent: 'notice', kind, detail });
}
