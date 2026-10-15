import { UserError } from './errors.js';

const BRANCH = 'mibox-pages';
const MARKER = '.mibox-publish.json';

function fail(message) {
  throw new UserError(message, 'GITHUB_PUBLISH');
}

function repoParts(target) {
  const value = target?.repo;
  if (typeof value !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(value)) {
    fail('GitHub 仓库格式无效。');
  }
  return value.split('/').map(encodeURIComponent);
}

function base(target) {
  return `/repos/${repoParts(target).join('/')}`;
}

function branchRefPath(branch = BRANCH) {
  return `/git/ref/heads/${encodeURIComponent(branch)}`;
}

function defaultUrl(repo, cname) {
  if (cname) return `https://${cname}`;
  const [owner, name] = repo.split('/');
  if (name.toLowerCase() === `${owner}.github.io`.toLowerCase()) return `https://${owner}.github.io/`;
  return `https://${owner}.github.io/${name}/`;
}

async function get(api, path, allow404 = false) {
  return api(path, { allow404 });
}

async function pagesInfo(api, root) {
  const p = await get(api, `${root}/pages`, true);
  if (!p) return { exists: false, config: null };
  return {
    exists: true,
    config: {
      source: p.source ? { branch: p.source.branch, path: p.source.path } : null,
      build_type: p.build_type ?? null,
      cname: p.cname ?? null
    }
  };
}

async function markerAt(api, root, branch) {
  const item = await get(api, `${root}/contents/${encodeURIComponent(MARKER)}?ref=${encodeURIComponent(branch)}`, true);
  if (!item) return false;
  try {
    const decoded = atob(String(item.content || '').replace(/\s/g, ''));
    const marker = JSON.parse(decodeURIComponent(escape(decoded)));
    return marker?.format === 'mibox-pages/1';
  } catch {
    return false;
  }
}

export async function inspectGitHub(target, api) {
  const root = base(target);
  const repoResponse = await get(api, root, target.createRepo === true);
  if (target.createRepo === true) {
    if (repoResponse) fail('同名仓库已经存在，请选择已有网站或换一个名称。');
    const user = await get(api, '/user');
    if (typeof user?.login !== 'string' || user.login.toLowerCase() !== target.repo.split('/')[0].toLowerCase()) fail('新网站只能创建到当前连接的个人 GitHub 账号。');
    return { repo: target.repo, branch: BRANCH, parentSha: null, branchSha: null, pagesExists: false, pagesConfig: null, needsSourceChange: false, willCreate: true, willCreateRepo: true, predictedUrl: defaultUrl(target.repo) };
  }
  if (!repoResponse) fail('找不到该 GitHub 仓库。');
  if (repoResponse.private) fail('GitHub Pages 发布目前只支持公共仓库。');
  const defaultBranch = repoResponse.default_branch;
  if (!defaultBranch) fail('仓库尚未初始化，请先添加 README 后再发布。');

  const defaultRef = await get(api, `${root}/git/ref/heads/${encodeURIComponent(defaultBranch)}`, true);
  if (!defaultRef?.object?.sha) fail('仓库尚未初始化，请先添加 README 后再发布。');
  const branchRef = await get(api, `${root}${branchRefPath()}`, true);
  const branchSha = branchRef?.object?.sha || null;
  const pages = await pagesInfo(api, root);
  if (branchSha && !(await markerAt(api, root, BRANCH))) {
    fail('专用发布分支已存在但缺少有效标记，拒绝覆盖。');
  }
  const sourceBranch = pages.config?.source?.branch || null;
  const needsSourceChange = pages.exists && (sourceBranch !== BRANCH || pages.config?.source?.path !== '/' || pages.config?.build_type === 'workflow');
  const repo = target.repo;
  return {
    repo,
    branch: BRANCH,
    parentSha: branchSha || defaultRef.object.sha,
    branchSha,
    pagesExists: pages.exists,
    pagesConfig: pages.config,
    needsSourceChange,
    predictedUrl: defaultUrl(repo, pages.config?.cname)
  };
}

function sameConfig(a, b) {
  return JSON.stringify(a || null) === JSON.stringify(b || null);
}

function b64Utf8(value) {
  return btoa(unescape(encodeURIComponent(value)));
}

export async function deployGitHub(plan, files, api, progress = async () => {}) {
  if (!plan || !Array.isArray(files)) fail('GitHub 发布计划无效。');
  const target = { repo: plan.repo };
  const root = base(target);
  const report = async (message, completed, total) => progress({ message, completed, total });
  if (plan.willCreateRepo) {
    await inspectGitHub({ repo: plan.repo, createRepo: true }, api);
    await report('创建公开网站仓库并初始化', 0, files.length);
    const name = plan.repo.split('/')[1];
    await api('/user/repos', { method: 'POST', body: { name, private: false, auto_init: true, description: 'Static site published with Mibox' } });
    let prepared;
    for (let attempt = 0; attempt < 4; attempt++) {
      try { prepared = await inspectGitHub(target, api); break; }
      catch (error) {
        if (attempt === 3) throw error;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
    plan = { ...prepared, confirmSourceChange: plan.confirmSourceChange };
  }
  const repoInfo = await get(api, root);
  if (!repoInfo || repoInfo.private || !repoInfo.default_branch) fail('仓库不可用或尚未初始化，请先确认公共仓库并添加 README。');
  const defaultRef = await get(api, `${root}/git/ref/heads/${encodeURIComponent(repoInfo.default_branch)}`, true);
  const currentTarget = await get(api, `${root}${branchRefPath()}`, true);
  const pages = await pagesInfo(api, root);
  const currentSha = currentTarget?.object?.sha || null;
  if ((currentSha || null) !== (plan.branchSha || null) || (!currentSha && defaultRef?.object?.sha !== plan.parentSha)) {
    fail('自检查以来 GitHub 分支已变化，请重新检查目标后重试。');
  }
  if (!sameConfig(pages.config, plan.pagesConfig) || pages.exists !== plan.pagesExists) {
    fail('自检查以来 GitHub Pages 配置已变化，请重新检查目标后重试。');
  }
  if (currentSha && !(await markerAt(api, root, BRANCH))) fail('专用发布分支标记已变化，拒绝覆盖。');
  const existingSource = pages.config?.source;
  const sourceNeedsChange = !pages.exists || existingSource?.branch !== BRANCH || existingSource?.path !== '/' || pages.config?.build_type === 'workflow';
  if (sourceNeedsChange && pages.exists && !plan.confirmSourceChange) {
    fail('当前 Pages 来源不是专用发布分支；确认切换来源后才能继续。');
  }
  if (!defaultRef?.object?.sha) fail('仓库尚未初始化，请先添加 README 后再发布。');

  const normalized = new Map();
  for (const file of files) {
    if (!file || typeof file.path !== 'string' || !file.path || file.path.startsWith('/') || file.path.split('/').includes('..') || typeof file.base64 !== 'string') {
      fail('发布文件列表包含无效路径或内容。');
    }
    if (file.path === MARKER || file.path === '.nojekyll') continue;
    normalized.set(file.path, file);
  }
  normalized.set('.nojekyll', { base64: '', size: 0, type: 'application/octet-stream' });
  if (pages.config?.cname) {
    if (!/^[a-zA-Z0-9.-]+$/.test(pages.config.cname)) fail('GitHub 返回的自定义域名无效，请先在平台检查。');
    normalized.set('CNAME', { base64: b64Utf8(pages.config.cname + '\n'), type: 'text/plain' });
  }
  normalized.set(MARKER, { base64: b64Utf8(JSON.stringify({ format: 'mibox-pages/1' })), size: 23, type: 'application/json' });
  const entries = [];
  let index = 0;
  for (const [path, file] of normalized) {
    await report(`上传文件 ${path}`, index, normalized.size);
    const blob = await api(`${root}/git/blobs`, { method: 'POST', body: { content: file.base64, encoding: 'base64' } });
    if (!blob?.sha) fail(`GitHub 未返回文件 ${path} 的对象编号。`);
    entries.push({ path, mode: '100644', type: 'blob', sha: blob.sha });
    index += 1;
  }
  await report('创建发布目录树', index, normalized.size);
  const tree = await api(`${root}/git/trees`, { method: 'POST', body: { tree: entries } });
  if (!tree?.sha) fail('GitHub 未能创建发布目录树。');
  const commit = await api(`${root}/git/commits`, {
    method: 'POST',
    body: { message: 'Publish with Mibox', tree: tree.sha, parents: [currentSha || defaultRef.object.sha] }
  });
  if (!commit?.sha) fail('GitHub 未能创建发布提交。');

  await report('更新专用发布分支', normalized.size, normalized.size);
  try {
    if (currentSha) {
      await api(`${root}/git/refs/heads/${encodeURIComponent(BRANCH)}`, { method: 'PATCH', body: { sha: commit.sha, force: false } });
    } else {
      await api(`${root}/git/refs`, { method: 'POST', body: { ref: `refs/heads/${BRANCH}`, sha: commit.sha } });
    }
  } catch {
    fail('GitHub 分支更新发生冲突，未强制覆盖；请重新检查目标后重试。');
  }

  const source = { branch: BRANCH, path: '/' };
  if (!pages.exists) {
    await api(`${root}/pages`, { method: 'POST', body: { source, build_type: 'legacy' } });
  } else if (sourceNeedsChange) {
    const body = { source, build_type: 'legacy' };
    if (pages.config?.cname) body.cname = pages.config.cname;
    await api(`${root}/pages`, { method: 'PUT', body });
  }
  try { await api(`${root}/pages/builds`, { method: 'POST' }); }
  catch (error) { if (error.status !== 409) throw error; }
  await report('已提交，等待 GitHub 构建', normalized.size, normalized.size);
  return {
    provider: 'github',
    repo: plan.repo,
    branch: BRANCH,
    commitSha: commit.sha,
    url: defaultUrl(plan.repo, pages.config?.cname),
    status: 'queued',
    message: '已提交，等待GitHub构建'
  };
}

export async function checkGitHub(job, api) {
  if (job?.provider !== 'github' || !job.repo || !job.commitSha) fail('GitHub 发布任务信息无效。');
  const root = base({ repo: job.repo });
  const latest = await get(api, `${root}/pages/builds/latest`, true);
  if (!latest || latest.commit !== job.commitSha) {
    return { ...job, status: 'queued', message: '等待此提交的 GitHub Pages 构建' };
  }
  if (latest.status === 'built') return { ...job, status: 'live', message: 'GitHub Pages 构建完成', url: job.url };
  if (latest.status === 'errored') return { ...job, status: 'failed', message: 'GitHub Pages 构建失败，请在仓库 Pages / Actions 页面查看详情' };
  return { ...job, status: 'queued', message: 'GitHub Pages 正在构建' };
}

export async function removeGitHub(target, api) {
  const root = base(target);
  const current = await get(api, `${root}/pages`, true);
  if (!current) return { removed: true, alreadyAbsent: true };
  await api(`${root}/pages`, { method: 'DELETE', allow404: true });
  const remaining = await get(api, `${root}/pages`, true);
  if (remaining) fail('GitHub Pages 仍然存在，未能完成下架。');
  return { removed: true, alreadyAbsent: false };
}
