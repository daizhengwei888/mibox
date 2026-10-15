import { UserError } from './errors.js';
import { blake3 } from '../shared/blake3.js';

function root(target) {
  if (!/^[a-fA-F0-9]{32}$/.test(target?.accountId || '') || !/^[a-z0-9](?:[a-z0-9-]{0,56}[a-z0-9])?$/.test(target?.project || '')) throw new UserError('Cloudflare 发布目标无效');
  return `/accounts/${target.accountId}/pages/projects/${encodeURIComponent(target.project)}`;
}

export async function removeCloudflare(target, api) {
  const path = root(target);
  const current = await api(path, { allow404: true });
  if (!current) return { removed: true, alreadyAbsent: true };
  await api(path, { method: 'DELETE', allow404: true });
  const remaining = await api(path, { allow404: true });
  if (remaining) throw new UserError('Cloudflare Pages 项目仍然存在，未能完成删除');
  return { removed: true, alreadyAbsent: false };
}

function urlFor(project) {
  const name = project?.subdomain;
  if (typeof name !== 'string' || !/^[a-z0-9.-]+\.pages\.dev$/i.test(name)) return '';
  return 'https://' + name;
}

export function assetHash(file) {
  const name = file.path.split('/').pop();
  const dot = name.lastIndexOf('.');
  const extension = dot > 0 ? name.slice(dot + 1) : '';
  // 与 Cloudflare deploy-helpers 的 hashFile 输入约定一致。
  return [...blake3(new TextEncoder().encode(file.base64 + extension))].map((v) => v.toString(16).padStart(2, '0')).join('').slice(0, 32);
}

export async function inspectCloudflare(target, api) {
  const project = await api(root(target), { allow404: true });
  if (target.createProject === true && project) throw new UserError('同名 Pages 项目已经存在，请选择已有网站或换一个名称', 'PROJECT_EXISTS');
  if (project?.source) throw new UserError('这个项目已关联 Git 仓库，请为直接上传选择或创建独立 Pages 项目');
  return { ...target, branch: project?.production_branch || 'main', willCreate: !project, currentDeployment: project?.latest_deployment?.id || null, predictedUrl: urlFor(project) || `https://${target.project}.pages.dev` };
}

function deploymentState(deployment) {
  const stages = deployment.stages || [];
  const latest = deployment.latest_stage;
  if (['failure', 'failed', 'canceled', 'cancelled'].includes(latest?.status) || stages.some((s) => ['failure', 'failed', 'canceled', 'cancelled'].includes(s.status))) return 'failed';
  return latest?.name === 'deploy' && latest.status === 'success' || stages.some((s) => s.name === 'deploy' && s.status === 'success') ? 'live' : 'queued';
}

export async function deployCloudflare(plan, files, api, progress = async () => {}) {
  const base = root(plan);
  const checked = await inspectCloudflare({ ...plan, createProject: false }, api);
  if (checked.willCreate !== plan.willCreate || checked.branch !== plan.branch || checked.currentDeployment !== plan.currentDeployment) throw new UserError('Cloudflare 项目自检查后发生变化，请重新检查目标', 'PLAN_CHANGED');
  let project;
  if (plan.willCreate) {
    await progress({ message: '创建 Pages 项目', completed: 0, total: files.length });
    project = await api(`/accounts/${plan.accountId}/pages/projects`, { method: 'POST', body: { name: plan.project, production_branch: plan.branch } });
  } else project = await api(base);
  const projectUrl = urlFor(project);
  if (!projectUrl) throw new UserError('Cloudflare 没有返回有效的网站地址');
  let jwt;
  const refreshJwt = async () => {
    jwt = (await api(base + '/upload-token'))?.jwt;
    if (typeof jwt !== 'string' || !jwt || /\s/.test(jwt)) throw new UserError('Cloudflare 未返回有效上传凭证');
  };
  await refreshJwt();
  const assetsApi = async (path, body) => {
    try { return await api(path, { method: 'POST', body, jwt }); }
    catch (error) {
      if (error.status !== 401) throw error;
      await refreshJwt();
      return api(path, { method: 'POST', body, jwt });
    }
  };
  const assets = new Map();
  const manifest = {};
  for (const file of files) {
    if (['_headers', '_redirects'].includes(file.path)) continue;
    const hash = assetHash(file);
    assets.set(hash, file);
    manifest['/' + file.path] = hash;
  }
  const hashes = [...assets.keys()];
  const missing = await assetsApi('/pages/assets/check-missing', { hashes });
  if (!Array.isArray(missing) || missing.some((hash) => !assets.has(hash))) throw new UserError('Cloudflare 返回的文件检查结果无效');
  let completed = assets.size - missing.length;
  let batch = [], bytes = 0;
  const flush = async () => {
    if (!batch.length) return;
    await assetsApi('/pages/assets/upload', batch);
    completed += batch.length;
    await progress({ message: '上传网页资源', completed, total: assets.size });
    batch = []; bytes = 0;
  };
  for (const hash of missing) {
    const file = assets.get(hash);
    if (batch.length && (bytes + file.base64.length > 8 * 1024 * 1024 || batch.length >= 25)) await flush();
    batch.push({ key: hash, value: file.base64, metadata: { contentType: file.type }, base64: true });
    bytes += file.base64.length;
  }
  await flush();
  await assetsApi('/pages/assets/upsert-hashes', { hashes });
  const form = new FormData();
  form.set('manifest', JSON.stringify(manifest));
  form.set('branch', project.production_branch || plan.branch);
  form.set('commit_message', 'Publish with Mibox');
  for (const file of files.filter((f) => ['_headers', '_redirects'].includes(f.path))) {
    const bytes = Uint8Array.from(atob(file.base64), (c) => c.charCodeAt(0));
    form.set(file.path, new Blob([bytes], { type: 'text/plain' }), file.path);
  }
  await progress({ message: '提交 Pages 部署', completed: files.length, total: files.length });
  const deployed = await api(base + '/deployments', { method: 'POST', body: form });
  if (typeof deployed?.id !== 'string' || !/^[a-f0-9-]{16,64}$/i.test(deployed.id)) throw new UserError('Cloudflare 未返回可跟踪的部署编号，请在控制台检查发布结果');
  const state = deploymentState(deployed);
  if (state === 'failed') throw new UserError('Cloudflare 构建失败，请在 Pages 控制台查看详情');
  return { provider: 'cloudflare', accountId: plan.accountId, project: plan.project, deploymentId: deployed.id, url: projectUrl, status: state, message: state === 'live' ? 'Cloudflare Pages 已上线' : '已提交，等待 Cloudflare 构建' };
}

export async function checkCloudflare(job, api) {
  if (job.provider !== 'cloudflare' || !/^[a-f0-9-]{16,64}$/i.test(job.deploymentId || '')) throw new UserError('Cloudflare 部署记录无效');
  const deployment = await api(root(job) + '/deployments/' + encodeURIComponent(job.deploymentId));
  const state = deploymentState(deployment);
  return { ...job, status: state, message: state === 'live' ? 'Cloudflare Pages 已上线' : state === 'failed' ? 'Cloudflare 构建失败，请在控制台查看详情' : 'Cloudflare Pages 正在构建' };
}
