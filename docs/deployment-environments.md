# UAT / Prod 部署约定

日期：2026-10-17。状态：已纳入 T1 的目标设计，尚无部署工作流、GitHub Environment 配置、Secrets 注入或实际部署。本文件不授权创建资源或触发工作流。

## 环境与资源

| 项目 | UAT | Prod |
| --- | --- | --- |
| GitHub Environment / 部署目标名 | `uat` | `production`；不另设 `prod` 别名 |
| 用途 | T1 及后续 tracer bullet 的集成与 Human QA | 已通过 UAT 的版本对外运行 |
| WorkOS | 计划复用已核验 TOB Staging，sandbox=true | 独立 Production，sandbox=false；尚未准备 |
| Cloudflare | 独立 Worker、D1、Org DO namespace、Cron、HTTPS origin | 独立同类资源；不得绑定 UAT 数据库或 DO namespace |
| 身份与秘密 | 独立实例 ID、Client ID、Webhook endpoint/signing secret、API key、管理员绑定 | 与 UAT 分离，不复制 UAT 用户/组织/会话或管理员回执 |
| 客户端 | 分别导入公开实例配置；按实例/用户存储会话 | 独立导入和登录，不把 UAT token 送入 Prod |

可使用同一个 Cloudflare account，但账号相同不代表资源/凭证权限已经隔离。部署前比较绑定的真实 ID；环境名或 Worker 后缀不是隔离证明。T2 增加的 Channel DO 与未来 R2 同样隔离。移动回调按实际 App 构建精确登记；WorkOS 类型、部署目标和 App 回调是不同字段，不能简单按 uat/prod 字符串猜测。

本地开发采用本地 Worker/D1/SQLite DO 与明确标记的认证 fixture，不自动连接 UAT/Prod。现有 `tob-staging` 是本机准备 profile，WorkOS Staging 是供应商环境，UAT 是应用部署目标：三者显式映射，不新建第三套共享 Staging 云栈。当前向导尚不支持 Production，不能改文件名复用其 key。

## GitHub 配置合同

在 `uat` 与 `production` 各自配置相同变量名；部署 job 必须声明对应 Environment，缺失值即停止，不从另一环境或仓库全局秘密补默认值。

| 名称 | 存放位置 | 使用者 / 说明 |
| --- | --- | --- |
| `CLOUDFLARE_API_TOKEN` | Environment Secret | CI 部署控制面凭证；根据实际 Worker/D1/DO/Secrets 操作核验最小权限。不得把个人 OAuth session 文件上传 CI |
| `WORKOS_API_KEY` | Environment Secret → 目标 Worker Secret | 环境级运行密钥；仅受保护配置/部署步骤读取，不进入构建产物、参数、日志或二维码 |
| `WORKOS_WEBHOOK_SECRET` | Environment Secret → 目标 Worker Secret | 该环境事件端点的签名秘密；需安全取得和交接，不能从 MCP 脱敏 metadata 推导 |
| `CLOUDFLARE_ACCOUNT_ID` | Environment Variable | 目标账号；公开标识但仍以控制面读回核验 |
| `WORKOS_ENVIRONMENT_ID`、`WORKOS_CLIENT_ID`、`WORKOS_AUTH_DOMAIN` | Environment Variables | 对照认证控制面；受支持 issuer/端点按固定合同生成并核验，不能把任意 URL 当可信认证服务 |
| `INSTANCE_ID`、`PUBLIC_BASE_URL` | Environment Variables | 每环境不同；交付到公开连接配置 |
| `WORKER_NAME`、`INSTANCE_DB_ID` | Environment Variables | 明确选定目标，正常发布阶段不因缺失而自动创建资源 |

Org DO namespace/class/binding 与迁移由单一 `cloudflare.config.ts` 合同解析，部署记录读回实际 namespace ID；不再维护第二份可漂移的手工 bindings 表。具体字段接入当前 cf 版本的方式在本地实施时锁定，不将这些变量名当作已支持的 cf 参数。

GitHub Secrets 与 Worker Secrets 是两个存储位置：前者不会自动出现在运行中的 Worker。部署工具须经标准输入或受限临时文件交给受支持 CLI，关闭 tracing、避免秘密进入命令参数和 artifacts，并清理临时文件。只列秘密名称不能证明值正确；后续须有不输出秘密的运行检查和真实签名投递证据。运行 Secret 注入是云写操作，本轮未执行。

初次资源准备/WorkOS 管理与普通版本发布分开：普通发布不隐式创建 Production 环境、不发邀请、不改注册/角色、不重新初始化管理员。WorkOS MCP 人工 OAuth 不上传 GitHub；CI 不假定能继承该管理会话。本机 key 核验只覆盖当时文件，未来上传的 CI key 须独立核验，不能沿用 HTTP 200 截图作为证明。

## 发布路径

1. **本地 / PR：**锁定依赖、合同与集成测试、验证打包；不使用真实云秘密。fork/不可信 PR 不能取得部署 Secrets，不通过 pull_request_target 执行其代码。
2. **UAT：**首期仅显式手动触发，指定通过检查的 main commit SHA；以后是否 main 自动部署另行开启。环境未准备、权限不足、映射缺失即在首个云写入前停止，不自动降级默认目标。部署完成核对 SHA、实例/环境及健康状态，再进行手机与 CLI Human QA。
3. **Prod：**独立手动晋级已通过 UAT 与 Human QA 的确切 SHA；部署工作流来自受保护分支，目标 SHA 必须属于允许的发布分支，不接受任意 PR/fork ref。GitHub production 环境配置受保护分支及必要审核；配置可用性需实际读回确认，不只写一个 environment 字段就宣称已保护。未建立可执行的放行机制保持生产关闭，不复制参考仓库的计划限制作为事实。
4. **并发 / 中断：**每个目标一个部署并发组，UAT/Prod 均 `cancel-in-progress: false`；更新中的迁移不因新提交被自动取消。不要承诺每次排队都保留，重新执行仍须按操作状态读回恢复。日志记录 SHA、目标、资源 ID、迁移/版本和结果，不记秘密。
5. **恢复：**迁移采用向前兼容路径，部署前确认 D1 数据恢复点及 DO schema 与旧代码兼容性。回退 Worker 代码不自动回退 D1/DO 数据；失败后按已应用迁移/已部署版本决定重试或恢复，不盲目重建资源、重置数据、轮换秘密或重绑管理员。

UAT 与 Prod 从同一源 commit 构建但使用各自配置，不要求二进制完全相同；证据要带源码 SHA、依赖锁与环境。T1 的完整运行验收在 UAT 完成，Prod 设计/隔离检查可本地验证；真实 Prod 开通/部署是另行放行的发布步骤，不阻塞首个本地增量。开源自部署者可只选一套环境，GitHub CI 是可选发布入口，与本机部署复用同一合同。

## 参考与有意取舍

只读参考了本机 GEO 与 grillmaker 的工作流源文件，未读取它们的秘密、修改文件或运行工作流；源文件不是 GitHub 环境保护已启用的证据。

- GEO（checkout `59ec0fd`）：`.github/workflows/deploy-uat.yml` / `deploy-production.yml`。参考 environment 级凭证、精确 SHA、迁移前后检查、部署串行不中断。其租户分支、专用 runner 和私有仓库审核替代规则不复制。
- grillmaker（checkout `ef186d6`）：`.github/workflows/ci.yml` / `deploy-production.yml`。参考 UAT 通过后生产晋级、配置缺失拒绝、认证配置防串环境及发布后版本读回。其生产 tag 触发和 UAT 自动取消正在部署的行为不采用；TOB 首期统一手动触发且不取消迁移中的发布。

## 验收条件（未实现）

- [ ] 本地与 PR 无云写入；同一配置解析器供本机/CI 使用，目标为显式 uat 或 production；未知目标、缺失值和跨环境绑定在云写入前拒绝。
- [ ] 每个 Environment 的 Secrets/Variables 独立；检查 WorkOS 环境类型、Client ID、Worker/D1/DO 与公开 origin 映射，UAT key/token 不能访问 Prod 业务；真实凭证写权限另行验证。
- [ ] GitHub Secrets 安全注入正确 Worker，并通过不泄密的运行检查；Webhook 签名真实验证，不将“secret 名称存在”等同于值正确。
- [ ] Prod 只允许晋级同 SHA 的 UAT 成功与 Human QA 记录；工作流 ref、环境保护、配置与 Secrets 可用性须在首次发布前核验。
- [ ] 部署串行、中断读回和迁移恢复有证据；运行版本/实例信息可读回；代码回退与数据恢复分开记录。

本轮仅提交文档和任务条件；不创建 GitHub Environments、不上传 Secrets、不创建云资源、不部署。
