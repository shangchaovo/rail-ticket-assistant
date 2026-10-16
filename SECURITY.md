# 安全说明

发现漏洞时请使用 GitHub 的私密漏洞报告（若仓库启用该功能），不要把有效密码、Cookie、Bark 地址、设备令牌、数据库或私人查询上传到公开 issue。无法私密报告时，仅在 issue 中说明需要建立私密报告渠道。

## 发布检查

```sh
npm run security:scan
npm run check
npm test
npm run test:bridge
npm --prefix helper ci
npm --prefix helper test
```

`security:scan` 检查 Git 已跟踪文件和新源码，拒绝私钥、常见服务令牌、个人绝对路径、生产资源标识及运行数据；只输出文件、行号和规则名，不打印命中值。可用 `python3 scripts/scan-public-source.py --history` 加查本地所有 Git blob；`--artifacts` 同时检查本项目生成的助手和扩展 ZIP。它不是完整的渗透测试或专业泄露监测。

CI 在最小只读仓库权限下运行合成测试与源码扫描，不需要生产 secrets，不自动部署。运行时数据与配置应保存在被忽略的 `.dev.vars`、`*.local.json`、`.wrangler/` 或系统钥匙串；不要使用 `git add -f` 绕过这些规则。

新公开仓库从清理过的源码建立初始提交，不携带私人开发历史。后续若把凭据提交到任何远端，应撤销/轮换凭据并清理历史，单独删除文件不足以作废旧凭据。

## 边界

- 生产私人 Worker 明确要求私人认证，拒绝伪造的平台身份；任务必须属于当前拥有者。
- 公开 Worker 仅绑定自己的限流 D1。公开客户端和 Pages 桥接均过滤私人认证数据。
- 配额在数据库内原子扣减；服务端签名和有效期控制 AI 库存事实。
- 本项目不代购、不自动提交候补、不解决验证码或对抗官网限制。
- 登录防爆破、请求预算与来源白名单并不能阻止全部网络攻击；生产环境仍需部署者维护依赖和平台权限。

已知依赖限制与本次修复记录见 [发布审查](docs/publication-audit.md#依赖审查2026-10-17)。仍存在一个上游尚无修复版本、用于构建工具的 `braces` 告警；本项目不宣称依赖告警为零。
