# Google 同步配置

谜盒用 Chrome 自带的 Google 登录（`chrome.identity`）读写你自己 Google Drive 的**应用私有空间**（`drive.appdata`）。不经过任何中间服务器；应用私有空间只有谜盒能读写，不会出现在 Drive 文件列表里，谜盒也看不到你 Drive 里的其他文件。

登录需要一个 Google Cloud 的「OAuth 客户端 ID」，写在 `extension/manifest.json` 的 `oauth2.client_id` 里。它和插件 ID 绑定，插件 ID 由同一个文件里的 `key` 固定为：

```
mdhhcfefflbkpbhgkflolailnmagdbbb
```

## 我该用哪一种

| 情况 | 做法 |
| --- | --- |
| 直接用仓库里的配置能登录 | 什么都不用做。 |
| 登录时提示应用未验证、没有权限、或「此应用被阻止」 | 仓库里的客户端属于作者的 Google 项目，可能只对测试名单开放。按下面「方式一」换成你自己的项目。 |
| 你要把改过的版本发给别人用 | 用「方式二」：换成你自己的 `key`、插件 ID 和客户端，并把应用发布成正式版。 |

## 方式一：在插件里用向导换成自己的项目（推荐，约 10 分钟）

1. 打开谜盒完整页 → 「设置 › 高级设置 › 自己的 Google 项目」，点「开始配置」。
2. 向导每一步都有一个按钮，打开 Google Cloud 后台对应的页面，做完点「做好了，下一步」：
   1. 新建项目（比如叫「我的谜盒」）；
   2. 启用 Google Drive API；
   3. 创建登录窗口（Google Auth Platform），用户类型选「外部」；
   4. 在「目标对象」把自己的 Google 邮箱加进**测试用户**（个人使用保持「测试」状态即可，不用发布）；
   5. 在「数据访问」添加 `drive.appdata`、`openid`、`userinfo.email` 三个范围；
   6. 创建客户端，类型选「Chrome 扩展程序」，商品 ID 填上面的插件 ID，复制得到的客户端 ID。
3. 回到向导粘贴客户端 ID，选择你加载的插件文件夹（`extension`）。向导会先下载原 `manifest.json` 和一份完整资料备份（含加密的保险箱），只改客户端 ID，核对写入后自动重新加载插件。
4. 自动回到向导后，点「登录并完成同步」。真的同步成功一次才算完成。

浏览器不让选文件夹时，点「下载配置」：保存好下载的原配置和备份，把新的 `manifest.json` 放进插件文件夹替换，再在 `chrome://extensions` 点「重新加载」。

> 换了 Google 项目后，新项目的 Drive 应用空间里没有旧资料。向导只会把**这台电脑上当前账号的资料**同步上去；其他电脑请先在旧配置下导出完整备份，再加载新配置导入。

测试状态的项目，Google 可能每隔一段时间（通常是 7 天）要求重新登录一次，这是 Google 对测试应用的限制，资料不受影响。

## 方式二：手动配置（发给别人用时）

1. 打开 [Google Cloud 控制台](https://console.cloud.google.com/)，新建项目，在「API 和服务 › 库」启用 **Google Drive API**。
2. 「Google Auth Platform」：
   - 品牌塑造：应用名称、支持邮箱、开发者联系邮箱；
   - 目标对象：用户类型选「外部」；要给所有人用就点「发布应用」改成正式版（只在测试状态时，只有测试名单里的账号能登录）；
   - 数据访问：添加 `https://www.googleapis.com/auth/drive.appdata`、`openid`、`https://www.googleapis.com/auth/userinfo.email`。
3. 想用自己的插件 ID：先删掉 `manifest.json` 里的 `key`，在 `chrome://extensions` 用「打包扩展程序」打包一次 `extension` 文件夹，得到 `.pem` 私钥；再用它算出公钥填回 `key`：

   ```sh
   openssl rsa -in extension.pem -pubout -outform DER | openssl base64 -A
   ```

   重新加载后 `chrome://extensions` 上显示的 ID 就是你的插件 ID。**`.pem` 私钥不要提交到仓库**（`.gitignore` 已经排除了）。
4. 「客户端 › 创建客户端」：类型「Chrome 扩展程序」，商品 ID 填你的插件 ID，把得到的客户端 ID 填进 `manifest.json` 的 `oauth2.client_id`。
5. 在 `chrome://extensions` 重新加载，到「设置 › 账号与同步」登录。

插件 ID 变了等于换了一个插件：浏览器里的本机资料不会跟过去。换之前先在旧插件里导出完整备份。

参考：[Chrome 扩展 OAuth](https://developer.chrome.com/docs/extensions/how-to/integrate/oauth)、[Drive 授权范围](https://developers.google.com/workspace/drive/api/guides/api-specific-auth)、[品牌验证](https://developers.google.com/identity/protocols/oauth2/production-readiness/brand-verification)。

## 不用 Google 也可以

不登录时，所有资料只存在这台电脑上，功能都能用，只是不同步。可以随时用「设置 › 收藏与导入 › 导出 › 完整备份」手动备份。Edge、Brave 等浏览器没有 `chrome.identity` 的 Google 登录，只能这样用。
