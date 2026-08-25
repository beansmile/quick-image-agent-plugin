---
name: quick-image
description: 使用 Quick Image 对当前对话附件执行搭配出图、换姿、高清或视频生成。用户要求基于图片、视频或音频生成内容、查询 Quick Image 任务或查看生成结果时使用；必须先读取公开配置并本地预估报价，确认后再执行安全附件上传、幂等提交和限速轮询流程。
---

# Quick Image 生成

严格按顺序执行。本地配置报价只用于用户确认和体验；服务端是素材归属、参数、最终价格、余额、扣费、幂等和任务状态的唯一权威来源。

## 核心安全边界

- 只处理当前对话中明确提供的附件、当前对话已返回的 Quick Image `asset_id`，或本次配置返回的模板；不列出或搜索用户图库，不创建跨能力流水线，不提供取消、删除、充值或业务重试。
- 不读取或索要 Token、Bearer Token、授权码以外的凭据；不扫描本地目录，不接受模型猜测的路径、任意上传 URL、Base64 或 `media://` 引用。
- 每次请求只创建一个 `lookbook`、`pose`、`upscale` 或 `video` 任务。用户明确要求再次生成属于新任务，必须重新配置、报价和生成新的 UUID v4 幂等键。
- 报价确认前不得准备、上传或提交附件；报价只是预估，最终计价和扣费以服务端结果为准。
- 工具发现、工具审批、绝对路径或媒体校验失败时立即停止；禁止扫描目录、猜测路径或寻找替代入口。

## MCP 连接与授权故障

出现以下任一情况时，立即停止 Quick Image 业务流程，并读取 [auth.md](references/auth.md)：

- MCP 无法连接、不可调用、未出现在工具列表或在启动/发现阶段失败。
- `get_generation_config` 无法调用，导致无法读取实时模板、模型或价格配置。
- 宿主或远程服务返回 `401`、`requires OAuth authorization`、`OAuth credentials are not authorized` 等授权信号。

不得把上述情况改写成“无法可靠列出模板”后直接结束，也不得猜测模板、继续报价、上传或提交任务。状态检查、网络故障分类、用户确认和 Codex/OpenClaw 登录命令全部按 [auth.md](references/auth.md) 执行；用户确认前不得执行登录命令。

## 版本升级

调用 Quick Image MCP 工具失败并返回错误码 `upgrade_required` 时，说明当前 Plugin 或本地桥低于服务端要求的最低版本。立即停止报价、准备、上传和提交，不得通过更换幂等键、Runtime、MCP 地址或 OAuth 配置绕过版本检查。

1. 向用户说明版本过低，并先征得用户同意再执行升级。
2. 读取 [version.md](references/version.md)，只执行当前宿主列出的固定升级命令。

## 按阶段读取规则

只在进入对应阶段时读取 reference，避免把全部能力规则常驻在上下文中：

1. 开始时先按宿主工具发现能力查找 Quick Image 远程工具和本地工具。远程工具包括 `get_generation_config`、`create_direct_upload`、`submit_lookbook_task`、`submit_pose_task`、`submit_upscale_task`、`submit_video_task`、`list_generation_tasks` 和 `get_generation_tasks`；Codex 本地工具包括 `inspect_attachment`、`prepare_attachment`、`estimate_lookbook_credits`、`estimate_pose_credits`、`estimate_upscale_credits`、`estimate_video_credits` 和 `upload_staged_attachment`；OpenClaw 原生工具包括 `quick_image_list_attachments`、`quick_image_inspect_attachment`、`quick_image_prepare_attachment`、`quick_image_estimate_lookbook_credits`、`quick_image_estimate_pose_credits`、`quick_image_estimate_upscale_credits`、`quick_image_estimate_video_credits`、`quick_image_upload_staged_attachment` 和 `quick_image_send_preview`。
2. 发现工具后调用 `get_generation_config`。确定能力、模型、参数、模板、附件角色和动态限制前，读取 [parameters.md](references/parameters.md)。不要使用记忆中的旧配置或固定限制。
3. 任务需要附件时，读取 [attachments.md](references/attachments.md)，再选择并检查附件并保留一次性 `attachment_handle`。检查阶段不得准备、上传或创建直传信息。
4. 需要报价、等待用户确认、确认后上传或提交任务时，读取 [submission.md](references/submission.md)。只调用与当前能力对应的估价和提交工具；本地预估完成并取得用户确认后才执行上传，余额不足时立即停止。
5. 任务提交成功、需要轮询、发送结果或查询历史时，读取 [results.md](references/results.md)。
6. 工具字段语义不明确时读取 [tools.md](references/tools.md)；它是工具契约参考，不替代当前 MCP Schema 或 `get_generation_config` 返回的动态约束。
7. 进入版本升级流程时读取 [version.md](references/version.md)，完成宿主版本升级后再恢复业务流程。

## 宿主边界

- OpenClaw 只执行 owner 发出的 Quick Image 指令。明确为非 owner 或无法确认时，不调用任何 Quick Image 本地或远程工具，只说明该能力仅供 owner 使用；这是 Skill 行为约束，不是原生运行时安全边界。
- OpenClaw 找不到 `quick_image_list_attachments` 时，先读取 [attachments.md](references/attachments.md) 中的宿主故障处理，不得声称附件尚未生成、要求用户反复重发附件或开放通用 `message` 权限。
- 不扫描插件或工作区源码，不检查端口，也不寻找替代上传入口。

## 失败处理总则

- 配置、媒体元数据、价格候选或工具响应缺少完成安全校验所需字段时停止，不猜测、不回退、不继续上传。
- 网络超时或响应丢失不等于任务失败；按 [submission.md](references/submission.md) 使用原参数和原幂等键确认状态。
- 远程工具与响应字段见 [tools.md](references/tools.md)。
