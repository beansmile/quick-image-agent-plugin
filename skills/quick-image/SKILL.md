---
name: quick-image
description: 使用 Quick Image 对当前会话附件或宿主可访问的本地媒体执行搭配出图、换姿、高清或视频生成，或检查、更新或重装 Quick Image Agent Plugin。用户要求基于图片、视频或音频生成内容、查询 Quick Image 任务、查看生成结果，要求更新、重装 Quick Image 插件，或要求退出登录、撤销 Quick Image 授权、切换账号时使用；生成任务必须先读取公开配置并本地预估报价，确认后再执行安全附件上传、幂等提交和限速轮询流程；更新或重装需先从服务端获取安装指令再执行；退出登录需先向用户确认影响再调用撤销工具，撤销失败时引导用户到前台授权管理页自行撤销；
---

# Quick Image 生成

严格按顺序执行。本地配置报价只用于用户确认和体验；服务端是素材归属、参数、最终价格、余额、扣费、幂等和任务状态的唯一权威来源。

## 核心安全边界

- 媒体默认按不透明输入处理：除非用户明确要求分析、描述、识别或提取图片、音频、视频内容，否则不要主动打开、预览、转录、采样或进行任何语义分析。只使用用户文字和必要的基础文件信息（文件名、媒体类型、字节大小，以及为校验限制所必需的技术元数据）；不得根据画面、声音或视频帧猜测附件角色、内容或用户意图。信息不足时先询问用户。
- 只处理当前会话中明确提供的附件、宿主或 AI 根据用户意图确定的本地媒体路径或媒体引用、用户明确提供且服务端可验证的 Quick Image `asset_id`，或本次配置返回的模板；不列出或搜索 Quick Image 用户图库，不在用户未要求时自动串联能力，不提供独立的取消、删除或充值工具。
- 不读取或索要 Token、Bearer Token、授权码以外的凭据；本地文件需求可以使用宿主原生的路径解析、目录浏览、文件搜索或文件读取能力。已有具体绝对路径或 Runtime 支持的媒体引用时可直接传入，插件信任该输入，实际可读范围由宿主进程的系统文件权限和 Runtime 的引用解析规则决定；不接受任意上传 URL 或 Base64。
- 每个逻辑任务创建一个 `lookbook`、`pose`、`upscale` 或 `video` 任务。用户一次提出多个任务时，按任务分别确定参数和报价，可合并展示各任务报价与预计总积分，并取得一次覆盖全部任务的明确确认；随后仍须为每个任务分别生成 UUID v4 幂等键并提交。用户明确要求再次生成属于新任务。
- 报价确认前不得准备、上传或提交附件；有效确认只能是用户在看到报价后主动发送、表达明确生成意图的消息，用户未回复、回复无关内容、超时、宿主事件或会话恢复都不得视为确认。报价只是预估，最终计价和扣费以服务端结果为准。
- 工具发现、目标路径确定或媒体校验失败时立即停止；没有明确的本地文件处理意图时，不主动扫描无关目录或寻找替代入口。

## MCP 连接与授权故障

出现以下任一情况时，立即停止 Quick Image 业务流程，并读取 [auth.md](references/auth.md)：

- MCP 无法连接、不可调用、未出现在工具列表或在启动/发现阶段失败。
- `get_generation_config` 无法调用，导致无法读取实时模板、模型或价格配置。
- 宿主或远程服务返回 `401`、`requires OAuth authorization`、`OAuth credentials are not authorized` 等授权信号（具体文案可能随宿主版本变化）。其中会话中途单次出现的认证类提示多为宿主凭证刚过期，先按 [auth.md](references/auth.md) 第 0 节等待 5 秒后重试一次；重试成功则继续流程，不进入授权流程。

不得把上述情况改写成“无法可靠列出模板”后直接结束，也不得猜测模板、继续报价、上传或提交任务。会话重置提示、状态检查、MCP 配置重载、网络故障分类、用户确认和各宿主登录命令全部按 [auth.md](references/auth.md) 执行；用户确认前不得执行登录命令。

用户主动要求登录 Quick Image 时，同样读取 [auth.md](references/auth.md) 并直接按其中宿主登录流程执行。

用户主动要求退出登录、撤销 Quick Image 授权或切换账号时，读取 [signout.md](references/signout.md) 并按其中流程执行；用户确认前不得调用 `revoke_authorization`，用户只是排障或表达不满时不得主动撤销。

## 版本升级与重装

用户询问是否有新版本、明确请求更新或重装 Plugin，或 MCP 工具返回 `upgrade_required` 时，读取 [version.md](references/version.md) 并按其中流程处理。发生 `upgrade_required` 时，完成更新前停止当前生成流程。

## 按阶段读取规则

只在进入对应阶段时读取 reference，避免把全部能力规则常驻在上下文中：

1. 开始时先按宿主工具发现能力查找 Quick Image 远程工具和本地工具。远程工具包括 `get_agent_plugin_installation_plan`、`get_generation_config`、`create_direct_upload`、`submit_lookbook_task`、`submit_pose_task`、`submit_upscale_task`、`submit_video_task`、`list_generation_tasks`、`get_generation_tasks` 和用于退出登录的 `revoke_authorization`。本地工具由 `quick-image-local` 本地 MCP 提供：`inspect_attachment`、`prepare_attachment`、`upload_staged_attachment`、`download_preview_media`、`estimate_lookbook_credits`、`estimate_pose_credits`、`estimate_upscale_credits` 和 `estimate_video_credits`。OpenClaw 另有两个专属原生工具：`quick_image_list_attachments`（列出当前会话附件）和 `quick_image_send_preview`（向当前会话发送结果预览）。
2. 发现工具后调用 `get_generation_config`。确定能力、模型、参数、模板、附件角色和动态限制前，读取 [parameters.md](references/parameters.md)。不要使用记忆中的旧配置或固定限制。
3. 任务需要附件时，读取 [attachments.md](references/attachments.md)，根据用户意图从会话附件中选择媒体，或由宿主或 AI 确定本地媒体绝对路径或媒体引用，再检查附件并保留一次性 `attachment_handle`。检查阶段不得准备、上传或创建直传信息。
4. 需要报价、等待用户确认、确认后上传或提交任务时，读取 [submission.md](references/submission.md)。只调用与当前能力对应的估价和提交工具；本地预估完成并取得用户确认后才执行上传，余额不足时立即停止。
5. 任务提交成功、需要轮询、发送结果或查询历史时，读取 [results.md](references/results.md)。
6. 工具字段语义不明确时读取 [tools.md](references/tools.md)；它是工具契约参考，不替代当前 MCP Schema 或 `get_generation_config` 返回的动态约束。
7. 进入版本升级或重装流程时读取 [version.md](references/version.md)，按安装指令完成宿主操作后再恢复业务流程。
8. 进入退出登录、撤销授权或切换账号流程时读取 [signout.md](references/signout.md)，按其中确认、撤销和失败兜底规则执行。

## 宿主边界

- 本 Skill 面向所有支持 MCP 的 Agent 宿主。OpenClaw 额外提供 `quick_image_list_attachments` 与 `quick_image_send_preview` 两个专属原生工具；各阶段规则对所有宿主一致，不因宿主不同而放宽或跳过。
- OpenClaw 只执行 owner 发出的 Quick Image 指令。明确为非 owner 或无法确认时，不调用任何 Quick Image 本地或远程工具，只说明该能力仅供 owner 使用；这是 Skill 行为约束，不是原生运行时安全边界。
- OpenClaw 找不到 `quick_image_list_attachments` 时，先读取 [attachments.md](references/attachments.md) 中的宿主故障处理，不得声称附件尚未生成、要求用户反复重发附件或开放通用 `message` 权限。
- 不扫描插件或工作区源码，不检查端口，也不寻找替代上传入口。

## 失败处理总则

- 配置、媒体元数据、价格候选或工具响应缺少完成安全校验所需字段时停止，不猜测、不回退、不继续上传。
- 网络超时或响应丢失不等于任务失败；按 [submission.md](references/submission.md) 使用原参数和原幂等键确认状态。
- 用户或宿主中断轮询只影响当前等待，不取消服务端任务。下一条用户请求必须重新开始工具发现和配置阶段；除非当前调用明确返回 OAuth 授权错误，否则不要把中断后的会话异常归类为授权失效，也不要阻塞新的逻辑任务。
- 远程工具与响应字段见 [tools.md](references/tools.md)。
