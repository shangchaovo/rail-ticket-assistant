# 同车余票 · AI 铁路查询助手

一个轻量的铁路余票与路线比较工具：网页或 Chrome / Edge 侧边栏提交条件，比较直达、同车分段、一次同站换车、买长乘短与短票方案。AI 能理解日期、人数、预算和到达时间，并引用本轮核验的票段解释推荐。

[在线体验](https://rail-same-train-pages.pages.dev/) · [部署说明](docs/deployment.md) · [隐私说明](PRIVACY.md) · [安全说明](SECURITY.md)

2026-10-17 已完成线上安全更新，公开查询和私人工作台均已验证。详情见[发布审查](docs/publication-audit.md)。

2026-10-19 公开网页与浏览器扩展已更新为圆角卡片界面，新增快捷日期、快捷键查询与加载反馈；扩展版本为 1.0.1。详情见[界面更新与验证](docs/ui-refresh.md)。

本项目是独立的查询工具，与 12306 无隶属关系。界面采用常见铁路查询布局；购票、候补与验证码由使用者本人在官网完成。

## 功能

- **公开按需查询**：独立云端 Worker 查询本轮官方数据，无需在本地常开程序。不保存公开查询历史。
- **路线比较**：综合、低价、耗时三种排序，默认最多展示 6 个优选；详细票段按需展开。中转等待计入总用时，未知票价不会当作低价优势。
- **同车核验**：使用内部车次号、始发运行日和经停顺序确认同一运行班次，跨午夜按每段实际乘车日期处理。
- **AI 查票**：结构化提取需求，检索本轮签名事实，再生成带方案引用与采集时间的回答。库存最多有效 5 分钟，过期需重新查询。这里的 RAG 检索对象是实时归一化票段，没有历史库存向量库。
- **浏览器扩展**：Manifest V3 侧边栏，界面和脚本打包在本地，仅连接指定查询服务，不读取当前网页或 12306 Cookie。
- **私人工作台**：独立密码、本人 Mac 会话、可撤销设备令牌、后台助手、定时盯票与可选 Bark 提醒。此模式需要 Mac 开机联网。
- **含义说明**：问号提示可悬停、键盘聚焦或点击查看，手机可点开；界面保留简洁布局。

“同车两段”指同一趟车分别购买两张接续票，可能换座；“异车中转”指同站下车换乘另一趟车。“买长乘短”按较远到站购票，在目标站下车。“短票＋申请补票”只覆盖票面区间，继续乘车需获准，金额待确认；默认不把它混进覆盖全程的推荐。

## 本地开始

需要 Node.js 22.13+（建议 24 LTS）、npm、Python 3。macOS 助手另有自己的依赖。无需安装助手即可构建公开网页与扩展。

```sh
npm ci
npm run check
npm test
npm run test:bridge
npm run security:scan
npm run build:public
```

公开网页产物位于 `dist/public`；扩展目录位于 `dist/browser-extension`，交付 ZIP 位于 `outputs/`。本地运行公开 Worker 前，按[部署说明](docs/deployment.md)配置本地 D1 和 `.dev.vars`，然后执行 `npx wrangler dev --config wrangler.public.local.json`。

扩展本地安装：打开 `chrome://extensions` 或 `edge://extensions`，启用开发者模式，加载 `dist/browser-extension`，再点击工具栏图标。当前尚未在扩展商店发布。自部署时先用 `node scripts/configure-extension.mjs https://你的站点域名` 配置服务 origin，再构建、部署。

私人工作台：先按部署说明设置独立数据库和登录 secrets。运行 `npm run package:helper` 生成下载包；Mac 上的安装与后台服务操作见 [helper/README.md](helper/README.md)。仅测试公开版不需要配置私人模式。

## 请求预算与准确性

公开版默认每个网络每天 20 次查询、全站每天 100 次、同时 2 个查询；AI 默认每个网络每天 15 次、全站 50 次。配额是源码中的保守默认值，服务供应商计费及免费额度以实际账号为准。

查询先给直达，再核验有限候选站。公开规划默认最多 12 次区间数据请求，数据源包含初始化等操作另限 16 次；私人每轮最多 60 次。限流、验证、取消、时间或容量预算用尽时停止，保留已确认结果并标明其余区间未核验。**排序只比较本轮核验过的候选，不保证全国所有路线的全局最优。**

未知、无票、候补、未起售与不支持分别保留。查询失败不等于无票，结果不会保留或锁定车票。中转仅支持一次同站换车，不推断同城换站交通；默认需足够等待时间。短票不代表后续区间有票，补票不保证获准。

## 代码导航

| 位置 | 用途 |
| --- | --- |
| `cloud/public/` | 公开网页、匿名官方会话、流式接口、配额与 AI |
| `app/`、`lib/rail-api.ts` | 私人工作台与本人任务鉴权 |
| `lib/rail-planner.ts`、`lib/rail-recommendation.ts` | 同车与中转规划、候选排序 |
| `lib/private-auth.ts`、`lib/private-assistant.ts` | 私人登录与本人的 AI 查询 |
| `helper/` | macOS 钥匙串、官方浏览器会话及后台服务 |
| `browser-extension/` | Chrome / Edge MV3 扩展源码 |
| `cloudflare-pages/` | 公开与私人服务分流，过滤公开请求中的私人凭据 |
| `drizzle/`、`cloud/public/schema.sql` | 独立数据库结构与迁移 |
| `tests/`、`helper/tests/` | 使用合成数据的自动化测试 |

没有包含部署账号 ID、生产数据库、真实查询验收日志、个人浏览器资料、Cookie、密码、密钥或原开发历史。配置模板中的零 UUID 不能部署，使用被忽略的 `*.local.json` 配置自己的环境。

第三方代码许可见 `build/sites-vite-plugin.LICENSE` 和 `vendor/`；离线地图数据来源与 ODbL / CC0 署名见 [lib/maps/README.md](lib/maps/README.md)。本仓库尚未为其余原创代码指定额外开源许可证。
