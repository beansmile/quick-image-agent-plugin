# 附件处理

任务需要会话附件或本地媒体时读取本文件。附件检查、报价和上传是三个不同阶段，不能提前合并。

## 发现与登记

- 为每个任务所需附件取得一次性 `attachment_handle`。检查只读取媒体、计算校验和及元数据并保存轻量引用记录；不复制附件字节、不压缩、不暂存、不上传。
- 用户提出本地文件或目录需求时，可以使用宿主原生的路径解析、目录浏览、文件搜索或文件读取能力，也可以根据用户明确提供的信息确定目标媒体。将确定的本地文件绝对路径或 Runtime 支持的媒体引用传给对应的 Quick Image 本地工具；插件信任该输入，实际可读范围由宿主进程的系统文件权限和 Runtime 的引用解析规则决定。
- 对无法唯一确定的目标，继续使用宿主能力获取候选或请求用户补充。OpenClaw 会话附件可以使用 `quick_image_list_attachments` 返回的 `attachment_id`；已有具体 `media://` 引用时也可以直接传入。
- OpenClaw 只有在用户有明确生成意图且任务需要附件时，才调用 `quick_image_list_attachments`；不要仅因收到附件就执行检查。不传参数时返回当前会话最近 10 个候选并按上传时间从旧到新排列；当返回 `has_more=true` 且用户指代可能包含未返回附件时，将 `limit` 调高，最大 20。根据用户表述、数量、对话顺序以及 `message_id`、`position` 和 `received_at` 选择附件，仅对选中的 `attachment_id` 调用 `quick_image_inspect_attachment`。
- OpenClaw 会话附件通常使用 `quick_image_list_attachments` 返回的不透明 `attachment_id`。本地文件或媒体引用可以根据用户提供的信息或宿主文件能力确定；候选为空、数量不匹配或无法唯一判断用户指代时，继续使用宿主能力获取候选或请用户明确选择。
- 保留检查结果的 `attachment_handle`、媒体类型、大小、元数据和过期时间。本次任务中已有未过期句柄时直接复用，不重复检查。
- 无法确定目标文件路径、媒体引用或附件句柄而任务必须使用附件时，停止并说明需要用户提供更明确的位置或附件。不得通过网页上传或 Base64 绕过本地工具。

## 检查与限制校验

- 附件角色和任务参数确定后、报价前，使用 Codex 的 `inspect_attachment` 或 OpenClaw 的 `quick_image_inspect_attachment` 返回的真实媒体类型、`byte_size` 和 `metadata` 检查当前配置中的格式、数量、大小、单个时长与总时长限制。
- 视频计费需要输入时长时，汇总所有输入视频的 `metadata.duration_seconds`。音频时长和文件大小只用于当前模型能力与媒体限制检查，不自行加入计费公式。
- 媒体元数据缺失或不满足当前配置时停止，不得猜测或继续报价。
- 本阶段不得调用 `prepare_attachment`、`create_direct_upload` 或 `upload_staged_attachment`。

## 宿主故障处理

- OpenClaw 找不到 `quick_image_list_attachments`，说明原生适配工具未安装、未启用或被当前工具策略过滤。立即停止附件流程，明确说明工具不可用，并提示用户使用 Plugin 固定的 Runtime Release tgz 运行 `npx --yes --prefer-online --package <Runtime Release tgz> quick-image-doctor --host openclaw`。
- 限制型 `tools.profile` 需要用户将插件 ID `quick-image` 显式加入 `tools.alsoAllow`，不需要通用 `message` 工具。
- Codex 本地附件工具不可发现或被拒绝时，停止并说明工具不可用；不得声称附件尚未生成或要求用户反复重发。
