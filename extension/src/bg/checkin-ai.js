// 签到助手的 AI 兜底：用户自己的 OpenAI 兼容接口，一步一步决定点哪个元素。
// 只把「带编号的可点元素」和与签到有关的短提示发给 AI（格式参考 alibaba/page-agent），不发输入框内容、账号和密码。

import * as vault from './vault.js';
import { getSettings } from './settings.js';
import { isWebUrl, originOf } from '../shared/util.js';

/** 读出 AI 接口配置；不可用时返回 { error }。 */
export async function aiConfig() {
  const s = await getSettings();
  if (!s.ai?.entryId) return { error: '没有设置 AI 接口' };
  if (s.checkin?.ai === false) return { error: 'AI 兜底已关闭' };
  if (!(await vault.isUnlocked())) return { error: '保险箱锁着，用不了 AI 接口' };
  let entry;
  try {
    entry = await vault.secretFor(s.ai.entryId);
  } catch (e) {
    return { error: e.message };
  }
  const base = (entry.secret.ai?.baseUrl || '').replace(/\/+$/, '');
  const model = entry.secret.ai?.model || '';
  const key = entry.secret.secret || '';
  if (!isWebUrl(base) || !model || !key) return { error: 'AI 接口信息不完整' };
  if (!(await chrome.permissions.contains({ origins: [originOf(base) + '/*'] }))) return { error: '没有访问 AI 接口地址的权限' };
  return { base, model, key };
}

const SYSTEM = `你是浏览器里的签到助手。目标：在当前网站完成今天的签到，或领取每日登录奖励。
你每次只能做一件事：从「可点元素」里选一个编号点击，或者结束。
规则：
- 只输出一个 JSON 对象，不要任何解释或 Markdown。
- 点击：{"action":"click","index":编号,"why":"不超过20字"}
- 已经完成：{"action":"done","result":"ok"} ；页面显示今天已经签过：{"action":"done","result":"already"}
- 需要登录：{"action":"login"} ；确实做不到：{"action":"fail","why":"原因"}
- 不要点退出、注销、注册、删除、付款、购买、充值、发帖、回复、修改设置之类的元素。
- 签到入口可能是「签到」「打卡」「领取奖励」「每日任务」这类按钮或链接，也可能需要先打开菜单或进入签到页。
- 如果上一步点完页面没有变化，换一个元素，不要重复点同一个。`;

/** 让 AI 决定下一步。page 来自 dehydrateInPage；history 是已经做过的步骤文字。 */
export async function aiDecide(cfg, { task, page, history, timeoutMs = 25000 }) {
  const user = [
    `任务：${task.name}`,
    `当前网址：${page.url}`,
    `页面标题：${page.title}`,
    history.length ? `已经做过：\n${history.map((h, i) => `${i + 1}. ${h}`).join('\n')}` : '还没有做任何操作。',
    page.hints?.length ? `页面上和签到有关的文字：\n${page.hints.join('\n')}` : '页面上没有找到和签到有关的文字。',
    `可点元素：\n${page.elements || '（没有）'}`,
  ].join('\n\n');
  let res;
  try {
    res = await fetch(cfg.base + '/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.key}` },
      body: JSON.stringify({
        model: cfg.model,
        temperature: 0,
        max_tokens: 200,
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: user },
        ],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return { action: 'error', why: '连不上 AI 接口' };
  }
  if (!res.ok) return { action: 'error', why: 'AI 接口返回错误 ' + res.status };
  const data = await res.json().catch(() => null);
  return parseDecision(String(data?.choices?.[0]?.message?.content ?? ''));
}

/** 宽松地从回答里取出第一个 JSON 对象；只认识几种动作。 */
export function parseDecision(text) {
  const m = text.match(/\{[\s\S]*?\}/);
  let obj = null;
  if (m) {
    try {
      obj = JSON.parse(m[0]);
    } catch {
      obj = null;
    }
  }
  if (!obj) {
    const n = text.match(/-?\d+/);
    if (n && Number(n[0]) >= 0) return { action: 'click', index: Number(n[0]), why: '' };
    return { action: 'fail', why: 'AI 的回答看不懂' };
  }
  const action = String(obj.action || '').toLowerCase();
  const why = String(obj.why || obj.reason || '').slice(0, 60);
  if (action === 'click' && Number.isInteger(Number(obj.index)) && Number(obj.index) >= 0) return { action: 'click', index: Number(obj.index), why };
  if (action === 'done') return { action: 'done', result: obj.result === 'already' ? 'already' : 'ok', why };
  if (action === 'login') return { action: 'login', why };
  return { action: 'fail', why: why || 'AI 没有找到签到入口' };
}
