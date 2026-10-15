# 网页发布：GitHub Pages / Cloudflare Pages

入口：「工具 › 网页发布」。把一个 HTML 文件或已经构建好的网站文件夹发布成公开网页。

- HTML 单文件会自动命名为 `index.html`；文件夹保留里面的相对路径，根目录必须有 `index.html`。
- 限制：最多 200 个文件，单个文件 5 MiB，合计 20 MiB。不执行构建命令，不支持服务端代码或 Pages Functions。
- 会排除明显的开发和私密目录（如 `.git`、`node_modules`、`.env`），后台还会再校验路径、类型、大小和入口文件。

## 发布步骤

1. 先创建或解锁保险箱。在网页发布页点「连接 GitHub / Cloudflare」，按提示允许访问对应官网和 API。
2. 在打开的官网登录、确认令牌的权限和范围，点生成。谜盒的连接助手认出本次打开的页面上的令牌，向平台验证后加密存进保险箱，自动回到发布页。GitHub 的权限和 90 天有效期已经预填；Cloudflare 按助手提示创建自定义令牌。登录、验证码和生成令牌这些动作仍由你自己完成。
3. 填「网页名称」（可以是中文），拖入 HTML 文件或网站文件夹。网址名称自动生成，可以在「网址和高级选项」里改，或选择更新已有网站。
4. 点「创建网页」先检查目标和文件清单；核对后点「确认公开发布」才会真的创建仓库 / 项目并上传。
5. 页面显示上传和构建进度；平台报告构建成功后才显示上线网址，旁边可以一键复制。

「已创建网页」列表保留名称、平台、状态和网址，属于当前这台电脑的资料库，不参与 Google 同步。

## 两个平台的要求

**GitHub Pages**：fine-grained PAT，授予 Contents、Pages、Administration 的读写权限。只更新已有网站时可以限定目标仓库；要在工具里新建网站，令牌需要覆盖新仓库（官网里选 All repositories）。自动新建只支持当前个人账号的公开仓库。谜盒写入专用的 `mibox-pages` 分支，保留 Git 历史、不强制推送；同名分支没有谜盒标记时拒绝覆盖；已有 Pages 来自其他分支或 Actions 时会单独请你确认切换。项目站点的资源请用相对路径。

**Cloudflare Pages**：自定义令牌，授予目标账号的 Account → Cloudflare Pages → Edit 和 Account → Account Settings → Read（后者用来读取账号列表；没有时可以在高级选项里填 Account ID）。新建网站会创建 Direct Upload 项目，遇到同名项目拒绝，不会覆盖；暂不接管已关联 Git 的项目。上传使用官方 Pages assets / deployments 接口和与 Wrangler 一致的 BLAKE3 文件指纹。不改动自定义域名和 DNS。

自动识别令牌失败时（官网改版），可以选「手动粘贴令牌」；也可以在「其他连接方式」里用保险箱里已有的令牌。

## 删除

点网页旁的「删除」先验证主密码（即使保险箱已经解锁），之后 24 小时内两个平台的删除不再重复输入密码，每次仍会确认具体网页。GitHub 只下架 Pages 网站、保留仓库和源文件；Cloudflare 删除对应的 Pages 项目和部署。

## 安全

- 连接助手只注入本次连接打开的官方令牌页面，绑定标签页、随机验证标识、当前资料库和 15 分钟有效期；只识别页面上可见的令牌输出，不读取密码、Cookie 或浏览器登录资料；有多个候选令牌时不会自动提交。
- 令牌只在后台解密，只发往对应平台的 API，不回到页面、不写进发布记录。
- 配置好之后，创建、上传和检查构建使用本机的发布专用授权（不可导出的 AES-GCM 密钥，绑定资料库、平台、令牌条目和密文版本），保险箱锁着时也能发布；这一步不会打开或延长整个保险箱。
- 待发布的文件暂存在独立的本机发布数据库，不参与同步；提交成功后删除文件内容，过期草稿（30 分钟）在下次访问时清理。

参考：[GitHub 令牌](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens)、[GitHub Pages API](https://docs.github.com/en/rest/pages/pages)、[Cloudflare 创建 API 令牌](https://developers.cloudflare.com/fundamentals/api/get-started/create-token/)、[Cloudflare Direct Upload](https://developers.cloudflare.com/pages/get-started/direct-upload/)。
