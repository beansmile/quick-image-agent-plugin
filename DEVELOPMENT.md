# 开发指南

本文面向 Quick Image Agent Plugin 的维护者，介绍本地构建、宿主调试、架构契约和发布校验。普通用户请阅读 [README.md](README.md)。

[https://github.com/beansmile/quick-image-agent-plugin.git](https://github.com/beansmile/quick-image-agent-plugin.git)

## 架构与能力边界

Quick Image Agent Plugin 为 Codex、WorkBuddy、OpenClaw 等 Agent 宿主提供同一份生成 Skill 与远程 Quick Image MCP 连接。独立版本的 `quick-image-agent-runtime` 同时导出 stdio MCP 入口和核心 API：Codex、WorkBuddy 等通用 MCP 宿主启动 stdio MCP，OpenClaw 原生适配器直接导入核心 API。各宿主因此复用完全相同的附件处理、估价和上传实现；Runtime 版本与 Plugin 版本仍独立发布。

- 插件支持搭配出图、换姿、高清和视频生成。
- 生成前通过远程 MCP 获取公开配置并在本地预估报价，用户确认后才上传。
- 服务端负责鉴权、素材归属、最终校验、最终计价、扣费、幂等和任务状态。
- 本地工具负责附件检查、准备、能力专用估价与暂存上传。媒体默认按不透明输入处理；检查阶段只读取基础文件信息和限制校验所需的技术元数据，保存路径、文件身份、校验和和媒体元数据，不做语义内容分析或复制附件字节。
- 所有本地工具均不接受 Base64 或 Token。报价不上传、不扣费且不锁价。
- 插件不提供 Quick Image 云端图库浏览、任务取消、结果删除或充值工具；用户可以直接提供已知的 `asset_id`，由服务端校验归属和可用性。可按服务端 `retryable` 和 `retry_after` 处理当前请求的重试，不创建独立的重试任务。

共享 Skill 的 `SKILL.md` 只保留核心生命周期、安全不变式和阶段路由；鉴权、附件、报价提交、结果轮询分别位于 `skills/quick-image/references/`，仅在进入对应阶段时读取，以减少不相关任务的上下文消耗。

## 构建环境

- Node.js 20 或更高版本。
- pnpm 10。
- macOS、Linux 或 Windows WSL2；WSL2 是 Windows 的主要兼容目标，原生 Windows 会尝试兼容但不作完整兼容保证。

```bash
pnpm install --frozen-lockfile
pnpm check
```

Plugin 与 Runtime 均发布到 npm Registry（Plugin 供 OpenClaw 以 npm spec 安装与更新，Runtime 是 Plugin 的固定版本依赖）。Plugin 发布包由 CI 在干净检出中构建和校验；Plugin 依赖与 Codex、WorkBuddy、通用 Agent Plugin 清单固定同一个 `quick-image-agent-runtime` npm Registry 版本（`quick-image-agent-runtime@x.y.z`），不跟随浮动分支或 `latest`。文档与共享 Skill 中供人或 Agent 执行的 Runtime 命令统一使用 `quick-image-agent-runtime@latest`：registry 包名 spec 会被 npx 按版本正确解析与缓存，自动追新且不存在浮动 URL 复用旧缓存的问题。Runtime 的 GitHub Release tgz 由同一 CI 产出，作为 npm 渠道之外的备份地址。Codex、WorkBuddy 等宿主通过 `npx` 首次启动 Runtime 时、OpenClaw 安装 Plugin 依赖时，都只安装当前平台所需的原生依赖。不要从未审核的工作区直接发布。

## 环境配置

仓库中的正式清单始终使用以下正式地址：

- Server：`https://quickimage.ai/mcp`
- Frontend：`https://quickimage.ai`

Plugin MCP 清单始终提供正式默认地址。本地调试安装通过隔离 Overlay 使用开发地址；维护者需要显式切换已安装宿主时，统一执行 `quick-image-agent-runtime@latest` 中的 `quick-image` CLI。当前 `--host` 支持 `codex`、`openclaw` 和 `workbuddy`（Runtime 0.3.0 起提供 workbuddy）；WorkBuddy 通过改写插件安装目录内的 MCP 清单切换环境，需逐个宿主执行。地址只由命令调用者传入，不写入 Plugin 或 Runtime 源码：

```bash
npx --yes --prefer-online \
  --package quick-image-agent-runtime@latest \
  quick-image env set \
  --host <codex|openclaw|workbuddy> \
  --server-url https://<server>/mcp \
  --frontend-url https://<frontend>
```

查看当前实际生效的配置或恢复正式默认配置时，使用同一个 Runtime 包和 npx 前缀：

```bash
npx --yes --prefer-online \
  --package quick-image-agent-runtime@latest \
  quick-image env status --host <codex|openclaw|workbuddy>

npx --yes --prefer-online \
  --package quick-image-agent-runtime@latest \
  quick-image env reset --host <codex|openclaw|workbuddy>
```

## Codex 本地调试

Codex 使用 `.codex-plugin/plugin.json`，安装后由宿主管理 Quick Image OAuth，并通过 `http_headers` 发送插件版本。

```bash
pnpm dev:install:codex
```

`pnpm dev:install:codex` 会完成以下操作：

1. 构建源码。
2. 生成隔离的 `quick-image-local` Marketplace，并将其 Plugin MCP 清单写为本地 Server 和 Frontend URL。
3. 通过官方 `codex plugin marketplace add` 与 `codex plugin add` 安装或刷新插件。
4. 校验 Codex 实际加载的 Server 为 `http://127.0.0.1:3000/mcp`，Frontend 为 `http://127.0.0.1:8001`。

隔离副本保留正式清单固定的 Agent Runtime npm 版本，并通过 cachebuster 避免复用旧 Plugin 缓存；正式清单不会被修改。需要调试本地 MCP 时，在平级 `quick-image-agent-runtime` 仓库独立运行和验证。脚本会自动寻找 `PATH` 或 macOS ChatGPT/Codex 应用包内的 CLI，自定义安装位置可通过 `CODEX_CLI_PATH=/path/to/codex` 指定。

每次修改后重新运行同一命令，然后执行：

```bash
codex mcp login quick-image
```

完成授权后新建 Codex 任务，以加载最新 Skill 和 MCP 工具。本地安装只更新隔离 Plugin Overlay 和 Codex 插件缓存，不写入用户级 MCP 配置；若已有同名用户级 MCP 配置覆盖 Overlay，安装脚本会提示先通过 Codex 官方命令移除冲突。

Codex 在远程 MCP 返回未授权或授权失效时，应先告知用户当前未登录并询问是否需要登录；用户确认后，由 Codex Agent 通过终端执行固定命令触发 OAuth：

```bash
codex mcp login quick-image
```

浏览器授权完成后新建 Codex 任务；桌面端仍未加载远程工具时，完全退出并重新打开 Codex。若 Agent 无法执行终端命令，可让维护者在本机终端执行同一条命令。若命令提示找不到 MCP，先重新安装或启用 Plugin，再重试登录。不要把 Token、授权码或终端输出放入对话或日志。

Codex CLI 当前没有 `mcp doctor` 或 `mcp probe` 子命令。连接失败时可执行 `codex mcp get quick-image` 确认 MCP 已登记，但该命令不验证 OAuth 凭据；未登记时先重新安装或启用 Plugin，已登记且宿主没有明确网络错误时，仍以宿主 OAuth 错误或授权流程判断是否需要登录。

## WorkBuddy 本地调试（占位）

WorkBuddy 的本地调试与测试环境设置方式待补充（占位）。WorkBuddy 与 Codex 复用同一套插件能力，仓库同时携带两份 WorkBuddy manifest：`.codebuddy-plugin/plugin.json` 通过 `./mcp.json` 声明同一套 Quick Image MCP（远程 `quick-image` 和本地 `quick-image-local`），未声明 `skills` 字段；`.workbuddy-plugin/plugin.json` 与 Codex manifest 同形（`skills: ./skills/`、`mcpServers: ./.mcp.json`）。WorkBuddy 实际读取哪一份以及 Skill 的发现与加载方式待补充。本地调试目标与 Codex 一致——构建源码后，让 WorkBuddy 实际加载本地构建产物，并将远程 MCP 指向本地 Server 和 Frontend。具体的安装/刷新命令、插件目录、隔离 Overlay 与配置写入方式确定后在此补充；在此之前不要为 WorkBuddy 编写修改宿主配置的安装脚本。

## OpenClaw 本地调试

OpenClaw 只需安装根目录的 `quick-image` 原生插件。原生适配器直接调用 Plugin 固定版本的 `quick-image-agent-runtime` 核心 API，统一提供附件检查、处理、上传和确定性估价，并由 Plugin 自身提供 Skill 与可信结果发送；不需要再安装或登记 `quick-image-local` 本地 MCP。

限制型工具 profile 不会自动开放第三方原生工具。首次安装前需要按插件 ID 授权 Quick Image 的全部原生工具：

```bash
openclaw config set tools.alsoAllow '["quick-image"]' --strict-json
pnpm dev:install:openclaw
```

本地安装命令会构建源码，执行 `openclaw plugins install . --force` 并启用插件，然后调用 `openclaw quick-image env set` 切换到本地 Server 和 Frontend。该命令由 Plugin 转发给已安装的 `quick-image-agent-runtime` CLI，Runtime 内部负责 `mcp set` 和 `mcp reload`。安装命令不会修改 `tools.allow`、`tools.alsoAllow` 或 `tools.deny`。

安装后使用 `quick-image-agent-runtime@latest` 管理 OpenClaw URL，Plugin 原生命令只保留正式安装所需的 `setup`：

```bash
npx --yes --prefer-online \
  --package quick-image-agent-runtime@latest \
  quick-image env set \
  --host openclaw \
  --server-url https://<server>/mcp \
  --frontend-url https://<frontend>
```

`status/reset` 使用相同的 Runtime 包和 npx 前缀：

```bash
npx --yes --prefer-online \
  --package quick-image-agent-runtime@latest \
  quick-image env status --host openclaw

npx --yes --prefer-online \
  --package quick-image-agent-runtime@latest \
  quick-image env reset --host openclaw
```

正式环境安装使用 `openclaw quick-image setup`。该命令合并 `tools.alsoAllow`、使用正式环境配置覆盖同名 MCP，并在基础配置成功后执行 `mcp reload`。安装或更新完成后仍需执行 `openclaw gateway restart`，以加载新安装的 Plugin；Gateway 恢复后再继续远程授权流程。`setup` 不会在进程内启动 OAuth，而是在完成后输出登录命令。

会话内查不到远程工具时，Agent 应先提醒用户发送 `/reset` 重置会话上下文并等用户重新发起请求（安装流程的 Gateway 重启和 `mcp reload` 都不会刷新已开始的会话，未重置是最常见原因），不要替用户执行。远程工具调用失败，或重置后仍查不到工具时，执行 `openclaw mcp doctor --probe quick-image --json` 做连接与 OAuth 探测。输出 `requires OAuth authorization`、`OAuth credentials are not authorized`、OAuth 原因的 `probe failed` 等信号时，应将其视为当前未登录/授权失效，即使业务工具尚未被调用；输出 DNS、超时、连接拒绝等明确网络错误时，按连接故障处理；没有 `quick-image` server 时，先执行 `openclaw mcp reload` 重载后再次探测，仍没有时先重新安装或启用插件（仅当新装或更新后从未重启过 Gateway 时才先重启）。Agent 确认未登录后，应先告知用户并询问是否需要登录；用户确认后，执行第一条命令并把授权链接发给用户，同时提醒用户不要泄露授权码或在非私聊会话中发送。用户在手机浏览器批准后，只把一次性授权码发回；Agent 校验其为单个安全 code 后，将其作为 `--code` 的单个参数执行第二条命令。登录成功后无需重启 Gateway；Agent 应提示用户在当前对话中发送 `/reset` 重置会话上下文，不要替用户执行。无法安全执行固定命令时，回退为用户手动执行：

```bash
openclaw mcp login quick-image
openclaw mcp login quick-image --code '<code>'
```

Agent 不以 owner 验证或会话类型作为远程授权前置条件，但必须提醒用户不要泄露一次性 code 或在非私聊会话中发送；不允许 Agent 接受完整命令或其他 Shell 内容，Token 始终由 OpenClaw OAuth 存储管理且不得进入对话。执行带授权码的登录命令后无需重启 Gateway；应建议用户发送 `/reset`，避免安装和登录过程的上下文影响后续 Quick Image 任务。`openclaw mcp probe quick-image` 用于连接与授权状态排查，不用于业务流程。

## OpenClaw 适配契约

OpenClaw 原生 manifest 不负责导入 MCP 配置。正式安装流程必须登记唯一的远程 MCP，并在安装或更新完成后重启 Gateway 以加载新安装的 Plugin；完成登录后无需再次重启。

Runtime 包不提供独立的安装诊断命令；安装验证依赖宿主自身的连接与授权探测。Quick Image 不注册会话内容 Hook 或 owner 专属 Trusted Tool Policy，也不在原生运行时额外限制私聊或群聊。共享 Skill 要求 Agent 根据当前会话上下文仅执行 owner 发出的 Quick Image 生成指令，但远程授权流程不以 owner 验证或会话类型作为前置条件，只负责提示 code 保密。这些都属于模型行为约束，不构成原生运行时安全边界。实际访问范围仍由 OpenClaw 自身的渠道访问策略和工具策略决定；原生工具是否被当前工具策略开放，由用户按共享 Skill 的宿主故障处理说明检查插件安装、启用与 `tools.alsoAllow` 配置。

内置适配层使用 `message_received` 登记入站媒体，并通过 `quick_image_list_attachments` 返回不含路径的附件 ID。`quick_image_send_preview` 只向当前会话的可信路由发送 Quick Image 预览，不接受任意渠道、收件人或消息正文。通用 `message` 工具不属于 Quick Image 所需权限。

Quick Image 结果 URL 是无扩展名的对象存储 key，部分渠道（如飞书）的媒体投递依赖文件扩展名或下载时的 Content-Type 区分图片/视频消息与文件消息，且渠道适配器从部署机抓取远程媒体容易失败。因此图片预览采用本地优先投递：`quick_image_send_preview` 把 `display_url` 交给 Runtime 的 `PreviewDownloadService` 受约束下载（仅 HTTPS、拒绝重定向、60s 超时、50MB 上限、magic bytes 只接受 JPEG/PNG/WebP；不做下载域名允许列表和 DNS 私网解析防护，以兼容自建/内网部署的服务端）到私有缓存目录 `<state>/preview-cache`，再以本地绝对路径经 `mediaUrl` 投递；`fileName` 的扩展名以本地检测出的格式为准，任务结果返回的 `preview_content_type`（预览投递内容的 MIME；源文件类型另由 `content_type` 字段提供，仅用于下载场景）仅作参考。缓存以 `sha256(display_url)` 为键复用，不做时间过期清理，仅在目录 ≥ 200MB 时按 mtime 从旧到新淘汰；缓存清理由 Runtime 服务在启动和每次保存后自触发，Plugin 不挂额外定时器、不自行删除缓存文件。成功结果带 `delivered_via: "local_file"`。视频没有独立预览变体，维持远程 URL 投递，用 `preview_content_type`（与源类型一致，`video/mp4`）映射带扩展名的 `fileName`，不触发本地下载。Codex 等仅 Markdown 宿主经 `quick-image-local` 本地 MCP 的 `download_preview_media({ display_url })` 走同一 Runtime 下载服务：成功返回本地绝对路径、magic bytes 检测格式与字节数，Agent 在同一回合内用该路径嵌入 Markdown 图片并紧跟原图下载链接。

图片预览下载失败或本地发送失败时不回退远程 URL 投递，OpenClaw 的 `quick_image_send_preview` 与 Codex 的 `download_preview_media` 语义一致：工具返回 `isError`，OpenClaw 收敛为稳定错误码 `PREVIEW_DOWNLOAD_FAILED` / `PREVIEW_SEND_FAILED`，Codex 透传 Runtime 的稳定错误码（`PREVIEW_URL_REJECTED`、`PREVIEW_DOWNLOAD_TIMEOUT`、`PREVIEW_DOWNLOAD_INVALID_MEDIA` 等），`suggested_action` 均指示 Agent 直接发送原图链接文本，不重试、不退回 Markdown 图片。路由缺失、渠道适配器加载失败（`loadAdapter` 返回空）和参数无效仍按原语义抛出；已加载的适配器既不支持 `sendMedia` 也不支持 `sendPayload` 属于投递阶段失败，图片路径收敛为 `PREVIEW_SEND_FAILED` 的 `isError` 结果，视频路径维持抛出。

### 轮询契约

OpenClaw 提交成功后创建一个每 30 秒运行的 `isolated agentTurn` recurring cron，仅允许调用 `quick-image__get_generation_tasks`、`quick_image_send_preview` 和 `cron`。任务仍在处理时静默返回 `NO_REPLY`；进入终态、查询不到任务或达到等待上限时发送结果并删除自身。cron 创建成功后需向用户补发固定提示`已转入后台监控，你可以继续和我对话，任务完成后我会自动发送结果。`作为执行路径的排查标记；cron 的 `delivery` 使用 `announce` 路由，能从当前会话上下文取得实际 `channel` 与 `to` 时必须写入实际值，取不到时只保留 `mode`，由宿主保留的会话路由推断投递目标。

不得使用 `main + systemEvent`、一次性 cron、heartbeat 或 `sessions_yield` 代替轮询，也不得在当前 turn 内循环 `sleep` 阻塞会话。cron 创建失败时回退为后台计时器等待：`exec` 以 `background: true` 后台执行 `sleep 30; echo quick-image-timer` 后立即结束回合，命令产生输出或失败时由宿主完成唤醒，Agent 被唤醒后继续轮询，未到终态时静默续挂计时器；子代理会话没有后台完成唤醒，不得使用该回退。其他宿主的轮询间隔同样为 30 秒。

## 附件适配契约

宿主或 AI 可以根据用户意图解析路径、浏览目录或搜索文件，并将确定的本地文件绝对路径或 Runtime 支持的媒体引用传给 Quick Image 本地工具。插件信任调用方提供的具体输入，不校验来源或另行实施目录授权；实际可读范围由宿主进程的系统文件权限和 Runtime 的引用解析规则决定。OpenClaw 原生适配层仍从 `message_received` 获取会话媒体路径，持久化为与会话绑定的附件 ID，供模型发现和引用当前会话附件；已知的 `media://` 引用也可以直接传入。`quick_image_list_attachments` 默认返回当前会话最近 10 个候选并按上传时间从旧到新排列，同时用 `has_more` 和 `next_cursor` 分页读取更早候选。模型根据用户意图选定文件后，再将绝对路径、媒体引用或对应 ID 交给 Quick Image 本地工具。

附件检查会校验普通文件、真实媒体格式、大小和时长，计算 SHA-256，并在权限为 `0700/0600` 的私有状态区记录路径、文件身份和媒体元数据；默认不进行图片、音频或视频语义分析，也不会保存附件字节。这里的校验和读取仅用于完整性校验，不代表内容分析。用户确认报价后，Codex 的 `prepare_attachment` 或 OpenClaw 的 `quick_image_prepare_attachment` 使用一次性 `attachment_handle` 重新读取原文件并比对身份与校验和，图片此时才使用 `sharp` 自动旋转、缩放和压缩，最终字节写入私有暂存区。所有返回值都不包含原始路径。

OpenClaw 附件发现索引不复用处理句柄的 TTL，在源文件仍可读取期间保留，并将每个 session 限制为最近 500 条；OpenClaw 配置 `media.ttlHours` 后，宿主删除过期源文件，索引会在下次列表或每 10 分钟的定时清理中同步移除。检查记录和暂存记录仍默认有效 24 小时。成功准备会消费检查记录，成功上传会删除暂存文件；进程启动时再执行一次兜底清理。原文件在报价后变化、删除或不可读取时必须重新检查并重新报价。

## 上传域名

默认仅允许 `quickimage.ai`、其子域名和阿里云 `*.aliyuncs.com` 子域名。若发布版本使用额外的公开直传域名，由官方安装配置提供逗号分隔允许列表：

```bash
QUICK_IMAGE_UPLOAD_HOSTS=<official-upload-host>,*.<official-upload-host>
```

共享本地处理核心仍会拒绝 HTTP、URL 凭据、非 443 端口、私有网络解析、非法请求头和重定向。

## 开发与发布校验

发布新的 Runtime 后，执行以下命令同步三处版本号（`package.json` 依赖与两份 MCP 清单）并更新锁文件与 `node_modules`，使本地校验运行在新版 Runtime 上。文档命令统一使用 `quick-image-agent-runtime@latest`，不含版本号，无需同步。Plugin 和 Runtime 均只允许使用 `major.minor.patch` 格式的稳定版本，不允许 prerelease：

```bash
pnpm runtime:set <major>.<minor>.<patch>
pnpm install
```

发布新的 Plugin 版本时，用一个命令同步 Plugin manifest 和两份 MCP 清单中的版本 header：

```bash
pnpm plugin:set <major>.<minor>.<patch>
```

例如：

```bash
pnpm plugin:set 0.1.3
```

Runtime 版本必须已发布到 npm Registry，才能更新并提交 Plugin 锁文件（GitHub Release tgz 由 Runtime CI 同步产出，作为备份地址）。未发布的源码只能用于本地联调。正式 Plugin 配置不得引用 staging Runtime；合并前应将 Runtime 更新为稳定版本并重新生成锁文件。随后执行完整校验：

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm validate
pnpm --dir ../quick-image-agent-runtime mcp:smoke
pnpm pack:check
```

外部贡献政策见 [CONTRIBUTING.md](CONTRIBUTING.md)。
