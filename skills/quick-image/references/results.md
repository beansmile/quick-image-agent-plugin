# 轮询与结果

任务提交成功后，或用户查询历史任务时读取本文件。

## 轮询

- 等待方式按宿主区分：OpenClaw 通过 isolated cron 或后台计时器异步等待，不得在当前回合内循环阻塞用户消息；其他宿主在当前任务内每 30 秒查询一次。两种方式都遵守本节的间隔、批量与等待上限规则。
- 轮询间隔统一为 30 秒。调用 `get_generation_tasks` 时传入仍需等待的已知 `task_id`；单次至少 1 个、最多 20 个，不要更频繁轮询。
- 图片任务最多等待 10 分钟，视频任务最多等待 20 分钟。
- `get_generation_tasks` 在同一任务对象中返回状态、数量、计费、失败信息和当前全部成功结果；不要再调用单独的结果工具。部分成功时不得隐藏成功结果。
- 展示任务返回的 `model.display_name`。`model.id` 和 `model.version` 仅用于内部识别，不得显示给用户，也不得展示或推测内部供应商路由。
- `missing_task_ids` 中的任务不存在或不属于当前账号，不要继续轮询这些 ID，也不要猜测其状态。

## 宿主中断后的恢复

- 用户、宿主或 Agent 中断当前轮询时，只停止本地等待；不得调用取消接口，也不得把上一任务标记为失败。服务端任务仍可继续运行，后续可以用原 `task_id` 查询。
- 中断后用户提交新的生成请求时，将其视为新的逻辑任务：重新按 [SKILL.md](../SKILL.md) 的阶段顺序发现工具、读取配置、报价并取得确认，不要等待上一任务终态，也不要复用上一任务的幂等键、报价或附件句柄。
- 不要因为“上一轮被打断”、工具上下文重置、查询失败或会话恢复提示，就自行判断 OAuth 已失效。轮询或查询返回认证或授权类提示时，先按 [auth.md](auth.md) 第 0 节等待 5 秒后重试一次；只有重试仍失败时，才读取 [auth.md](auth.md) 并进入授权流程。
- 若新任务提交成功，立即发送新的任务创建状态；上一任务是否完成可以在用户要求时用原 `task_id` 单独查询，不能阻塞新任务或触发重复提交。

## OpenClaw Cron

- OpenClaw 提交成功并发送创建状态后，立即且只创建一个 recurring cron 负责该任务，不要在当前 Agent turn 自行循环，也不要使用 heartbeat 或 `sessions_yield`。
- cron 创建成功后，结束回合前向用户补发一句固定提示：`已转入后台监控，你可以继续和我对话，任务完成后我会自动发送结果。`用户表示没有看到这句提示时，不得直接认定未走到 cron 路径，按以下顺序排查：
  1. 调用 `cron(action="list")` 按 job name `quick-image-watch-<task_id>` 检查是否已存在该任务的 cron；存在时说明 cron 路径仍在运行，补发该提示即可，不得重复创建 cron 或启动回退计时器。
  2. 列表调用失败时，先等待 5 秒再用原参数重试一次；重试成功时回到第 1 步按列表结果处理。
  3. 列表成功但没有该任务的 cron 时，调用 `quick-image__get_generation_tasks` 查询该任务一次：任务已终态或缺失时，按结果展示规则直接发送结果或错误说明，不再创建 cron 或计时器——cron 在终态收尾后会删除自身，此时列表为空属正常；任务仍未终态且未达等待上限（按提交以来的实际等待时间判断）时，按本节回退规则启动计时器并说明已回退，不得补发固定提示语或声称 cron 路径仍在监控；任务仍未终态但已达等待上限时，按下方结果展示规则发送超时消息并停止，不再创建计时器。
  4. 重试后仍无法列出时，调用 `quick-image__get_generation_tasks` 查询该任务一次：任务已终态、缺失或已达等待上限时，按第 3 步相同规则发送结果、错误说明或超时消息；任务仍未终态且未达等待上限时，说明当前无法确认后台监控状态、任务仍在处理中，建议用户稍后再次询问或凭原 `task_id` 查询。此分支不得启动计时器——无法排除该任务的 cron 仍在运行，叠加计时器会造成双重监控、重复发送结果；也不得补发固定提示语或声称已回退、cron 路径仍在监控。
- cron 必须使用 `sessionTarget="isolated"`、`payload.kind="agentTurn"`、30 秒固定间隔和 `announce` 投递路由；不得创建 `main + systemEvent` 或一次性任务。`delivery` 中 `channel` 和 `to` 的取舍以当前会话上下文能否取得实际值为准，不以部署渠道数为判断条件：能取得当前会话的实际渠道和投递目标时必须写入实际值，不要猜测或编造——多渠道部署缺少这两个键会导致 cron 创建或投递失败；取不到实际值（典型如宿主只部署一个渠道、会话上下文不携带渠道路由）时删除这两个键、只保留 `mode`，由宿主保留的会话路由推断目标。
- `payload.toolsAllow` 只包含 `quick-image__get_generation_tasks`、`quick_image_send_preview` 和 `cron`。轮询消息必须写入固定的 `task_id`、能力和等待上限，并要求每次运行严格执行：
  1. 调用 `quick-image__get_generation_tasks` 查询该任务。
  2. 调用返回认证或授权类提示时，先等待 5 秒再用原参数重试一次；重试成功按下面规则正常处理，仍失败才归为查询失败。
  3. 状态为 `queued` 或 `processing` 且未超时，最终只返回 `NO_REPLY`。
  4. 状态为 `succeeded`、`partial_succeeded` 或 `failed`，或任务缺失、达到等待上限时，先完成结果发送或错误说明，再调用 `cron(action="list")` 取得当前 isolated cron 唯一可见的自身任务，并调用 `cron(action="remove", jobId="<自身任务 ID>")` 删除自身；不得继续轮询。
  5. 成功结果逐个调用 `quick_image_send_preview`；全部媒体发送成功且无需补充失败说明时最终返回 `NO_REPLY`，否则通过 cron 的 `announce` 最终回复说明部分失败、生成失败、查询失败或等待超时。
- OpenClaw recurring cron 使用以下结构，尖括号内容替换为本次任务的实际值；`delivery` 的 `channel` 和 `to` 是条件键，仅在按上方取舍规则能取得当前会话实际值时保留，取不到时删除这两个键、只保留 `mode`，不要为凑满模板而猜测或编造占位值。同一 `task_id` 不得重复创建：

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
    "delivery": { "mode": "announce", "channel": "<当前会话渠道>", "to": "<当前会话投递目标>" }
  }
}
```

- OpenClaw cron 创建失败时，回退到后台计时器等待，不得留在当前 Agent turn 内循环阻塞：
  1. 说明已回退到本地计时器等待，然后调用 `exec` 后台执行 `sleep 30; echo quick-image-timer`（传 `background: true`），随后正常结束本回合。计时器命令必须以产生输出结束：后台命令的完成唤醒以产生输出或失败为条件，静默成功可能不触发唤醒。`sleep` 和 `echo` 在 Windows PowerShell 下同样可用，不要换成平台专属命令；两条命令必须用 `;` 分隔，不得用 `&&`——`&&` 在 Windows PowerShell 5.1 中不是合法的语句分隔符，会让计时器立即失败并连续唤醒。
  2. 计时器结束后宿主通过系统事件和完成心跳自动唤醒 Agent；被唤醒的回合直接继续轮询流程，调用 `get_generation_tasks` 查询，不重新执行工具发现或配置读取。唤醒时刻可能晚于 30 秒，按实际已等待时间判断是否达到等待上限。子代理会话没有后台完成唤醒，不得在子代理中使用该回退方式；子代理中 cron 创建失败时，说明该任务无法后台监控、用户稍后可凭原 `task_id` 主动查询，然后结束回合，不得循环阻塞。
  3. 存在多个未终态任务时可共用一个计时器，唤醒后按最多 20 个一批查询。
  4. 任务未到终态且未达等待上限时，不发送任何中间状态消息，再次后台执行第 1 步的完整计时器命令 `sleep 30; echo quick-image-timer` 并结束回合。
  5. 任务到达终态或等待上限时，按下方结果展示规则发送最终消息或超时消息，不再挂新的计时器。
  6. 被计时器唤醒的回合中同时出现用户新消息时，先静默完成计时器的续挂或收尾，再处理用户消息；用户提出新的生成请求时按上方恢复规则作为新逻辑任务执行，不等待上一任务终态。
- 其他宿主仍使用 30 秒当前任务内轮询方式：调用 `get_generation_tasks` 后等待 30 秒再查，直到任务进入终态或达到等待上限。

## 结果展示

- 对每个图片结果，按当前宿主展示预览：
  - OpenClaw 调用 `quick_image_send_preview`，传任务结果的 `display_url`、原文件 `url` 作为 `download_url`、结果的 `preview_content_type` 和 `media_kind="image"`。该工具只使用当前会话可信路由，不接收也不得另行指定 `channel`、`to`、`target`、账号或 thread。
  - OpenClaw 的原生媒体规则适用于各渠道，具体上传和发送由当前渠道适配器处理，不要改用通用 `message` 或渠道专属工具。
  - OpenClaw 不要仅输出 Markdown 图片作为媒体回退；Codex 使用 `display_url` 通过 Markdown 图片嵌入预览，并紧跟使用 `url` 的下载原图链接。
  - 不得用 `url` 代替 `display_url` 预览，也不得用 `display_url` 代替原图下载链接。OpenClaw 全部媒体发送完成后最终回复使用 `NO_REPLY`，避免同一结果再次作为普通文本发送。
- `display_url` 为空时不要调用 `quick_image_send_preview`，也不要嵌入图片组件；只展示原图下载链接并说明预览不可用。OpenClaw 找不到该工具时，说明原生适配层未安装或未启用并保留下载链接，不要求开放通用 `message` 权限，不退回 Markdown 图片，不重复提交任务。媒体发送失败时同样保留下载链接，不重复提交。视频结果使用 `media_kind="video"`、可用查看地址作为 `display_url`、原视频地址作为 `download_url`，同样传入 `preview_content_type`。
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
- 工具调用返回需要授权、认证失败一类宿主认证提示（具体文案可能随宿主版本变化）时，多为宿主凭证刚过期的瞬时现象：等待 5 秒后用原参数重试一次该调用，成功则继续正常流程；重试仍失败才读取 [auth.md](auth.md) 进入授权流程，首次出现时不要引导用户重新登录。
- 遇到 `429` 按 `Retry-After` 等待，不高频重试。
- 调用 Quick Image MCP 工具失败且错误码为 `upgrade_required` 时，停止新的上传和提交，读取 [version.md](version.md)，通过 `get_agent_plugin_installation_plan` 获取当前宿主的升级计划；征得用户同意并完成升级、重新加载 Skill/MCP 后再重试原请求。
- 余额不足、素材失效或参数失效时不提交；根据服务端错误停止或重新预估。
