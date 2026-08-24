# 开发指南

本文面向 Quick Image Agent Plugin 的维护者，介绍本地构建、宿主调试、架构契约和发布校验。普通用户请阅读 [README.md](README.md)。

[https://github.com/beansmile/quick-image-agent-plugin.git](https://github.com/beansmile/quick-image-agent-plugin.git)

## 架构与能力边界

Quick Image Agent Plugin 为 Codex 和 OpenClaw 提供同一份生成 Skill 与远程 Quick Image MCP 连接。独立版本的 `quick-image-agent-runtime` 同时导出 stdio MCP 入口和核心 API：Codex 启动 stdio MCP，OpenClaw 原生适配器直接导入核心 API。两端因此复用完全相同的附件处理、估价和上传实现；Runtime 版本与 Plugin 版本仍独立发布。

- 插件支持搭配出图、换姿、高清和视频生成。
- 生成前通过远程 MCP 获取公开配置并在本地预估报价，用户确认后才上传。
- 服务端负责鉴权、素材归属、最终校验、最终计价、扣费、幂等和任务状态。
- 本地工具负责附件检查、准备、能力专用估价与暂存上传。检查阶段只保存路径、文件身份、校验和和媒体元数据，不复制附件字节。
- 所有本地工具均不接受 Base64 或 Token。报价不上传、不扣费且不锁价。
- 插件不提供图库浏览、任务取消、业务重试、结果删除或充值工具。

## 构建环境

- Node.js 20 或更高版本。
- pnpm 10。
- macOS、Linux 或 Windows WSL2；暂不支持原生 Windows。

```bash
pnpm install --frozen-lockfile
pnpm check
```

本项目不发布到 npm Registry。Plugin 发布包由 CI 在干净检出中构建和校验；Plugin 依赖与 Codex、通用 Agent Plugin 清单固定同一个 `quick-image-agent-runtime` GitHub Release tgz，不跟随浮动分支或 `latest`。Codex 通过 `npx` 首次启动 Runtime 时、OpenClaw 安装 Plugin 依赖时，都只安装当前平台所需的原生依赖。不要从未审核的工作区直接发布。

## 环境配置

仓库中的正式清单始终使用以下正式地址：

- Server：`https://quickimage.ai/mcp`
- Frontend：`https://quickimage.ai`

插件安装后可显式覆盖 Server 和 Frontend URL。仓库不保存环境名称，也不会根据 Git 分支自动切换服务；分支只决定安装的代码版本。`dev:install:*` 是唯一例外，它会在本地安装完成后调用同一个 `env set` 命令切换到开发地址：

```bash
pnpm quick-image -- env set \
  --host all \
  --server-url https://<server>/mcp \
  --frontend-url https://<frontend>
```

从 GitHub 分支安装时，可直接运行包内 CLI：

```bash
npx --yes \
  --package git+https://github.com/beansmile/quick-image-agent-plugin.git#<ref> \
  quick-image env set \
  --host all \
  --server-url https://<server>/mcp \
  --frontend-url https://<frontend>
```

查看当前实际生效的宿主配置或清除自定义覆盖：

```bash
pnpm quick-image -- env status --host codex
pnpm quick-image -- env reset --host codex
```

GitHub 安装场景下，`status` 和 `reset` 使用与上方 `set` 相同的 `npx --package ... quick-image` 前缀。

`env reset` 不保存环境文件：Codex 删除 Quick Image 管理的用户级 MCP 覆盖并回退到插件正式清单，OpenClaw 重新写入正式地址。Server 路径必须是 `/mcp`；远程地址必须使用 HTTPS，仅 loopback 本地调试允许 HTTP。修改 URL 后需按命令输出重新完成 OAuth。

## Codex 本地调试

Codex 使用 `.codex-plugin/plugin.json`，安装后由宿主管理 Quick Image OAuth，并通过 `http_headers` 发送插件版本。

```bash
pnpm dev:install:codex
```

如果插件已经安装，需要将所有受支持宿主统一切换到本地 Server 和 Frontend，可执行：

```bash
pnpm quick-image -- env set \
  --host all \
  --server-url http://127.0.0.1:3000/mcp \
  --frontend-url http://127.0.0.1:8001
```

`pnpm dev:install:codex` 会完成以下操作：

1. 构建源码。
2. 生成隔离的 `quick-image-local` Marketplace。
3. 通过官方 `codex plugin marketplace add` 与 `codex plugin add` 安装或刷新插件。
4. 将 Server 切换为 `http://127.0.0.1:3000/mcp`，Frontend 切换为 `http://127.0.0.1:8001`。

隔离副本保留正式清单固定的 Agent Runtime Release tgz，并通过 cachebuster 避免复用旧 Plugin 缓存；正式清单不会被修改。需要调试本地 MCP 时，在平级 `quick-image-agent-runtime` 仓库独立运行和验证。脚本会自动寻找 `PATH` 或 macOS ChatGPT/Codex 应用包内的 CLI，自定义安装位置可通过 `CODEX_CLI_PATH=/path/to/codex` 指定。

每次修改后重新运行同一命令，然后执行：

```bash
codex mcp login quick-image
```

完成授权后新建 Codex 任务，以加载最新 Skill 和 MCP 工具。Codex 环境覆盖写入 `~/.codex/config.toml` 中带边界标记的 Quick Image 专属区块。CLI 不修改插件缓存；若已存在非 Quick Image 管理的同名 MCP 配置，会拒绝覆盖。

## OpenClaw 本地调试

OpenClaw 只需安装根目录的 `quick-image` 原生插件。原生适配器直接调用 Plugin 固定版本的 `quick-image-agent-runtime` 核心 API，统一提供附件检查、处理、上传和确定性估价，并由 Plugin 自身提供 Skill 与可信结果发送；不需要再安装或登记 `quick-image-local` 本地 MCP。

限制型工具 profile 不会自动开放第三方原生工具。首次安装前需要按插件 ID 授权 Quick Image 的全部原生工具：

```bash
openclaw config set tools.alsoAllow '["quick-image"]' --strict-json
pnpm dev:install:openclaw
```

本地安装命令会构建源码，执行 `openclaw plugins install --link .` 并启用插件，然后通过插件自己的 `env set` 切换到本地 Server 和 Frontend。`env set` 内部负责 `mcp set` 和 `gateway restart`。安装命令不会修改 `tools.allow`、`tools.alsoAllow` 或 `tools.deny`。

安装后可使用插件注册的 OpenClaw 原生命令管理 URL：

```bash
openclaw quick-image env set \
  --server-url https://<server>/mcp \
  --frontend-url https://<frontend>
openclaw quick-image env status
openclaw quick-image env reset
```

正式环境安装使用 `openclaw quick-image setup`。该命令合并 `tools.alsoAllow`、幂等登记正式环境 MCP，并在基础配置成功后执行 `gateway restart` 以加载配置。它不会询问或执行 OAuth 登录，而是在完成后提示用户手动运行登录命令；也不会静默覆盖自定义 MCP 地址，非交互环境会保留自定义地址。

安装命令不会自动启动 OAuth。需要授权时手动执行：

```bash
openclaw mcp login quick-image
openclaw mcp login quick-image --code '<code>'
openclaw gateway restart
```

第一条命令会打印授权链接。浏览器批准后，授权完成页会显示一次性授权码和已经填好授权码的完整命令。执行带授权码的登录命令后重启 Gateway，下一轮对话会加载报价和生成工具；`openclaw mcp probe quick-image` 仅用于连接故障排查。

## OpenClaw 适配契约

OpenClaw 原生 manifest 不负责导入 MCP 配置。正式安装流程必须登记唯一的远程 MCP，完成登录后重启 Gateway 以加载配置和凭据。

Doctor 是可选的安装验证与故障排查工具，不是插件启用前置条件。Quick Image 不注册会话内容 Hook 或 owner 专属 Trusted Tool Policy，也不额外限制私聊或群聊。共享 Skill 要求 Agent 根据当前会话上下文仅执行 owner 发出的 Quick Image 指令，但这属于模型行为约束，不构成原生运行时安全边界。实际访问范围仍由 OpenClaw 自身的渠道访问策略和工具策略决定；Doctor 只检查 Quick Image 原生工具是否被当前工具策略开放。

内置适配层使用 `message_received` 登记入站媒体，并通过 `quick_image_list_attachments` 返回不含路径的附件 ID。`quick_image_send_preview` 只向当前会话的可信路由发送 Quick Image 预览，不接受任意渠道、收件人或消息正文。通用 `message` 工具不属于 Quick Image 所需权限。

### 轮询契约

OpenClaw 提交成功后创建一个每 30 秒运行的 `isolated agentTurn` recurring cron，仅允许调用 `quick-image__get_generation_tasks`、`quick_image_send_preview` 和 `cron`。任务仍在处理时静默返回 `NO_REPLY`；进入终态、查询不到任务或达到等待上限时发送结果并删除自身。

不得使用 `main + systemEvent`、一次性 cron、heartbeat 或 `sessions_yield` 代替轮询；cron 创建失败时才回退到当前 turn 内 `sleep 30` 后查询。其他宿主的轮询间隔同样为 30 秒。

## 附件适配契约

Codex 通过 `inspect_attachment` 检查当前对话明确提供的绝对路径，并将该工具设为逐次审批。OpenClaw 原生适配层从 `message_received` 获取宿主可信的媒体路径，持久化为会话附件 ID；`quick_image_list_attachments` 默认返回当前会话最近 10 个候选并按上传时间从旧到新排列，同时用 `has_more` 标识是否还有更早候选。模型根据对话语境选定后再将对应 ID 交给 `quick_image_inspect_attachment`，不会接触本地路径或历史 `media://` 引用。

附件检查会校验普通文件、真实媒体格式、大小和时长，计算 SHA-256，并在权限为 `0700/0600` 的私有状态区记录路径、文件身份和媒体元数据；不会保存附件字节。用户确认报价后，Codex 的 `prepare_attachment` 或 OpenClaw 的 `quick_image_prepare_attachment` 使用一次性 `attachment_handle` 重新读取原文件并比对身份与校验和，图片此时才使用 `sharp` 自动旋转、缩放和压缩，最终字节写入私有暂存区。所有返回值都不包含原始路径。

检查记录、OpenClaw 附件引用和暂存记录默认有效 24 小时。成功准备会消费检查记录，成功上传会删除暂存文件；后台每 10 分钟清理过期句柄，进程启动时再执行一次兜底清理。原文件在报价后变化、删除或不可读取时必须重新检查并重新报价。

## 上传域名

默认仅允许 `quickimage.ai`、其子域名和阿里云 `*.aliyuncs.com` 子域名。若发布版本使用额外的公开直传域名，由官方安装配置提供逗号分隔允许列表：

```bash
QUICK_IMAGE_UPLOAD_HOSTS=<official-upload-host>,*.<official-upload-host>
```

共享本地处理核心仍会拒绝 HTTP、URL 凭据、非 443 端口、私有网络解析、非法请求头和重定向。

## 开发与发布校验

发布新的 Runtime 后，用一个命令同步 Plugin 依赖和两份 MCP 清单中的 Runtime Release tgz。正式环境使用稳定版本；staging 可使用 `v0.2.0-rc.1` 这类 GitHub Prerelease：

```bash
pnpm runtime:set v<major>.<minor>.<patch>[-<prerelease>]
pnpm install --lockfile-only
```

Runtime tag 和对应的 GitHub Release tgz 必须已发布，才能更新并提交 Plugin 锁文件。未发布到可访问地址的源码只能用于本地联调。正式 Plugin 配置不得引用 staging Runtime；合并前应将 Runtime 更新为稳定版本并重新生成锁文件。随后执行完整校验：

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm validate
pnpm --dir ../quick-image-agent-runtime mcp:smoke
pnpm pack:check
```

外部贡献政策见 [CONTRIBUTING.md](CONTRIBUTING.md)。
