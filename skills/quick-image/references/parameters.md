# 生成参数

## 通用解析规则

1. 先读取 `get_generation_config`，再形成一份用于报价、确认和提交的完整业务参数。
2. 用户明确指定的合法值覆盖配置默认值；有默认值的可选参数不询问用户，但影响输出或价格时必须在完整业务参数中显式保留。
3. 只询问必填且没有默认值的信息。无关字段、未选择的互斥字段、空字符串和空数组不得传入。
4. `asset_id` 只能来自当前对话附件上传结果或当前对话已有的 Quick Image 结果；模板 ID 只能来自本次 `get_generation_config` 返回值。附件角色必须来自用户表述，不根据附件顺序或画面内容猜测。
5. 四个能力专用估价工具只负责确定性计费，不负责补默认值或选择 Prompt 来源；调用前必须完成业务参数解析。
6. 能力由所选提交工具确定，arguments 中不传 `capability`。报价返回的 `estimated_output_count` 是派生展示值，不得作为提交字段。

### 模板展示与回复解析

需要用户在搭配或换姿模板与自定义效果之间选择时：

1. 按本次 `get_generation_config` 返回的当前能力模板原始顺序完整展示，不重新排序；在模板名称前添加从 1 开始的序号，格式为 `1. <模板名称>`。可以同时展示配置提供的公开描述和预览地址，但不得展示内部 Prompt。
2. 列表末尾提示：回复序号或模板名称可选择模板，也可以直接描述想要的自定义效果。
3. 用户回复纯序号、`第 N 个` 或 `N 号`时，只按最近一次展示的当前能力模板列表解析；序号在范围内时选择对应模板 ID。
4. 用户回复文字时，完整模板名称或唯一且无歧义的模板名称匹配表示选择模板；否则将文字视为自定义效果，搭配传入 `custom_prompt`，换姿传入 `custom_prompt`。
5. 序号越界、模板名称匹配多个选项，或用户同时选择模板和自定义效果但未说明主次时，重新询问。不得使用旧列表、其他能力的列表或模型猜测来选择模板。

## 搭配出图 `lookbook`

- `input_asset_ids`：图片素材，必填。
- `custom_prompt` / `style_preset_id`：二选一。
- `additional_prompt`：使用预设时可选。
- `model`、`output_count`、`aspect_ratio`、`resolution`：使用当前配置允许的值与默认值。

Prompt 来源选择：

- 用户直接描述穿搭、风格或场景时，只传 `custom_prompt`。
- 用户明确选择 `get_generation_config` 返回的搭配模板时，只传 `style_preset_id`；额外要求放入 `additional_prompt`。
- 用户只说“搭配出图”但没有描述风格、也没有选择预设时，按“模板展示与回复解析”列出搭配模板并询问用户，不替用户选择。

## 换姿 `pose`

- `person_asset_ids`：人物图片素材，必填。
- `custom_prompt` / `photo_type_preset_id` / `pose_reference_asset_id`：三选一。
- `additional_prompt`：可选。
- `model`、`output_count_per_person`、`aspect_ratio`、`resolution`：使用当前配置允许的值与默认值。

最终输出数为人物数乘以单人输出数。

Prompt 来源选择：

- 只有人物原图、没有单独姿势参考图，且用户描述了目标姿势：只传 `custom_prompt`，人物图只放入 `person_asset_ids`。
- 只有人物原图，但用户只说“换姿”而没有描述目标姿势：按“模板展示与回复解析”列出换姿模板，询问用户选择模板或描述目标姿势；选择自定义效果时使用 `custom_prompt`。不得把人物原图同时作为姿势参考图。
- 用户明确选择 `get_generation_config` 返回的换姿模板：只传 `photo_type_preset_id`。
- 用户明确提供另一张图片作为姿势参考：人物原图放入 `person_asset_ids`，参考图只传 `pose_reference_asset_id`。
- 用户在预设或参考图基础上补充要求：补充内容传 `additional_prompt`。
- 多张图片的角色不明确时先询问；不得默认最后一张是参考图。

## 高清 `upscale`

- `input_asset_ids`：图片素材，必填；输出数等于输入数。
- `upscale_style`：使用当前配置允许的值与默认值。

## 视频 `video`

- `model`、`mode`：使用当前配置允许的组合与默认值。先根据用户意图确定模式，再验证模型是否支持；用户指定的模型不支持目标模式时，展示兼容模型并询问，不静默切换。
- `prompt`：`omni_reference` 和 `first_last_frame` 必填；`storyboard` 不传全局 `prompt`。
- `aspect_ratio`、`duration_seconds`、`resolution`、`generate_audio`：使用当前配置允许的值与默认值。`storyboard` 的 `duration_seconds` 是各镜头 `duration` 之和，报价、确认和提交复用这个计算值。
- `reference_asset_ids`：只用于 `omni_reference` 和 `first_last_frame`，并按下面的模式规则组织。
- `storyboard`：只用于 `storyboard` 模式；其他模式不得传入。

### 模式选择

用户明确指定且当前模型支持的模式优先。否则先按用户意图选择模式，再选择或校验模型：

1. 用户指定了模型但未指定模式时，只在该模型的 `default_mode` 满足当前输入要求时采用默认模式。
2. 用户没有指定模型时，优先使用顶层默认模型；若其不支持意图对应的模式，展示当前配置中的兼容模型并询问。
3. 任何默认模式缺少必需附件或描述时都不能直接提交，按下面规则询问缺失意图或提供兼容选择。

| 用户意图 | 模式 | 判断重点 |
| --- | --- | --- |
| 使用人物、商品、风格图片，或参考视频的动作、运镜，生成一个连续视频 | `omni_reference` | 素材用于整体参考，不要求成为精确的首帧或尾帧 |
| 将一张图片作为准确首帧动起来，或明确指定首帧与尾帧之间的变化 | `first_last_frame` | 第一张图是首帧，第二张图（如有）是尾帧 |
| 用户逐镜描述多个镜头、场景切换、分段时长或叙事顺序 | `storyboard` | 每个镜头有独立描述和时长，可按模型能力附带镜头帧 |
| 纯文字生成视频，用户没有指定模型或模式 | 当前配置默认模型与模式 | 仅当该组合不要求参考附件时采用；否则展示支持纯文字输入的配置选项并询问 |

以下情况必须先询问，不得自行判断：

- 多张图片可能既是普通参考，也可能是首尾帧或不同分镜帧。
- 用户只说“参考这些素材”，但没有说明视频、音频或多张图片各自承担的角色。
- 用户描述既可以理解为一个连续镜头，也可以理解为需要明确切镜的多分镜视频。
- 用户指定的模型与模式不兼容。此时只展示 `get_generation_config` 中支持目标模式的公开模型供用户选择。

### 各模式传参

#### 全能参考 `omni_reference`

- `prompt` 必填，描述最终视频内容和运动。
- 图片、视频和音频引用放入 `reference_asset_ids`；仅传用户已明确其参考角色的素材。
- 视频引用和音频引用只有在所选模型的当前配置明确支持时才能传入。
- 音频不能单独作为输入，必须同时有图片或视频；有音频引用时 `generate_audio` 必须为 `true`。
- 不传 `storyboard`。

示例：用户要求“参考人物图保持角色一致，并参考这段视频的运镜”，选择 `omni_reference`，人物图和参考视频的 `asset_id` 都放入 `reference_asset_ids`。

#### 首尾帧 `first_last_frame`

- `prompt` 必填，描述首帧之后的运动、变化或首尾帧之间的过渡。
- 只接受图片引用：`reference_asset_ids[0]` 是必填首帧，`reference_asset_ids[1]` 是可选尾帧，不能再传更多图片。
- 不传视频、音频或 `storyboard`。
- 只有一张图片时，必须确认用户希望它作为精确首帧；如果只是人物、商品或风格参考，改用 `omni_reference`。

示例：用户要求“以图片 A 开场，镜头推进并最终变成图片 B”，选择 `first_last_frame`，按 `[A, B]` 传入 `reference_asset_ids`。

#### 分镜 `storyboard`

- 不传 `prompt` 和 `reference_asset_ids`。
- `storyboard` 是按播放顺序排列的数组，每项包含：
  - `description`：必填，当前镜头的画面、主体动作和镜头运动。
  - `duration`：必填，当前镜头秒数，必须符合所选模型的 `storyboard.shot_duration_range`。
  - `asset_id`：可选镜头帧；是否允许、哪些镜头允许，严格按所选模型的 `storyboard.frame_policy`。
- 镜头数量不得超过 `storyboard.max_shots`；每个 `description` 不得超过配置给出的 `storyboard.prompt_max_length`。
- `duration_seconds` 必须等于所有镜头 `duration` 之和，并同时满足模型的总时长限制。

示例结构：

```json
{
  "model": "<当前配置中的公开模型 ID>",
  "mode": "storyboard",
  "aspect_ratio": "<配置允许值>",
  "resolution": "<配置允许值>",
  "generate_audio": true,
  "duration_seconds": 8,
  "storyboard": [
    { "asset_id": "<可选当前对话素材 ID>", "description": "建立场景并缓慢推进镜头", "duration": 3 },
    { "description": "主体转身，镜头跟随进入下一场景", "duration": 5 }
  ]
}
```

### 动态限制检查

提交前逐项读取所选模型在 `get_generation_config` 中的公开能力，不得把示例值当成固定限制：

- `supported_modes`、`resolutions`、`duration_options` 和 `generate_audio`。
- 图片引用上限，以及视频、音频引用是否可用。
- 视频和音频引用的格式、文件大小、单个时长、总时长与数量限制。
- `storyboard.max_shots`、`shot_duration_range`、`frame_policy` 和 `prompt_max_length`。
- 顶层 `aspect_ratios`、`duration_seconds`、`reference_assets` 和 `media_constraints`。

当前配置缺少完成校验所需的字段时停止并说明，不能使用记忆中的旧限制。音频不能单独作为视频输入；附件角色不明确时先询问，不根据附件顺序或画面内容猜测。

`get_generation_config` 是当前开放模型、模式、默认值、价格和动态限制的最终来源，各能力专用提交工具 Schema 是请求结构的最终边界。不要把内部供应商路由、工作流版本或 Blob ID 传给工具。

## 本地估价工具

| 能力 | Codex 本地 MCP | OpenClaw 原生工具 | 直接参数 |
| --- | --- | --- | --- |
| 搭配出图 | `estimate_lookbook_credits` | `quick_image_estimate_lookbook_credits` | `pricing`、`preset`、`preset_price_behavior`、`output_count` |
| 换姿 | `estimate_pose_credits` | `quick_image_estimate_pose_credits` | `pricing`、`preset`、`preset_price_behavior`、`person_count`、`output_count_per_person` |
| 高清 | `estimate_upscale_credits` | `quick_image_estimate_upscale_credits` | `pricing`、`input_count` |
| 视频 | `estimate_video_credits` | `quick_image_estimate_video_credits` | `pricing`、`output_duration_seconds`、`input_video_duration_seconds` |

四个工具都必须接收当前配置的 `estimation_contract_version` 和完整 `confirmation_thresholds`。搭配、换姿未选择预设时 `preset` 传 `null`；视频没有输入视频时 `input_video_duration_seconds` 传 `null`。不得跨能力调用、传 `capability`、自行选择图片价格来源、拼接价格字段、改变费率或由模型重复计算结果。
