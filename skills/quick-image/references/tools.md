# MCP 工具语义

## 远程 Quick Image MCP

- `get_agent_plugin_installation_plan()`：检查 Quick Image Agent Plugin 是否有新版本，返回 `update_available`、`latest_version` 和可用于更新或重装的中文 `prompt`。
- `get_generation_config`：返回当前账号的 `user_id`、`screen_name`、`email`、实时积分余额，以及公开生成能力、模型 ID、展示名称、版本、参数约束、搭配与换姿各自排序在前的最多 20 个模板、积分价格、公开计费策略、媒体限制和确认阈值；模板包含公开 ID、名称、描述、价格和可用的预览地址，不返回内部 Prompt。配置报价只用于预估，带有 `estimation_contract_version`。账号信息和余额是实时字段，不应长期缓存。
- `create_direct_upload`：根据最终文件元数据创建 Agent 素材；需要上传时签发限定对象的直传信息，已有同账号且经服务端验证的相同素材时返回复用结果。
- `submit_lookbook_task`：只接受搭配出图参数和 UUID v4 幂等键，重新校验、计价、扣费并创建任务。
- `submit_pose_task`：只接受换姿参数和 UUID v4 幂等键，重新校验、计价、扣费并创建任务。
- `submit_upscale_task`：只接受高清参数和 UUID v4 幂等键，重新校验、计价、扣费并创建任务。
- `submit_video_task`：只接受视频生成参数和 UUID v4 幂等键，重新校验、计价、扣费并创建任务。
- `list_generation_tasks`：列出当前账号 MCP/Web 来源的四类独立任务摘要及公开模型信息，默认 20，最大 50。
- `get_generation_tasks`：按 1～20 个已知 `task_id` 批量返回完整任务，保持输入顺序并自动去重；每项同时包含状态、公开模型、数量、扣费、退款、失败信息，以及成功结果的 `asset_id`、预览用 `display_url`、原始文件 `url` 与媒体类型。无法读取的 ID 返回在 `missing_task_ids`，不会导致整批失败。图片预览只使用 `display_url`，原图下载只使用 `url`。

模型对象包含 `model.id`、`model.display_name`、`model.version`，表示用户请求的公开模型。高清能力没有可选公开模型时不返回 `model`。`id` 和 `version` 仅用于内部识别与提交，用户可见内容只展示 `display_name`；不得从模型对象推测或展示内部供应商路由。

远程工具需要 `presets:read`、`assets:write`、`tasks:read`、`tasks:write` 完整授权包。客户端负责 OAuth，Skill 和本地附件处理核心不得接触 Token。

## 本地工具

- `inspect_attachment({ path })`：需要路径或媒体引用的宿主所使用的本地 MCP 工具；处理宿主或 AI 根据用户意图提供的本地媒体绝对路径或 Runtime 支持的媒体引用。读取真实媒体格式、大小、校验和与元数据，保存不含附件字节的轻量引用记录，返回一次性 `attachment_handle`。该步骤不压缩、不暂存、不上传。
- `quick_image_list_attachments({ message_id?, limit?, cursor? })`：OpenClaw 原生工具；默认返回当前会话最近 10 个附件候选并按上传时间从旧到新排列，`limit` 可设为 1～20，`message_id` 可精确限定单条历史消息。返回不透明 `attachment_id`、媒体类型、消息 ID、消息内顺序、时间、`has_more` 和可选 `next_cursor`，不返回本地路径；继续读取更早附件时将 `next_cursor` 原样传为 `cursor`。
- `quick_image_inspect_attachment({ attachment_id?, path? })`：OpenClaw 原生工具；`attachment_id` 用于读取 `quick_image_list_attachments` 登记的当前会话附件，`path` 用于读取宿主或 AI 根据用户意图提供的本地文件绝对路径或 Runtime 支持的媒体引用，两者必须二选一；返回轻量 `attachment_handle`。
- `prepare_attachment` / `quick_image_prepare_attachment({ attachment_handle })`：分别是 Codex 本地 MCP 与 OpenClaw 原生入口。用户确认报价后重新读取已检查的原始附件，验证文件身份、校验和和媒体格式未变化并处理媒体；图片在此阶段自动旋转、缩放和压缩。成功后消费检查句柄，并返回暂存句柄及 `create_direct_upload_args` 完整参数对象（含 SHA-256 `checksum` 与 Base64 MD5 `upload_checksum`）。该对象必须整体转交给远程 `create_direct_upload`，不得逐字段转写。
- `estimate_lookbook_credits` / `quick_image_estimate_lookbook_credits({ estimation_contract_version, pricing, preset, preset_price_behavior, output_count, confirmation_thresholds })`：预估搭配积分；未选择预设时 `preset` 传 `null`。
- `estimate_pose_credits` / `quick_image_estimate_pose_credits({ estimation_contract_version, pricing, preset, preset_price_behavior, person_count, output_count_per_person, confirmation_thresholds })`：预估换姿积分；未选择预设时 `preset` 传 `null`。
- `estimate_upscale_credits` / `quick_image_estimate_upscale_credits({ estimation_contract_version, pricing, input_count, confirmation_thresholds })`：预估高清积分。
- `estimate_video_credits` / `quick_image_estimate_video_credits({ estimation_contract_version, pricing, output_duration_seconds, input_video_duration_seconds, confirmation_thresholds })`：预估视频积分；没有视频输入时 `input_video_duration_seconds` 传 `null`。
- `upload_staged_attachment` / `quick_image_upload_staged_attachment({ staged_handle, direct_upload })`：分别是 Codex 本地 MCP 与 OpenClaw 原生入口，校验暂存文件后按服务端结果执行 PUT，或跳过已验证素材的重复上传；成功后返回 `asset_id`。

本地文件路径或媒体引用可以由宿主原生能力或 AI 根据用户意图确定。Quick Image 本地工具信任调用方提供的具体输入，不校验来源或另行实施目录授权；实际可读范围由宿主进程的系统文件权限和 Runtime 的引用解析规则决定。所有本地工具都不接受 Base64、Bearer Token 或单独的任意上传 URL。`direct_upload` 必须作为远程工具响应整体传递：`upload_required` 为 `false` 时包含 `asset_id`；需上传时还包含 `upload_url`、`headers` 和 `expires_at`。

Codex 与 OpenClaw 的四个估价入口复用同一个本地计费核心，统一返回 `estimated_credits`、只读派生值 `estimated_output_count`、`calculation` 和 `confirmation_reasons`；它们不上传素材、不扣费、不锁价，也不替代服务端最终计价。`pricing` 必须是 `get_generation_config` 中当前能力和条件对应的完整价格项。搭配与换姿还应原样传入所选 `preset` 完整对象或 `null` 及模型的 `preset_price_behavior`，由工具确定图片价格来源。预设 `unit_credits` 必须存在：为 `null` 时使用模型价格；有数值时必须是正整数，否则拒绝预估。调用方不得自行选价、拼接或修改价格项。内部计费核心支持以下公开策略：

- `output_count`
- `person_output_count`
- `input_count`
- `output_duration`
- `input_plus_output_duration`

`estimated_output_count` 只用于展示和确认阈值判断，不是任何远程提交工具的参数。

## 稳定任务状态

- `queued`
- `processing`
- `succeeded`
- `partial_succeeded`
- `failed`

## 额外确认原因

- `output_count_threshold`
- `image_credits_threshold`
- `video_credits_threshold`
