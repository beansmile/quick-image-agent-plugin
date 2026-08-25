---
name: quick-image
description: 使用 Quick Image 对当前对话附件执行搭配出图、换姿、高清或视频生成。用户要求基于图片、视频或音频生成内容、查询 Quick Image 任务或查看生成结果时使用；必须先读取公开配置并本地预估报价，确认后再执行安全附件上传、幂等提交和限速轮询流程。
---

# Quick Image 生成

严格按顺序执行。本地配置报价只用于用户确认和体验；服务端是素材归属、参数、最终价格、余额、扣费、幂等和任务状态的唯一权威来源。

## 0. 工具发现与鉴权

- MCP 工具可能按需加载，不出现在初始静态工具列表中。开始业务流程前，先使用宿主的工具发现能力按名称查找远程工具和本地工具。
- 远程工具：`get_generation_config`、`create_direct_upload`、`submit_lookbook_task`、`submit_pose_task`、`submit_upscale_task`、`submit_video_task`、`list_generation_tasks`、`get_generation_tasks`。
- Codex 本地 MCP 工具：`inspect_attachment`、`prepare_attachment`、`estimate_lookbook_credits`、`estimate_pose_credits`、`estimate_upscale_credits`、`estimate_video_credits`、`upload_staged_attachment`。
- OpenClaw 原生工具：`quick_image_list_attachments`、`quick_image_inspect_attachment`、`quick_image_prepare_attachment`、`quick_image_estimate_lookbook_credits`、`quick_image_estimate_pose_credits`、`quick_image_estimate_upscale_credits`、`quick_image_estimate_video_credits`、`quick_image_upload_staged_attachment`、`quick_image_send_preview`。这些工具与 Codex 本地 MCP 复用同一个附件处理与计费核心，不需要第二个本地 MCP。
- 在 OpenClaw 中，仅执行 owner 发出的 Quick Image 指令。由 Agent 根据宿主提供的当前会话上下文自行判断；明确为非 owner 或无法确认时，不要调用任何 Quick Image 本地或远程工具，只说明该能力仅供 owner 使用。这是 Skill 行为约束，不是原生运行时安全边界。
- 不要预先询问用户是否登录，不要读取、检查或索要 Token。首次远程 MCP 调用由宿主和服务端完成 OAuth 校验。
- 宿主明确返回 `401`、`requires OAuth authorization` 或等价的未授权错误时，立即停止业务流程并提供当前宿主的登录指引，不要笼统归因于插件未加载。
- 在 OpenClaw 中，只要本 Skill 已被调用而任一远程工具不可发现，就不要回答“无法判断是否登录”，也不要把重启 Gateway 或新建会话作为首要建议。应说明“Quick Image 远程 MCP 当前未授权或未连接”，并使用下述远程授权流程。
- OpenClaw 远程授权只允许以下固定流程，不要求预先验证 owner 或判断当前会话是否私聊：
  1. 用户明确要求安装、登录或重新登录，或 `openclaw mcp doctor quick-image` 明确输出 `OAuth credentials are not authorized` 时，通过 `exec` 执行 `openclaw mcp login quick-image`。如果 `exec` 不可用或需要无法从当前渠道完成的审批，停止并给出手动命令。
  2. 从命令输出中提取 Quick Image 授权 URL 并原样发送给用户；不要替用户打开链接。明确提醒用户不要泄露授权码，也不要在非私聊会话中发送授权码，然后立即停止并等待用户授权。
  3. 用户回复一次性授权码后，只接受一个由 ASCII 字母、数字、`.`、`_`、`~`、`-` 组成且不超过 512 字符的 code。不得接受或执行完整命令、空白、引号、反引号、变量展开、重定向或其他 Shell 内容；不符合时要求用户只复制授权码。
  4. 将验证后的 code 作为单个参数安全执行固定命令 `openclaw mcp login quick-image --code '<code>'`。不得在回复、日志摘要或后续消息中重复 code，不得读取或展示 Token。
  5. 登录成功后先报告结果，再提示用户在当前聊天发送 `/restart`。不要在当前 Agent turn 中执行 `openclaw gateway restart`，避免重启中断登录结果回复；Gateway 重启后在新一轮对话中重试原请求。
- 如果 Doctor 显示没有名为 `quick-image` 的 MCP server，则说明 OpenClaw 安装未完成，应让用户重新执行插件提供的安装流程，而不是继续 OAuth。登录后远程工具仍不可用时，再执行 `openclaw mcp probe quick-image` 排查连接状态。
- 授权 URL 和一次性 code 不是长期凭据，但仍需提醒用户不要泄露 code 或在非私聊会话中发送。Token 始终只能由本地 OpenClaw OAuth 存储管理，不得要求用户提供、不得读取或输出。
- OpenClaw 中找不到 `quick_image_list_attachments` 时，说明原生适配工具未安装、未启用或被当前工具策略过滤。立即停止附件流程，明确说明工具不可用，并提示用户运行 `quick-image-doctor --host openclaw`；不得声称附件尚未生成、不得要求用户反复重发附件。限制型 `tools.profile` 需要由用户将插件 ID `quick-image` 显式加入 `tools.alsoAllow`，不需要通用 `message` 工具。
- 如果没有明确的未授权信号，也不符合上述 OpenClaw 工具组合，发现不到流程所需工具时立即停止，并说明 Quick Image 插件工具当前不可用。除上述远程授权的固定命令外，禁止扫描插件或工作区源码、读取安装目录、运行 Shell/CLI/npm 命令、检查端口或自行寻找替代上传入口。

## 1. 登记并检查附件

- 工具发现完成后，先为任务需要的每个附件取得一次性 `attachment_handle`。检查只读取媒体、计算校验和及元数据并保存轻量引用记录；不复制附件字节、不压缩、不暂存、不上传。
- Codex 中仅将当前对话附件明确提供的绝对路径传给 `inspect_attachment`，并等待宿主显示工具审批。不得传入模型猜测、目录搜索或 Shell 得到的路径。
- OpenClaw 中有明确生成意图且任务需要附件时，先调用 `quick_image_list_attachments`。不传参数时返回当前会话最近 10 个附件候选，并按上传时间从旧到新排列；用户明确涉及更多附件，或返回 `has_more=true` 且其指代可能包含未返回附件时，将 `limit` 调高，最大 20，仍无法覆盖或判断时请用户明确选择。根据用户表述、数量、对话顺序以及返回的 `message_id`、`position` 和 `received_at` 选择附件，仅对选中的 `attachment_id` 调用 `quick_image_inspect_attachment`，不得默认检查全部候选。没有生成意图时不要仅因收到附件就执行检查；候选为空、数量不匹配或无法唯一判断用户指代时，请用户明确选择或重新发送，不得猜测。不要要求或传递绝对路径、`media://` 引用，也不要根据消息文本重建媒体引用。
- 保留每个检查结果的 `attachment_handle`、媒体类型、大小、元数据和过期时间，用于参数校验和报价。已有本次任务未过期的句柄时直接复用，不要重复检查。
- 当前会话没有可用附件或句柄而任务必须使用附件时，停止并要求用户重新发送或明确引用。不得扫描下载目录、工作区、插件目录或其他本地目录，不得通过 Shell/CLI、网页上传或 Base64 绕过附件工具。用户拒绝 Codex 检查工具审批时立即停止。

## 2. 确定单个任务

- 每次请求只创建一个能力任务：`lookbook`、`pose`、`upscale` 或 `video`。
- 只使用当前对话附件、当前对话已返回的 Quick Image `asset_id`，或本次 `get_generation_config` 返回的模板。
- 不列出或搜索用户图库，不创建跨能力流水线，不提供取消、删除、充值或业务重试。
- 首先调用 `get_generation_config`，以其返回的能力、模型、参数约束、每类最多 20 个模板、价格和媒体限制为准；[parameters.md](references/parameters.md) 仅作为语义补充。只询问没有默认值且必填的缺失参数。
- 报价前解析一份完整业务参数：用户明确指定的合法值优先，其余使用配置默认值。影响输出或价格的默认值也要显式保留，报价、确认和提交必须复用同一份参数；无关字段和空值不得传入。
- 搭配和换姿的 Prompt 来源必须严格互斥。搭配未指定模板且没有文字要求时，询问用户选择模板或说明要求。换姿未指定模板、没有文字姿势要求且没有姿势参考图时，询问用户选择模板或说明目标姿势；不得擅自选择模板或虚构要求。完整决策规则见 [parameters.md](references/parameters.md)。
- 需要用户选择搭配或换姿模板时，按本次配置的原始顺序展示当前能力的模板，并在每个模板名称前添加从 1 开始的序号，格式为 `1. <模板名称>`。列表末尾明确提示用户可以回复序号或模板名称选择，也可以直接描述自定义效果。序号只对应最近一次展示的当前能力模板列表；文字与模板名称明确匹配时选择该模板，未匹配的效果描述按自定义 Prompt 处理。序号越界或名称匹配不唯一时重新询问，不得猜测。完整解析规则见 [parameters.md](references/parameters.md)。
- 视频任务必须先按 [parameters.md](references/parameters.md) 的模式决策规则确定 `mode`、附件角色和完整参数。用户未明确附件角色且不同解释会对应不同模式时先询问；不得根据附件顺序或画面内容猜测。所选模型不支持目标模式时，展示当前配置中的兼容模型让用户选择，不得静默改变用户指定的模型或模式。

## 3. 使用检查结果校验媒体

- 附件角色和任务参数确定后、报价前，使用 Codex 的 `inspect_attachment` 或 OpenClaw 的 `quick_image_inspect_attachment` 返回的真实媒体类型、`byte_size` 和 `metadata` 检查当前配置中的格式、数量、大小、单个时长与总时长限制。
- 视频计费需要输入时长时，汇总所有输入视频的 `metadata.duration_seconds`。音频时长和文件大小只用于当前模型能力与媒体限制检查，不自行加入计费公式。
- 此阶段不得调用 `prepare_attachment`、`create_direct_upload` 或 `upload_staged_attachment`。媒体元数据缺失或不满足当前配置时停止，不得猜测或继续报价。

## 4. 配置报价与确认

1. 调用 `get_generation_config` 获取当前账号对应的公开配置，并在当前任务内复用同一份完整配置。内部选型和提交使用配置提供的完整模型对象；用户可见内容只展示 `model.display_name`，不要展示 `model.id` 或 `model.version`，也不得展示或推测内部供应商路由、工作流版本等内部字段。
2. 按当前能力只调用对应的本地估价工具，并原样传入配置的 `estimation_contract_version`、`confirmation_thresholds` 和完整价格对象：
   - 搭配调用 Codex 的 `estimate_lookbook_credits` 或 OpenClaw 的 `quick_image_estimate_lookbook_credits`：传所选模型与分辨率的 `pricing`、所选预设完整对象或 `null`、模型的 `preset_price_behavior` 和 `output_count`。
   - 换姿调用 Codex 的 `estimate_pose_credits` 或 OpenClaw 的 `quick_image_estimate_pose_credits`：传所选模型与分辨率的 `pricing`、所选预设完整对象或 `null`、模型的 `preset_price_behavior`、`person_count` 和 `output_count_per_person`。
   - 高清调用 Codex 的 `estimate_upscale_credits` 或 OpenClaw 的 `quick_image_estimate_upscale_credits`：传高清 `pricing` 和 `input_count`。
   - 视频调用 Codex 的 `estimate_video_credits` 或 OpenClaw 的 `quick_image_estimate_video_credits`：传当前条件对应的完整 `pricing`、`output_duration_seconds`，以及附件检查结果中的输入视频总时长；没有视频输入时 `input_video_duration_seconds` 传 `null`。
   工具名已经确定能力，不得传 `capability`，不得调用其他能力的估价工具，也不得自行选择价格来源、拼接价格字段、计算积分或修正工具结果。
3. 只使用工具返回的 `estimated_credits`、`estimated_output_count`、`calculation` 和 `confirmation_reasons`，不得由模型重新计算或修正报价。`estimated_output_count` 是只读派生结果，只用于展示和确认阈值判断，绝不能并入任何提交工具的 arguments。
4. 展示输入摘要、用户可调整的完整解析参数、简明计算依据、预计积分和余额影响，并等待用户明确确认。模型只显示公开展示名称，例如“BN-Pro”。`person_count` 仅用于本地计价，不要以“识别人物”或其他媒体检测字段展示给用户；只有检测异常导致无法安全报价时才说明对应问题。配置报价是预计值，不是锁价。报价摘要末尾写明：如需调整参数，直接告诉我你的要求；确认无误请回复“确认生成”。
5. 将预计积分与 `account.available_credits` 比较；余额不足时立即停止，不得上传附件，也不得提交任务。
6. 如果配置不完整、媒体元数据无法读取、工具拒绝价格候选或预计价格不是有限正数，停止并说明无法安全预估；不得自行回退、猜测价格或继续上传。
7. `confirmation_reasons` 非空时必须针对列出的原因取得额外明确确认。

## 5. 确认后安全上传

用户确认后，对每个需要上传的附件：

1. 将报价时保留的 `attachment_handle` 传给 Codex 的 `prepare_attachment` 或 OpenClaw 的 `quick_image_prepare_attachment`。该工具重新读取原附件并验证文件身份、校验和和媒体格式未变化，图片在此时才旋转、缩放和压缩；成功后消费检查句柄并返回 `staged_handle` 与完整 `create_direct_upload_args`。
2. 如果返回 `ATTACHMENT_CHANGED`、句柄不存在或已过期，停止上传，重新检查附件并重新报价；不得继续使用旧报价。
3. 将 `create_direct_upload_args` 完整对象直接用作远程 `create_direct_upload` 的 arguments。禁止逐字段重新读取、转写、缩写或修正其中任何值，尤其是 `checksum` 和 `upload_checksum`。
4. 将远程返回的完整直传信息原样传给 Codex 的 `upload_staged_attachment` 或 OpenClaw 的 `quick_image_upload_staged_attachment`，只使用其最终返回的 `asset_id`。

## 6. 上传后提交

- 确认后才执行上传：用户确认后才执行附件准备和上传；上传完成后用上传得到的 `asset_id` 替换本地附件引用。
- `account.available_credits` 只代表配置读取时的余额；提交时服务端会再次在扣费事务内检查余额。若期间余额不足，停止任务流程并说明未创建任务，不能通过换幂等键重试。
- 本地报价始终只是预估价格，可能随服务端配置变化；最终以任务创建成功后返回的 `charged_credits` 为准。

## 7. 幂等提交

- 每个新的逻辑生成请求生成一个 UUID v4 `idempotency_key`。
- 按能力调用唯一对应的提交工具：搭配使用 `submit_lookbook_task`，换姿使用 `submit_pose_task`，高清使用 `submit_upscale_task`，视频使用 `submit_video_task`。提交工具名已经确定能力，arguments 中不得再传 `capability`。
- 只传本地预估时保留的该能力完整业务参数和 `idempotency_key`。搭配只使用 `output_count`；换姿只使用 `output_count_per_person`，不得传 `output_count`；高清和视频不得传这两个图片数量字段。
- 在得到明确响应前保留该键和完全相同的参数。网络超时或响应丢失时原样重放。
- `IDEMPOTENCY_KEY_REUSED` 表示同一键被用于不同请求；停止提交并解释冲突，不能换键掩盖不确定结果。
- 用户明确要求再次生成属于新任务：重新预估并生成新键。
- 每个任务的创建结果都必须立即发送一条独立状态消息，不要只在最终结果中汇总。所有宿主都使用正常的独立中间回复；`quick_image_send_preview` 仅用于成功结果的原生媒体预览，不用于纯文本状态通知。
- 提交成功后，在第一次调用 `get_generation_tasks` 前发送以下固定信息，然后才开始轮询。模型字段不存在时省略“模型”行：
  ```text
  任务创建成功
  能力：<能力名称>
  任务 ID：<task_id>
  模型：<model.display_name>
  实际扣费：<charged_credits> 积分
  正在等待生成结果，请稍候。
  ```
  实际扣费可能与本地预估不同。
- 提交返回明确的业务错误时立即发送以下固定信息，不得进入结果轮询；按当前对话语言解释错误，并保留服务端的 `retryable` 和 `retry_after`：
  ```text
  任务创建失败
  能力：<能力名称>
  原因：<服务端错误>
  任务未进入结果等待。
  ```
- 网络超时或响应丢失不等于创建失败。先使用完全相同的参数和原 `idempotency_key` 重放；仍无法得到明确结果时发送以下信息，不得生成新键或声称任务失败：
  ```text
  任务创建状态待确认
  能力：<能力名称>
  原因：暂未收到明确响应
  正在使用原幂等键确认，暂不重复创建任务。
  ```
- 状态通知发送失败不得触发重新提交任务；在下一次可发送的回复中优先补充同一状态。未来支持多任务时，上述通知必须按任务分别发送，不得只发送批次汇总。

## 8. 等待与结果

- 轮询间隔统一为 30 秒。调用 `get_generation_tasks` 时传入仍需等待的已知 `task_id`；单次至少 1 个、最多 20 个，不要更频繁轮询。
- 图片任务最多等待 10 分钟，视频任务最多等待 20 分钟。
- OpenClaw 提交成功并发送创建状态后，立即且只创建一个 recurring cron 负责该任务，不要在当前 Agent turn 自行循环，也不要使用 heartbeat 或 `sessions_yield`。cron 必须使用 `sessionTarget="isolated"`、`payload.kind="agentTurn"`、30 秒固定间隔和当前会话推断出的 `announce` 投递路由；不得创建 `main + systemEvent` 或一次性任务。
- OpenClaw cron 的 `payload.toolsAllow` 只包含 `quick-image__get_generation_tasks`、`quick_image_send_preview` 和 `cron`。轮询消息必须写入固定的 `task_id`、能力和等待上限，并要求每次运行严格执行：
  1. 调用 `quick-image__get_generation_tasks` 查询该任务。
  2. 状态为 `queued` 或 `processing` 且未超时，最终只返回 `NO_REPLY`。
  3. 状态为 `succeeded`、`partial_succeeded` 或 `failed`，或任务缺失、达到等待上限时，先完成结果发送或错误说明，再调用 `cron(action="list")` 取得当前 isolated cron 唯一可见的自身任务，并调用 `cron(action="remove", jobId="<自身任务 ID>")` 删除自身；不得继续轮询。
  4. 成功结果逐个调用 `quick_image_send_preview`；全部媒体发送成功且无需补充失败说明时最终返回 `NO_REPLY`，否则通过 cron 的 `announce` 最终回复说明部分失败、生成失败、查询失败或等待超时。
- OpenClaw recurring cron 使用以下结构，尖括号内容替换为本次任务的实际值；同一 `task_id` 不得重复创建：
  ```json
  {
    "action": "add",
    "job": {
      "name": "quick-image-watch-<task_id>",
      "schedule": { "kind": "every", "everyMs": 30000 },
      "sessionTarget": "isolated",
      "payload": {
        "kind": "agentTurn",
        "message": "每次只查询 Quick Image 任务 <task_id>（能力：<capability>，等待上限：<limit>）。严格按 Quick Image Skill 的 OpenClaw cron 轮询规则处理 pending、结果发送、超时和删除自身；不要提交新任务。",
        "timeoutSeconds": 120,
        "toolsAllow": ["quick-image__get_generation_tasks", "quick_image_send_preview", "cron"]
      },
      "delivery": { "mode": "announce" }
    }
  }
  ```
- OpenClaw cron 创建失败时，明确说明已回退，并留在当前 Agent turn：用 `exec` 仅执行 `sleep 30` 后再次调用 `get_generation_tasks`，直到任务进入终态或达到等待上限。其他宿主也使用这一 30 秒当前任务内轮询方式。
- `get_generation_tasks` 在同一任务对象中返回状态、数量、计费、失败信息和当前全部成功结果；不要再调用单独的结果工具。部分成功时不得隐藏成功结果。
- 展示任务返回的 `model.display_name`。`model.id` 和 `model.version` 仅用于内部识别，不得显示给用户，也不得展示或推测内部供应商路由。
- `missing_task_ids` 中的任务不存在或不属于当前账号，不要继续轮询这些 ID，也不要猜测其状态。
- 对每个图片结果，按当前宿主展示预览：
  - 在 OpenClaw 消息渠道中，调用原生适配工具 `quick_image_send_preview`，传入任务结果的 `display_url`、原文件 `url`（作为 `download_url`）和 `media_kind="image"`。该工具只使用当前会话的可信路由，不接收也不得另行指定 `channel`、`to`、`target`、账号或 thread。
  - 上述原生媒体规则适用于 OpenClaw 微信、Telegram、WhatsApp、Discord、Slack、Signal、iMessage、Google Chat、Matrix、Mattermost 和 Microsoft Teams；具体上传和发送规则由当前渠道的 OpenClaw 原生出站适配器处理，不要改用通用 `message` 或渠道专属工具。
  - OpenClaw 中不要仅输出 Markdown 图片作为媒体回退；Codex 使用 `display_url` 通过 Markdown 图片语法嵌入预览，并紧跟使用 `url` 的“下载原图”链接。
  - 不得用 `url` 代替 `display_url` 预览，也不得用 `display_url` 代替原图下载链接。OpenClaw 的全部媒体消息发送完成后，最终回复使用 `NO_REPLY`，避免同一结果再次作为普通文本发送。
- `display_url` 为空时不要调用 `quick_image_send_preview`，也不要嵌入图片组件；只展示原图下载链接并说明预览不可用。OpenClaw 中找不到该工具时，说明 Quick Image OpenClaw 原生适配层未安装或未启用，并保留原图下载链接；不要要求用户开放通用 `message` 权限，不要退回 Markdown 图片，也不要重复提交生成任务。媒体发送失败时同样保留下载链接，不要重复提交。视频结果遵循相同规则，调用 `quick_image_send_preview` 并传 `media_kind="video"`、可用查看地址作为 `display_url`、原视频地址作为 `download_url`。
- 展示扣费、退款和净消耗。`partial_succeeded` 必须同时说明成功数与失败数。
- `succeeded`、`partial_succeeded` 和 `failed` 都必须发送独立的最终结果消息；生成失败也不能静默结束。
- 超过等待上限时，使用与创建状态通知相同的宿主发送方式发送以下独立消息并停止本轮轮询。不要标记失败，不创建新任务；后续继续查询原任务：
  ```text
  等待结果超时
  能力：<能力名称>
  任务 ID：<task_id>
  当前状态：<status>
  已扣积分：<charged_credits>
  任务可能仍在处理中，不代表生成失败。稍后可继续查询原任务。
  ```

## 9. 历史与错误

- 用户询问历史时调用 `list_generation_tasks`，模型只展示每个任务返回的 `model.display_name`；用户选定一个或多个任务后，将已知 `task_id` 分成每组最多 20 个调用 `get_generation_tasks` 查询完整状态和结果。
- 按当前对话语言解释稳定错误码，保留其原始语义、`retryable` 和 `retry_after`。
- 遇到 `429` 按 `Retry-After` 等待，不高频重试。
- 遇到 `upgrade_required` 停止新的上传和提交，并提供当前宿主的手动升级方式。
- 余额不足、素材失效或参数失效时不提交；根据服务端错误停止或重新预估。

远程工具与响应字段见 [tools.md](references/tools.md)。
