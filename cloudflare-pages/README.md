# Pages 分流

Pages 不绑定数据库或登录 secrets。公开首页、`/api/public/*` 和 `/public-assets/*` 转到 `PUBLIC_BACKEND`；`/workspace` 转至私人入口，其余登录、任务、下载等转到 `RAIL_BACKEND`。公开转发移除私人 Cookie、授权头、助手租约和平台身份。

预览只有公开绑定；绑定缺失或抛错时返回通用 503，不回退到静态文件。保留原 URL 和 Origin，私人认证仍由私人 Worker 执行。

配置、发布及测试见 [自部署](../docs/deployment.md)。
