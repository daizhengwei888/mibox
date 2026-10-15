// 离屏页面：只做一件事，把剪贴板清空（复制密码 30 秒后）。
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.sqOffscreen !== 'clear-clipboard') return;
  // 只认扩展自己的页面，网页里的脚本不能直接指挥离屏页。
  if (sender?.id !== chrome.runtime.id || sender.tab) return;
  const buf = document.getElementById('buf');
  buf.value = ' ';
  buf.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {}
  sendResponse({ ok });
});
