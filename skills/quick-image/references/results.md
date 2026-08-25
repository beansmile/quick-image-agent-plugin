# 轮询与结果

任务提交成功后，或用户查询历史任务时读取本文件。

## 轮询

- 轮询间隔统一为 30 秒。调用 `get_generation_tasks` 时传入仍需等待的已知 `task_id`；单次至少 1 个、最多 20 个，不要更频繁轮询。
- 图片任务最多等待 10 分钟，视频任务最多等待 20 分钟。
- `get_generation_tasks` 在同一任务对象中返回状态、数量、计费、失败信息和当前全部成功结果；不要再调用单独的结果工具。部分成功时不得隐藏成功结果。
- 展示任务返回的 `model.display_name`。`model.id` 和 `model.version` 仅用于内部识别，不得显示给用户，也不得展示或推测内部供应商路由。
- `missing_task_ids` 中的任务不存在或不属于当前账号，不要继续轮询这些 ID，也不要猜测其状态。

## OpenClaw Cron

- OpenClaw 提交成功并发送创建状态后，立即且只创建一个 recurring cron 负责该任务，不要在当前 Agent turn 自行循环，也不要使用 heartbeat 或 `sessions_yield`。
- cron 必须使用 `sessionTarget="isolated"`、`payload.kind="agentTurn"`、30 秒固定间隔和当前会话推断出的 `announce` 投递路由；不得创建 `main + systemEvent` 或一次性任务。
- `payload.toolsAllow` 只包含 `quick-image__get_generation_tasks`、`quick_image_send_preview` 和 `cron`。轮询消息必须写入固定的 `task_id`、能力和等待上限，并要求每次运行严格执行：
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

## 结果展示

- 对每个图片结果，按当前宿主展示预览：
  - OpenClaw 调用 `quick_image_send_preview`，传任务结果的 `display_url`、原文件 `url` 作为 `download_url` 和 `media_kind="image"`。该工具只使用当前会话可信路由，不接收也不得另行指定 `channel`、`to`、`target`、账号或 thread。
  - OpenClaw 的原生媒体规则适用于各渠道，具体上传和发送由当前渠道适配器处理，不要改用通用 `message` 或渠道专属工具。
  - OpenClaw 不要仅输出 Markdown 图片作为媒体回退；Codex 使用 `display_url` 通过 Markdown 图片嵌入预览，并紧跟使用 `url` 的下载原图链接。
  - 不得用 `url` 代替 `display_url` 预览，也不得用 `display_url` 代替原图下载链接。OpenClaw 全部媒体发送完成后最终回复使用 `NO_REPLY`，避免同一结果再次作为普通文本发送。
- `display_url` 为空时不要调用 `quick_image_send_preview`，也不要嵌入图片组件；只展示原图下载链接并说明预览不可用。OpenClaw 找不到该工具时，说明原生适配层未安装或未启用并保留下载链接，不要求开放通用 `message` 权限，不退回 Markdown 图片，不重复提交任务。媒体发送失败时同样保留下载链接，不重复提交。视频结果使用 `media_kind="video"`、可用查看地址作为 `display_url`、原视频地址作为 `download_url`。
- 展示扣费、退款和净消耗。`partial_succeeded` 必须同时说明成功数与失败数。
- `succeeded`、`partial_succeeded` 和 `failed` 都必须发送独立的最终结果消息；生成失败也不能静默结束。
- 超过等待上限时发送以下独立消息并停止本轮轮询。不要标记失败，不创建新任务；后续继续查询原任务：

```text
等待结果超时
能力：<能力名称>
任务 ID：<task_id>
当前状态：<status>
已扣积分：<charged_credits>
任务可能仍在处理中，不代表生成失败。稍后可继续查询原任务。
```

## 历史与错误

- 用户询问历史时调用 `list_generation_tasks`，只展示每个任务返回的 `model.display_name`；用户选定任务后，将已知 `task_id` 分成每组最多 20 个调用 `get_generation_tasks` 查询完整状态和结果。
- 按当前对话语言解释稳定错误码，保留原始语义、`retryable` 和 `retry_after`。
- 遇到 `429` 按 `Retry-After` 等待，不高频重试。
- 调用 Quick Image MCP 工具失败且错误码为 `upgrade_required` 时，停止新的上传和提交，读取 [version.md](version.md)，先征得用户同意后按当前宿主的固定流程升级；升级完成并重新加载 Skill/MCP 后再重试原请求。
- 余额不足、素材失效或参数失效时不提交；根据服务端错误停止或重新预估。
