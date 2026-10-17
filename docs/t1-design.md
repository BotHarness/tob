# T1 展开：仓库、自部署、手机与 CLI 登录

日期：2026-10-17。状态：Human 已认可的细化方案；TOB 公开规划仓库与任务迁移已获授权，未实现、未部署。

关联：[Spec #1](https://github.com/BotHarness/tob/issues/1)、[T1 #2](https://github.com/BotHarness/tob/issues/2)。本次仅收敛 T1，不扩大 T2–T5。

## 1. 要确认的结果

部署者使用自己的 Cloudflare 和 WorkOS，并独立核验实例配置。T1 只允许已初始化且 active 的实例管理员进入业务和创建组织。手机没有任何已配对 Host，从已核验实例配置登录、创建自己的组织；CLI 登录同一身份，看到同一组织。两边退出、刷新、组织切换和失权均可验证。

推荐手机采用 AuthKit Authorization Code + PKCE，CLI 采用 AuthKit Device Authorization。登录直接连接 WorkOS，业务访问 Hono Worker。无需 Auth DO、应用密码表或自行签发第二种 Human 会话。

手机 PKCE 有 [WorkOS 官方 Expo 示例](https://github.com/workos/expo-authkit-example)；[Device Authorization](https://workos.com/docs/authkit/cli-auth)也可用于手机，但多一次验证码确认/返回 App 操作，保留为候选而非首片同时交付两种登录方式。两者均不需要客户端携带服务端 API key。

## 2. 新仓库组织

项目名 TOB — Thousands of Bots，仓库 `BotHarness/tob`。CLI 拟名 `tob`；npm scope 和许可证尚未正式确定。以下是建议目录，不代表已存在或开始创建。

```text
tob/
  apps/
    service/             Hono Worker、身份适配、应用命令、Org DO
      src/
      db/d1/             Drizzle schema 与 D1 SQL migrations
      db/org/            Drizzle schema 与 Org DO migrations
      wrangler.jsonc     资源 bindings、兼容日期、环境、定时任务
    cli/                 面向用户/管理员的薄 HTTP 客户端
  packages/
    contracts/           请求、响应、错误码、公开发现文档与协议版本
    client/              平台无关客户端；会话/安全存储通过平台适配
  tools/deployment/      部署、诊断、受保护的超级管理员初始化/恢复
  tests/                 公开合同和真实 Worker/D1/DO 集成测试
  docs/                  部署说明、协议、架构、ADR、验收操作
```

- T2 增加 Channel DO 与群消息合同；T3 增加独立参考 Agent。T1 不提前建立未使用的 Agent SDK、计费包或文件服务。
- 现有 DeepSeekBot 仓库继续拥有 Expo App、桌面入口、Host 适配和本地 Bot CLI。不搬迁产品，也不在新仓库提供聊天 Web UI。
- Forge 在这里是“一套服务端命令/校验合同，多入口消费”的组织原则。以现有 links 服务的单一 OpenAPI 合同先例为参考，不假定引入一个名为 Forge 的运行时依赖。
- Hono 路由执行应用命令与权限检查；CLI、手机调用同一 API。Hono RPC 服务 TypeScript 调用，OpenAPI/JSON 为其他语言提供公开合同；避免让外部 Agent 导入服务器包或依赖 Hono 才能访问。
- Drizzle 的 D1 与 DO schema/迁移分别归各自 owner；不把它们当成一个可以跨库 join/transaction 的数据库。官方分别提供 [D1](https://orm.drizzle.team/docs/sqlite/connect-cloudflare-d1)和 [DO SQLite](https://orm.drizzle.team/docs/sqlite/connect-cloudflare-do)驱动。锁定实际验证版本，不把当前文档推荐的 RC 自动当作项目升级决定。

## 3. 自部署资源清单

| 平台 | T1 需要 | 作用 |
| --- | --- | --- |
| Cloudflare | 一个 Worker | Hono API、公开实例信息、身份事件接收、定时补漏、组织管理 |
| Cloudflare | 一个 D1 database | 实例政策、超级管理员、组织映射、管理操作、事件收件记录和补漏进度 |
| Cloudflare | 一个 Org DO namespace，SQLite backend | 按 org_id 创建组织业务状态与只读身份投影；不是每组织手动配置一个 binding |
| Cloudflare | HTTPS 地址 | 可先用 workers.dev；自定义域名可选，API 与登录发现需保持稳定 origin |
| Cloudflare | Worker Secrets | WorkOS API key、事件签名校验 secret；不放源码或 App |
| Cloudflare | Cron Trigger + Worker 日志 | 有界补漏/重试、同步健康；事件处理与 checkpoint 持久化，日志去除令牌/认证码 |
| WorkOS | 部署者自己的项目/环境，T1 一个 AuthKit application | 该实例用户、会话、组织、成员；开发与生产环境隔离 |
| WorkOS | 公共 Client ID、托管登录域名、服务端 API key | App/CLI 只拿公开配置；API key 留在 Worker |
| WorkOS | 登录方式、移动回调白名单、Sign-out URI | 首片一种托管登录方式，沿用 spec 的邮箱密码建议；完整 OTP/Google 后续 |
| WorkOS | 身份事件端点及签名 secret | 发往本实例 Worker；Events API 补漏，同步资格变化 |
| WorkOS | 固定单角色 owner/member | 明确创建 owner，member 保持默认；核验角色和动作映射，缺失或不符阻止建组织 |

T1 不需要 R2、KV、Queues、Cloudflare Tunnel、Cloudflare Access 或邮件发送服务。T2 才增加 Channel DO namespace；R2 在附件切片增加。Cron 与 D1 inbox 足够首片的低频身份事件恢复，暂不增加另一种队列资源。

Cloudflare 资源通过 [bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/)连接；秘密使用 [Worker Secrets](https://developers.cloudflare.com/workers/configuration/secrets/)，补漏可使用 [Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)。本方案建议以 Wrangler 配置和部署说明起步；一键部署按钮后续可减少 Cloudflare 设置，但不能替代部署者的 WorkOS 账号配置。

WorkOS 自部署模式意味着“业务运行在自己的 Cloudflare，身份仍在 WorkOS 云端”，不等于离线自托管 WorkOS。每个部署使用独立环境/凭证，不能共用 DSB 官方身份库。[WorkOS 自部署说明](https://workos.com/docs/on-prem-deployment)

### 配置归属

下列是建议配置合同，名字在实现时统一：

| 类别 | 内容 | 放在哪里 |
| --- | --- | --- |
| 公共实例配置 | INSTANCE_ID、PUBLIC_BASE_URL、协议版本 | Worker vars / 公开发现文档 |
| 公共认证配置 | WORKOS_CLIENT_ID、受支持 issuer/AuthKit domain、固定移动回调 | Worker vars / 公开发现文档 |
| 服务端秘密 | WORKOS_API_KEY、WORKOS_WEBHOOK_SECRET | Worker Secrets |
| 应用政策 | registration_mode=admin_only、org_creation_mode=admin_only、配置版本 | T1 固定两项模式；D1 缺失/非法值拒绝业务管理，不提供策略编辑器 |
| 资源绑定 | D1 的 INSTANCE_DB、Org DO 的 ORGS | Wrangler 配置，不需要把数据库密钥交给手机 |
| 部署权限 | Cloudflare deploy 凭证 | 部署者机器/CI，不进入业务 App 或普通 CLI 登录配置 |
| 用户凭证 | Access/refresh token | 手机安全存储、CLI OS 凭证库或明确配置的受限文件存储 |

WorkOS OAuth 设置不假定能靠我们的环境变量自动创建：Google 后续仍需在 WorkOS/provider 完成真实接入配置。T1 保持一个 application 服务手机与 CLI；日后要独立会话策略可拆 application，但保留同一环境的用户/组织。[WorkOS Applications](https://workos.com/docs/authkit/applications)

## 4. 部署者的最短操作路径

1. 获取开源仓库，准备自己的 Cloudflare 账号和 WorkOS 环境，选定公开 HTTPS 地址。
2. 在 WorkOS 设置一种登录方式并关闭公开注册，建立首个部署者用户；可通过 Dashboard 完成首次账号准备。创建或核验 owner/member 单角色配置，member 保持默认；不要求应用实现邀请 UI。
3. 登记发布版 OAuth 回调 `ai.botharness.deepseekbot:/oauth2redirect`，开发版登记 `ai.botharness.deepseekbot.dev:/oauth2redirect`；不使用 wildcard。登记固定 Sign-out URI，配置身份事件接收地址。
4. 部署工具创建 Worker/D1/Org DO binding，应用迁移，注入 Worker Secrets，配置 Cron；staging 和 production 分开。初始准入/建组织政策均为 admin_only；初始化完成前业务请求一律拒绝。
5. 部署者通过受 Cloudflare 账号权限保护的初始化命令，将核验过的 WorkOS user_id 写入 instance_admin。这个命令不是匿名公网“第一个登录者成为管理员”。重复初始化须幂等；恢复另用显式恢复动作并记录审计。
6. 部署者从自己控制的 Cloudflare 地址配置与 WorkOS Dashboard 独立核对 API HTTPS origin、Client ID、issuer/认证端点、精确回调，形成 T1 的固定可信配置。目标站点自己的 discovery/二维码不作为核验凭据；无须新签名协议或官方登记中心。
7. 通过该配置登录后，管理员 CLI 执行 doctor：检查实例版本、绑定/迁移、认证配置、角色/单角色模式、admin_only 政策和同步状态。非管理员不得读取内部诊断；诊断不回显秘密。
8. 手机和 CLI 分别以已初始化管理员登录，用业务 API 创建并查看自己的组织。日常管理经过账号/组织权限检查，不需要部署凭证。

初始化工具的实现建议是部署者本机通过 Cloudflare 管理面执行受限 D1 初始化，并核验 WorkOS 用户；它与普通 `tob` 远程业务命令的权限明确分开。恢复实例管理员资格不能恢复/绕过 WorkOS 用户账号认证。

## 5. 连接发现与手机登录

公开发现端点为 `GET /.well-known/open-cloud-groups`。这是应用协议，不是 WorkOS 标准端点。返回实例 ID、服务地址、协议兼容范围、公共 Client ID、认证服务信息和支持能力；不返回 API key、组织名单或用户数据。T1 中 discovery 仅与部署者独立核验后预先固定的配置比较，不作为实例可信归属的证据；不新增自动核验、签名登记或通用 OIDC 机制。

手机输入/扫码只选择已核验配置中的 HTTPS 实例地址。仅点击确认域名不算独立核验。未知地址、Client ID/issuer/端点/回调不匹配时，在启动认证或发送 token 前拒绝；配置变化须由部署者重新核验，不自动接受。二维码不携带长期密钥、用户身份或资格。登录事务使用固定配置，回调参数不能更换实例。

```mermaid
sequenceDiagram
  actor H as Human
  participant M as 手机 App
  participant W as 实例 Hono Worker
  participant A as WorkOS / 系统浏览器
  H->>M: 选择部署者已核验的实例
  M->>W: 获取公开发现配置
  M->>M: 比较已核验组合；不匹配即停止
  M->>M: 生成 state 与 PKCE verifier/challenge
  M->>A: 打开托管登录（公开 Client ID）
  H->>A: 完成登录
  A-->>M: 固定 App 回调：code + state
  M->>M: 校验未过期事务、state、实例和回调
  M->>A: code + verifier 换取 token
  A-->>M: access token + refresh token
  M->>W: Bearer token 请求我的身份/组织
  W-->>M: 实例准入、可用组织、可执行动作
```

OAuth 专用回调固定为 `ai.botharness.deepseekbot:/oauth2redirect`，开发版为 `ai.botharness.deepseekbot.dev:/oauth2redirect`，采用受控域名反写 scheme。现有 deepseekbot/deepseekbot-dev 导航 scheme 保留，但不作为 OAuth 回调。部署者精确登记相应回调；客户端使用已核验配置中的 Client ID，并与发现信息比较。设计不要求按实例重编 App，但新增 OAuth scheme 需要原生构建，尚未实现。

手机通过系统浏览器登录，密码只提交到 WorkOS 页面。PKCE 的作用是让拿到回调 code 的另一程序也不能仅凭 code 换取登录凭证。还须生成随机 state，并把实例 origin、Client ID、回调 URI、verifier、过期时间绑定为一次性事务；重复回调、切换实例后的旧回调都拒绝。自定义 scheme 不等于系统保证独占，不能省略这些校验。

令牌只发送到独立核验并固定的实例及认证端点；不接受 discovery 自动指定的新目的地。state/PKCE 保护认证事务，不能证明资源服务器归属，也不能防止客户端主动把 bearer 发送到冒牌实例。T1 通过明确的人工核验前提缩小范围，不宣称支持任意陌生实例安全接入；额外代理/通用 OIDC 留后续。

Native OAuth 必须在实际开发/发布构建验证，不能以 Expo Go 或网页预览替代。官方示例证明原生路线存在，不证明我们的 SDK 57、多实例缓存、冷启动回调已通过。SDK 与 Expo AuthSession/HTTP 的具体选择在 T1 开始后结合当前依赖验证；不为复刻示例随意引入 Node SDK/native crypto。

## 6. CLI 登录

拟定命令体验（尚未实现）：`tob login --server <HTTPS 地址>` → 显示实例与确认码 → 打开 WorkOS 页面确认 → CLI 登录成功；无浏览器机器可以在另一台设备打开验证码页面。

1. 与手机使用同一部署者已核验配置，读取发现文档进行一致性比较。未知实例或配置不匹配时，不申请 device code、不发送 token。
2. 调用 WorkOS device authorization，获得用户码、私有 device_code、验证地址、到期时间与轮询间隔。
3. 终端只展示用户确认码与验证地址；device_code 不输出。用户在浏览器核对验证码、登录并授权。
4. CLI 按 WorkOS 给定间隔等待结果，处理 slow_down、取消、超时；获取 token 后按实例/身份保存。
5. 调用同一 `/me` 与组织 API；`whoami`、`org list/create/use` 与手机具有相同权限。

CLI 不要求本机端口回调，也不复制用户密码。具体 device/refresh 合同按 [CLI Auth 官方文档](https://workos.com/docs/authkit/cli-auth)。普通 stdout 输出结构化结果，不输出 token；交互提示/验证码使用明确的交互输出，诊断与日志不能收集登录材料。

## 7. 登录后如何创建组织

已初始化的 active 实例管理员最初可以没有组织；`/me` 返回空组织列表并允许创建。未初始化、非 active 管理员或仅有 WorkOS 身份的用户，业务入口返回明确拒绝，不能因为 token 有效就进入实例。认证失败与已认证但无权进入须区分。

手机“创建工作区”和 CLI `org create` 走同一服务命令：

1. Worker 验证本实例 WorkOS Human、instance_admin 的 active 状态，以及两项 admin_only 政策；缺失或无法确认即拒绝。客户端提交的名称/角色/组织 ID 不赋予资格。
2. D1 记录稳定 operation_id 和 payload hash；相同操作重试恢复同一流程。
3. 确认 owner/member 单角色配置正确后，WorkOS 创建 Organization，并显式给创建者分配 owner membership；D1 建立唯一 organization_link。owner 缺失或映射不符不能回退为 member，也不能把 member 默认设为 owner。
4. 初始化该 org_id 的 Org DO（组织设置、成员资格只读投影）。全部必要步骤完成后标 active，才能作为可用组织返回。
5. 客户端通过 WorkOS 刷新/选择组织获得相应 org_id 的访问令牌，再访问组织业务 API；服务器核对 token 与目标组织。

原生/CLI 每个会话单独拥有 refresh token；同一用户不共享设备 refresh token。组织切换的 WorkOS 机制见[会话文档](https://workos.com/docs/authkit/sessions)。登录成功、被实例接纳、组织成员资格、建组织资格是不同判断。

跨 WorkOS/D1/Org DO 没有事务。创建接口的具体幂等/外部 ID 合同仍须 T1 实测；响应丢失后无法确认是否已创建时保持 processing/needs-review，并查证原资源，不盲目再次 create。T1 必须证明中途失败不会产生重复可用组织。

固定权限规则：所有组织动作先通过 T1 的管理员准入；列表只显示本人的 active memberships，组织读取/切换仍须目标组织 active membership，组织管理还须 owner。member 无组织管理权，未知角色默认拒绝有权限要求的操作。instance_admin 不自动获得其他组织的内容访问或 Agent 工作权。非管理员即使是 WorkOS organization owner，也不能越过 T1 准入。T1 不新增成员邀请、角色编辑 UI 或管理命令。

T1 落库沿用 spec 的六张 D1 表；Org DO 先落 org_config 和 member_access_projection。channel_directory、identity_delivery 与 Channel 全部表随 T2 增加，不提前实现空壳聊天层。

## 8. 刷新、退出、撤销

- 手机安全存储与 CLI 凭证存储按实例、Client ID、user_id 隔离；同一会话刷新串行，并原子替换返回的新 refresh token。
- 网络错误/临时服务错误只进入待重试状态；明确失效后才重新登录，不把断网当作撤销。[WorkOS Session resilience](https://workos.com/docs/authkit/session-resilience)
- 退出清理本机 token/cache；通过受验证的当前 sid 请求撤销自己的 WorkOS session，或走官方登出流程。远程撤销失败需明确“本机已退出，服务端撤销未确认”；不会撤销同用户其他设备会话。
- Worker 使用部署时可信 issuer/JWKS/Client ID 规则验签，不能相信请求方提供的验证地址。详细 claims 以实际 WorkOS 环境为准，不能假设所有 token 都有同样的 aud 字段。
- 验签不意味着实时查到撤销。签名事件入 D1，补漏/重试更新 Org DO 权限投影。T1 测量失效窗口，组织管理等敏感操作以权威状态确认，无法确认时暂拒绝；T2 再覆盖现有 WebSocket 撤权。事件机制依据 [WorkOS Events](https://workos.com/docs/events)。

## 9. T1 验收与后续确认

一次现场验收应能完成：新环境部署并初始化 → 无 Host 手机选择已核验实例 → 系统浏览器登录回 App → 创建组织 → CLI 独立登录看到同一组织 → 两边刷新/重启 → 切换第二个测试组织 → 退出一端不退出另一端 → 删除成员/撤销会话后请求被拒绝。

附带验收条件：

- 未核验地址、冒用其他实例 Client ID、核验后的配置漂移，在启动认证/token 发送前被拒绝；手机与 CLI 一致。部署者核验记录来自独立控制面，不来自被测实例自述。
- 未初始化实例、无 active 管理员资格的有效 WorkOS 用户、仅有组织 owner/member 资格的用户都不能进入业务或建组织；移除管理员资格后不能继续靠缓存进入。
- owner 缺失、角色配置错误时 doctor 报告并阻止建组织；不能静默降级或扩大 member 权限。
- 管理员创建自己的组织后持有 active owner membership；仍不能访问自己无 membership 的其他组织。
- 正式/开发 OAuth 回调精确匹配；旧导航回调、错误 state、过期/重放回调不能完成登录。
- 其他 WorkOS 环境 token 被拒绝；操作重试不重复建组织；身份事件重复/乱序/暂失不恢复已撤权限。

目前仅核对文档、现有配置及任务，未完成任何新运行时集成。实际待证据项：WorkOS staging 原生 PKCE、CLI 授权、公共客户端刷新/组织切换、JWT claims、事件覆盖/时延、WorkOS 创建资源幂等与本项目 Drizzle 迁移。部署/真机 QA 在获准启动后执行。

已认可的设计方向：采用以上仓库边界；T1 仅 Worker + D1 + Org DO；手机 PKCE、CLI device flow；同一实例的一个 WorkOS application；首个管理员由部署者绑定明确 user_id。T1 仅已核验实例、active 初始化管理员准入与建组织；固定 owner/member 和独立 OAuth 回调。未新增机制，确认设计不等于启动实施。

审查修订依据：[WorkOS roles](https://workos.com/docs/authkit/roles-and-permissions)、[RFC 8252 §7.1](https://www.rfc-editor.org/rfc/rfc8252.html#section-7.1)、[RFC 9700 §4.9.1](https://www.rfc-editor.org/rfc/rfc9700.html#section-4.9.1)。本次仅更新方案；实现、部署和真机验证尚未开始。
