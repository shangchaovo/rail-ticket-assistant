# 同车余票 · AI 铁路查询助手

输入出发站、到达站和日期，就能把本轮查到的直达、同车分段和一次同站换车方案放在一起，比票价、余票和总用时。

**试查一趟车。** [打开公开查询页](https://rail-same-train-pages.pages.dev/)，从建议列表选两个实际车站，选今天起 15 天内的日期，点「查询实时余票」。公开版无需安装助手或登录私人工作台。

这是独立查询工具，与 12306 无隶属关系。结果不锁票，购票、候补及验证码均由乘客本人在 [12306 官网](https://kyfw.12306.cn/otn/leftTicket/init) 办理。

## 看懂一条备选路线

| 页面列出的方案 | 乘车时意味着什么 |
| --- | --- |
| 直达 | 一段票覆盖起点到终点。 |
| 同车两段 | 分别购买同一趟车首尾相接的两张票，中间可能换座。系统核对内部车次号、始发运行日与经停顺序，跨午夜按每段实际乘车日查询。 |
| 一次同站换车 | 下车后在同一车站改乘另一趟车。等待时间计入总用时，查询不推算同城跨站交通。 |
| 买长乘短 | 票买到更远的站，在目标站提前下车。比较价格时看实际购买区间。 |
| 短票＋申请补票 | 票面只覆盖前段，继续乘车要经允许，补票金额待确认。默认单列，不能当作全程有票。 |

结果可按综合、低价或耗时排序，默认最多展示 6 个优选。排序只比较本轮核验过的候选。未知票价没有低价优势，限流或超时后仍能看到已确认区间。「未核验」「无票」「候补」各有含义，查询失败也可能是数据源暂不可用。

## 公开查询和私人盯票

- **偶尔查一次**，用网页或 Chrome / Edge 侧边栏即可。公开 Worker 每轮使用临时匿名会话。公开数据库保存限流计数和短时并发记录，不保存行程或对话。扩展连接指定查询服务，不读取当前标签页或 12306 Cookie。
- **用自然语言查票**，可以写明日期、人数、预算和最晚到达时间。公开版 AI 会把问题、最近的用户上下文和表单交给 Workers AI 提取条件，再引用本轮核验的票段和采集时间解释推荐。票段事实最多有效 5 分钟，过期请重查。请勿填写身份证、手机号或支付信息。
- **定时盯某趟车**，需要自部署私人工作台、独立密码、私人数据库和已配对的 Mac 助手，可选 Bark 推送。12306 会话留在本人 Mac，私人云端保存任务和归一化行程。Mac 须保持开机、登录且联网，合盖休眠或断网时助手无法查票。[隐私说明](PRIVACY.md) · [Mac 助手](helper/README.md)

公开源码默认每个网络每日 20 次查询、全站 100 次、同时 2 次。公开 AI 配额分别是每个网络每日 15 次、全站 50 次。路线规划每轮最多查 12 个区间，含初始化的数据源请求另限 16 次。私人规划每轮最多 60 次。实际部署可受服务商配额或数据源限流影响。

## 本地构建网页与浏览器扩展

需要 Node.js 22.13+（建议 24 LTS）、npm 和 Python 3。在仓库根目录运行以下命令即可构建公开版，不需要私人数据库或 Mac 助手。

```sh
npm ci
npm run check
npm test
npm run test:bridge
npm run security:scan
npm run build:public
```

- 网页产物在 `dist/public`。运行本地 Worker 前，按部署说明准备 `wrangler.public.local.json`、本地 D1 与 `.dev.vars`，再运行 `npx wrangler dev --config wrangler.public.local.json`。[部署说明](docs/deployment.md)
- 扩展产物在 `dist/browser-extension`，ZIP 在 `outputs/`。打开 `chrome://extensions` 或 `edge://extensions`，启用开发者模式，加载该目录后点工具栏图标。扩展尚未在商店发布。自部署时先运行 `node scripts/configure-extension.mjs https://你的站点域名`，再构建。
- 私人版另配数据库与登录 secrets，`npm run package:helper` 生成 Mac 助手安装包。仓库中的零 UUID 是模板占位符，真实配置写在被忽略的 `*.local.json` 中。[安全说明](SECURITY.md) · [发布审查](docs/publication-audit.md) · [界面更新与验证](docs/ui-refresh.md)

公开服务位于 `cloud/public/`，私人工作台位于 `app/`，路线规划及排序见 `lib/rail-planner.ts`、`lib/rail-recommendation.ts`。两种服务的分流见 `cloudflare-pages/`。

第三方代码许可见 [Vite 插件许可](build/sites-vite-plugin.LICENSE) 和 [vendor](vendor/)。离线地图包含 © OpenStreetMap contributors 等来源，ODbL / CC0 署名详见[地图数据说明](lib/maps/README.md)。其余原创代码尚未指定开源许可证。
