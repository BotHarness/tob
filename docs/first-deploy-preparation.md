# TOB 首次部署：人工准备向导

这是一个可运行的**本机准备脚本**，不是 TOB 安装器。T1 自动部署尚未实现。本脚本不会访问网络、调用 Cloudflare / WorkOS、打开网页、发邀请或部署。

## 运行

克隆 TOB 后，在仓库根目录的交互终端执行（不要把密钥作为参数，也不要把输出重定向到日志）：

```bash
bash scripts/prepare-first-deploy.sh tob-staging
```

查看说明：

```bash
bash scripts/prepare-first-deploy.sh --help
```

需要 Bash 与 Git；支持 macOS / Linux / WSL 的用户主目录。不要在其他人的共享系统账户下保存秘密。

## 四步与输出

| 步骤 | Human 操作 | 本机输出 |
| --- | --- | --- |
| 1. 账号准备 | 点击文本中的 Cloudflare / WorkOS URL，自行注册或登录 | 无；不收集登录凭证，也不宣称 CLI/MCP 已授权 |
| 2. 确认目标 | 复制 Cloudflare Account ID，填写 WorkOS Team / Project 名称，确认 Staging | `deployment.env`：CLOUDFLARE_ACCOUNT_ID、两个 WorkOS 名称、固定 staging 和准备状态；归属/权限仍待 Agent 核验 |
| 3. 安全交付 API key | 在 WorkOS 目标环境的 API Keys 页面取得环境 key，在终端隐藏输入 | `secrets.env`：仅 `WORKOS_API_KEY`；不包含 Webhook secret |
| 4. 交接 | 将两个文件路径交给同机部署 Agent | 输出后续步骤；不自动启动尚未实现的部署逻辑 |

固定保存位置：`~/.config/tob/first-deploy/<profile>/`。目录权限 0700、文件 0600；脚本拒绝符号链接和 Git 仓库内存储。公开目标与秘密分文件保存，不创建或覆盖项目 `.env`，不将文件作为 shell 脚本 source。

保存状态 `inputs_saved_unverified` 只表示本机输入完整。Account ID 格式和 WorkOS 名称不证明控制面归属，API key 格式检查不证明有效性；待后续工具核对明确的 account / environment / application ID。`secrets.env` 尚不完整，不直接用于部署。

## Cloudflare Account ID 从哪里找

1. 点击 https://dash.cloudflare.com/ 并选择要部署的账号。
2. 按 `⌘K`（Windows/Linux 为 `Ctrl+K`），搜索 **Copy account ID** 并复制；也可到 **Workers & Pages → Account Details → Account ID** 复制。
3. 在向导中粘贴 32 位 Account ID。账号页面 URL 通常为 `https://dash.cloudflare.com/<ACCOUNT_ID>/...`，只复制 ID 段，不粘贴整个 URL。

这里不填邮箱、账号名称、Zone ID 或 API token。向导只验证 32 位十六进制格式并统一为小写；Zone ID 也可能符合该格式，仍须后续已授权控制面核验账号归属与权限，不能因格式通过就部署。

旧版 profile 只有 CLOUDFLARE_ACCOUNT_HINT 时，会显示旧名称并要求确认仍为同一账号，再补充 ID；不自动把名称转换成 ID，也不修改已有秘密。已保存 ID 不允许换绑；改目标使用新 profile。

依据：[Cloudflare 官方查找说明](https://developers.cloudflare.com/fundamentals/account/find-account-and-zone-ids/)。

## 中断重跑

- Ctrl-C 后用相同 profile 重跑；已保存目标可按 Enter 保留，API key 默认复用，不回显、不替换、不轮换。
- 同一 profile 不允许更换已保存的目标字段；换环境用新 profile，避免旧 key 被顺手带入新环境。
- 已有秘密却丢失目标记录时停止，先核对原环境；不能把旧文件直接关联新环境。
- 只运行一个相同 profile 的向导。异常强制终止留下锁目录时，先确认旧进程已退出，再移除提示的空锁目录。普通退出自动解锁。
- 修改凭证、取消已有凭证或迁移环境是独立操作，不由本向导普通重试处理。
- 关闭 shell tracing；值不放外部命令参数、普通输出、GitHub、二维码或模型上下文。普通配置和秘密均留本机；不要把文件内容发给 Agent 对话。

## 后续部署工具接棒

人需要完成供应商 OAuth / MFA；本向导只显示链接，不会暗中启动自动开浏览器的登录命令。Agent 查询并核验实际资源 ID，工具在本机读取 API key，通过官方 API 创建/复用 Webhook，把签名秘密直接安全落盘，再通过 Cloudflare cf 注入并部署。失败时按 T1 的资源/版本读回规则恢复，不盲目重建或轮换。

[WorkOS API key 官方说明](https://workos.com/docs/reference/api-authentication) · [T1 方案](https://github.com/BotHarness/tob/blob/main/docs/t1-design.md) · [T1 任务](https://github.com/BotHarness/tob/issues/2)

## 校验边界

仅进行 Bash 语法与静态检查；技能模板 STAGES 之前保持逐字一致，四步均不调用 `open_url`。未运行交互全流程，未输入真实密钥，未验证云端授权或部署。机器当前未安装 shellcheck，未执行该检查。

本向导是独立交付的人工准备工具。T1–T5 保持 ready-for-human；此脚本发布不授权自动部署、服务实现或任何云配置写入。
