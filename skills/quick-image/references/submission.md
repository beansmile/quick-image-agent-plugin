# 报价与提交

读取 [parameters.md](parameters.md) 完成能力和完整业务参数后，再读取本文件。报价、确认、上传和提交必须复用同一份参数与配置。

## 配置与报价

1. 调用 `get_generation_config` 获取当前账号对应的公开配置，并在当前任务内复用同一份完整配置。内部选型和提交使用配置提供的完整模型对象；用户只看到 `model.display_name`，不得展示或推测 `model.id`、`model.version`、供应商路由或工作流版本。
2. 按当前能力只调用对应的本地估价工具，并原样传入配置的 `estimation_contract_version`、`confirmation_thresholds` 和完整价格对象：
   - 搭配：`estimate_lookbook_credits` 或 `quick_image_estimate_lookbook_credits`，传 `pricing`、预设完整对象或 `null`、`preset_price_behavior` 和 `output_count`。
   - 换姿：`estimate_pose_credits` 或 `quick_image_estimate_pose_credits`，传 `pricing`、预设完整对象或 `null`、`preset_price_behavior`、`person_count` 和 `output_count_per_person`。
   - 高清：`estimate_upscale_credits` 或 `quick_image_estimate_upscale_credits`，传 `pricing` 和 `input_count`。
   - 视频：`estimate_video_credits` 或 `quick_image_estimate_video_credits`，传完整 `pricing`、`output_duration_seconds` 和输入视频总时长；没有视频输入时 `input_video_duration_seconds` 传 `null`。
3. 工具名已经确定能力，不传 `capability`，不调用其他能力估价工具，不自行选择价格来源、拼接价格字段、计算积分或修正工具结果。
4. 只使用工具返回的 `estimated_credits`、`estimated_output_count`、`calculation` 和 `confirmation_reasons`。展示输入摘要、完整解析参数、简明计算依据、预计积分和余额影响，并等待用户明确确认。报价摘要末尾写明：如需调整参数，直接告诉我；确认无误请回复“确认生成”。
5. 将预计积分与 `account.available_credits` 比较；余额不足时立即停止，不得上传附件，也不得提交任务。
6. 配置不完整、媒体元数据无法读取、工具拒绝价格候选或预计价格不是有限正数时停止；不得自行回退、猜测价格或继续上传。
7. `confirmation_reasons` 非空时必须针对列出的原因取得额外明确确认。

## 用户确认后的上传

用户明确确认后，对每个需要上传的附件：

1. 将报价时保留的 `attachment_handle` 传给 Codex 的 `prepare_attachment` 或 OpenClaw 的 `quick_image_prepare_attachment`。工具会重新读取原附件并验证文件身份、校验和和媒体格式未变化，图片此时才旋转、缩放和压缩；成功后消费检查句柄并返回 `staged_handle` 与完整 `create_direct_upload_args`。
2. 返回 `ATTACHMENT_CHANGED`、句柄不存在或已过期时，停止上传，重新检查附件并重新报价；不得继续使用旧报价。
3. 将 `create_direct_upload_args` 完整对象直接用作远程 `create_direct_upload` 的 arguments。禁止逐字段重新读取、转写、缩写或修正其中任何值，尤其是 `checksum` 和 `upload_checksum`。
4. 将远程返回的完整直传信息原样传给 Codex 的 `upload_staged_attachment` 或 OpenClaw 的 `quick_image_upload_staged_attachment`，只使用其最终返回的 `asset_id`。

## 幂等提交

- 用户确认后才执行附件准备和上传；上传完成后用上传得到的 `asset_id` 替换本地附件引用。
- `account.available_credits` 只代表配置读取时的余额；提交时服务端会再次在扣费事务内检查余额。期间余额不足时停止任务流程并说明未创建任务，不能通过换幂等键重试。
- 本地报价始终只是预估，最终以任务创建成功后返回的 `charged_credits` 为准。
- 每个新的逻辑生成请求生成一个 UUID v4 `idempotency_key`。按能力调用唯一对应的提交工具：搭配 `submit_lookbook_task`、换姿 `submit_pose_task`、高清 `submit_upscale_task`、视频 `submit_video_task`。arguments 中不得传 `capability`。
- 只传本地预估时保留的该能力完整业务参数和 `idempotency_key`。搭配只使用 `output_count`；换姿只使用 `output_count_per_person`，不得传 `output_count`；高清和视频不得传这两个图片数量字段。
- 得到明确响应前保留该键和完全相同的参数。网络超时或响应丢失时原样重放；不得生成新键或声称任务失败。
- `IDEMPOTENCY_KEY_REUSED` 表示同一键被用于不同请求；停止提交并解释冲突，不能换键掩盖不确定结果。
- 每个任务的创建结果都必须立即发送独立状态消息，不要只在最终结果中汇总。`quick_image_send_preview` 仅用于成功结果的原生媒体预览，不用于纯文本状态通知。

提交成功后，在第一次调用 `get_generation_tasks` 前发送；模型字段不存在时省略“模型”行：

```text
任务创建成功
能力：<能力名称>
任务 ID：<task_id>
模型：<model.display_name>
实际扣费：<charged_credits> 积分
正在等待生成结果，请稍候。
```

提交返回明确业务错误时立即发送，不进入轮询，并保留服务端的 `retryable` 和 `retry_after`：

```text
任务创建失败
能力：<能力名称>
原因：<服务端错误>
任务未进入结果等待。
```

网络超时或响应丢失时发送：

```text
任务创建状态待确认
能力：<能力名称>
原因：暂未收到明确响应
正在使用原幂等键确认，暂不重复创建任务。
```

状态通知发送失败不得触发重新提交任务；下一次可发送时优先补充同一状态。未来支持多任务时，通知必须按任务分别发送。
