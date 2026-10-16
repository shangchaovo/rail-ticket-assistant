# 自部署

所有资源必须在自己的 Cloudflare 账号创建。仓库配置是模板，不含维护者账号、数据库 ID 或密钥。保留公开和私人数据库隔离。

## 配置文件

```sh
cp wrangler.public.json wrangler.public.local.json
cp wrangler.cloudflare.json wrangler.cloudflare.local.json
```

在所需的本地文件中填自己的 `account_id` 和真实 `database_id`。脚本和私人构建优先读取这些被忽略的文件，缺少本地文件时只读模板。勿将实际配置写回模板后提交。

公开 Worker 名默认 `rail-query-public`，私人 Worker 默认 `rail-same-train`。Pages 的两个服务绑定分别连接它们；预览只绑定公开服务。当前部署脚本检查这些默认资源名。如需重命名，需一起修改脚本与绑定。

## 公开查询

```sh
npx wrangler login
npx wrangler d1 create rail-query-public --config wrangler.public.local.json
```

把返回的数据库 ID 填入本地配置。生成足够随机的 `RATE_SALT`，通过 Wrangler 的隐藏输入配置，避免放进 shell 参数或提交文件。

```sh
npx wrangler secret put RATE_SALT --config wrangler.public.local.json
npm run deploy:public
```

部署脚本先检查授权、独立数据库和 salt secret，再构建、初始化公开限流表、发布。AI 通过 `AI` binding 使用账号的 Workers AI，`AI_ASSISTANT_ENABLED=false` 可关闭 AI。`PUBLIC_ENABLED=false` 可停止公开查询。应用日限额不是供应商费用上限，请在平台设置预算与监控。

本地开发可使用仅本地的 `.dev.vars`（不得提交）：

```text
RATE_SALT=replace-with-a-random-development-only-value
```

```sh
npm run build:public
npx wrangler d1 execute rail-query-public --local --config wrangler.public.local.json --file cloud/public/schema.sql
npx wrangler dev --config wrangler.public.local.json
```

本地 AI 是否可用取决于 Cloudflare binding 支持和账号权限；没有 AI 仍可使用表单查询。

## 私人工作台（可选）

```sh
npx wrangler d1 create rail-same-train --config wrangler.cloudflare.local.json
npm run package:helper
npm run deploy:cloudflare
node scripts/provision-private-auth.mjs
```

部署前填好私人本地配置。最后一步仅支持 macOS：保留或生成本机钥匙串中的网站口令、owner 和签名密钥，上传加盐密码摘要与 secrets；不会把明文写进源码。已有部署迁移时先发布支持 PBKDF2 的 Worker，再运行该脚本，原密码及登录会话签名密钥不变。

本地私人开发使用 `npm run dev:cloudflare`。先用 `wrangler d1 migrations apply rail-same-train --local --config wrangler.cloudflare.local.json --persist-to .wrangler/cloudflare-state` 初始化；自己的本地认证 secrets 放入 `.dev.vars`。不要将开发模拟身份模式部署到公网。

私人 AI 另有 `drizzle/0004_private_ai.sql`；数据库迁移由部署脚本应用。Mac 助手按 [helper/README.md](../helper/README.md) 安装、配对。定时器仍依赖本人 Mac 在线。

## Pages 统一入口（可选）

在 Cloudflare 创建自己的 Pages 项目。默认名称 `rail-same-train-pages` 可在自己的账号复用；若需更名，请同步修改脚本检查。只使用公开版时，也可直接访问公开 Worker，无需 Pages 或私人服务。

```sh
cp cloudflare-pages/wrangler.json cloudflare-pages/wrangler.local.json
npm run test:bridge
npm run deploy:pages
```

脚本读取本地 Pages 配置并显式发布桥接目录。公开路径送到 `PUBLIC_BACKEND`，私人登录、下载及任务路径送到 `RAIL_BACKEND`。缺少某绑定只返回不可用，不回退到未鉴权静态文件。

## 配套扩展

```sh
node scripts/configure-extension.mjs https://你的统一入口域名
npm run build:public
```

此命令同步扩展连接权限、CSP 和服务 origin；域名必须是 HTTPS origin。服务与扩展须同步构建、部署。默认配置连接公开演示站，可直接体验，但配额与演示网页共享。公钥只用于稳定本地扩展 ID，没有附带私钥；独立发行应建立自己的扩展身份与商店发布流程。

## 验证

确认匿名查询可用、匿名私人 API 被拒绝、其他任务 ID 不能越权、CORS 不放行外站，且下载包与公开仓库不含运行数据。真实查询受官网网络、登录、验证与限流影响，自动测试通过不保证官网当时有票。部署文档不包含任何真实查询结果。
