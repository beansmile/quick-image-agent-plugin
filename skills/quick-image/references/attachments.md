# 附件处理

任务需要当前对话附件时读取本文件。附件检查、报价和上传是三个不同阶段，不能提前合并。

## 发现与登记

- 为每个任务所需附件取得一次性 `attachment_handle`。检查只读取媒体、计算校验和及元数据并保存轻量引用记录；不复制附件字节、不压缩、不暂存、不上传。
- Codex 仅将当前对话明确提供并经宿主工具审批的绝对路径传给 `inspect_attachment`。不得传入模型猜测、目录搜索或 Shell 得到的路径。
- OpenClaw 只有在用户有明确生成意图且任务需要附件时，才调用 `quick_image_list_attachments`；不要仅因收到附件就执行检查。不传参数时返回当前会话最近 10 个候选并按上传时间从旧到新排列；当返回 `has_more=true` 且用户指代可能包含未返回附件时，将 `limit` 调高，最大 20。根据用户表述、数量、对话顺序以及 `message_id`、`position` 和 `received_at` 选择附件，仅对选中的 `attachment_id` 调用 `quick_image_inspect_attachment`。
- OpenClaw 不要要求或传递绝对路径、`media://` 引用，也不要根据消息文本重建媒体引用。候选为空、数量不匹配或无法唯一判断用户指代时，请用户明确选择或重新发送，不得猜测。
- 保留检查结果的 `attachment_handle`、媒体类型、大小、元数据和过期时间。本次任务中已有未过期句柄时直接复用，不重复检查。
- 当前会话没有可用附件或句柄而任务必须使用附件时，停止并要求用户重新发送或明确引用。不得扫描下载目录、工作区、插件目录或其他本地目录，不得通过 Shell/CLI、网页上传或 Base64 绕过附件工具。用户拒绝 Codex 检查工具审批时立即停止。

## 检查与限制校验

- 附件角色和任务参数确定后、报价前，使用 Codex 的 `inspect_attachment` 或 OpenClaw 的 `quick_image_inspect_attachment` 返回的真实媒体类型、`byte_size` 和 `metadata` 检查当前配置中的格式、数量、大小、单个时长与总时长限制。
- 视频计费需要输入时长时，汇总所有输入视频的 `metadata.duration_seconds`。音频时长和文件大小只用于当前模型能力与媒体限制检查，不自行加入计费公式。
- 媒体元数据缺失或不满足当前配置时停止，不得猜测或继续报价。
- 本阶段不得调用 `prepare_attachment`、`create_direct_upload` 或 `upload_staged_attachment`。

## 宿主故障处理

- OpenClaw 找不到 `quick_image_list_attachments`，说明原生适配工具未安装、未启用或被当前工具策略过滤。立即停止附件流程，明确说明工具不可用，并提示用户使用 Plugin 固定的 Runtime Release tgz 运行 `npx --yes --package <Runtime Release tgz> quick-image-doctor --host openclaw`。
- 限制型 `tools.profile` 需要用户将插件 ID `quick-image` 显式加入 `tools.alsoAllow`，不需要通用 `message` 工具。
- Codex 本地附件工具不可发现或被拒绝时，停止并说明需要宿主提供工具审批；不得声称附件尚未生成或要求用户反复重发。
