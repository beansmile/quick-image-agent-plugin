# Quick Image Agent Plugin

Quick Image Agent Plugin 让 Codex 和 OpenClaw 可以使用当前对话中的图片、视频音频附件完成 AI 图片和视频生成。

- 支持搭配出图、换姿、高清和视频生成。
- 创建任务前先展示预估价格，只有在你确认后才处理并上传附件。
- 生成完成后返回预览和原文件下载链接。

[Quick Image 官网](https://quickimage.ai) · [https://github.com/beansmile/quick-image-agent-plugin](https://github.com/beansmile/quick-image-agent-plugin)

本仓库源码公开可查看，但不是开源软件。安装和使用受 [Quick Image Agent Plugin License](LICENSE)、[服务条款](https://quickimage.ai/terms)和[隐私政策](https://quickimage.ai/privacy)约束。

## 使用要求

- 一个可正常登录的 Quick Image 账号。
- Codex，或 OpenClaw 2026.6.34 及以上版本。
- macOS、Linux 或 Windows WSL2；暂不支持原生 Windows。
- Codex 本地工具和 OpenClaw 需要 Node.js 20 或更高版本。

## 安装

### Codex

Quick Image 暂未上架 Codex 官方 Plugin Marketplace，请从 GitHub 仓库安装：

```bash
codex plugin marketplace add https://github.com/beansmile/quick-image-agent-plugin
codex plugin add quick-image@quick-image
```

安装后按 Codex 提示登录 Quick Image 并批准授权，然后新建一个 Codex 任务，让 Skill 和 MCP 工具生效。

首次授权会打开 Quick Image 登录和授权页。批准后，浏览器会自动返回 Codex 并完成登录，不需要手工复制授权码。

插件固定使用经过验证的 Quick Image Agent Runtime 版本。Codex 首次加载本地工具、OpenClaw 安装插件依赖时，只会安装当前平台所需的媒体处理依赖，不会下载其他操作系统的二进制。

### OpenClaw

安装并启用插件：

```bash
openclaw plugins install git:https://github.com/beansmile/quick-image-agent-plugin.git
openclaw plugins enable quick-image
```

然后运行安装向导：

```bash
openclaw quick-image setup
```

`setup` 会在保留原有条目的前提下，将 `quick-image` 加入 `tools.alsoAllow`，登记正式环境 MCP，然后重启 Gateway 以加载配置。重复执行不会重复添加工具权限；检测到自定义 Quick Image MCP 地址时，只有确认后才会替换，非交互环境则保留已有的自定义 MCP 配置。

#### 登录或重新登录 MCP

`setup` 完成后、登录失效或需要切换账号时，执行：

```bash
openclaw mcp login quick-image
```

登录命令会输出授权链接，该链接会直接进入 Quick Image 前台登录和授权页。浏览器批准后，授权完成页会显示一次性授权码和已经填好授权码的完整命令，请将该命令粘贴到终端执行，例如：

```bash
openclaw mcp login quick-image --code '<授权码>'
openclaw gateway restart
```

Gateway 重启后会重新加载 MCP 配置和登录凭据。若新对话中仍无法使用 Quick Image，再执行 `openclaw mcp probe quick-image` 排查连接状态。

#### 安装验证与故障排查

Doctor 不是安装或启用插件的必要步骤。首次安装后想集中检查工具策略、媒体依赖、私有状态目录和上传策略，或遇到 Quick Image 工具不可用时，可选执行：

```bash
npx --yes \
  --package git+https://github.com/beansmile/quick-image-agent-plugin.git \
  quick-image-doctor --host openclaw
```

命令只执行诊断，不修改 OpenClaw 配置。输出 `ok: false` 时，根据对应检查项修复后重启 Gateway。

## 如何使用

安装并授权后，在新对话中发送所需附件，再直接描述生成目标。例如：

- “用我发送的这些服装图片生成一组搭配图。”
- “把这张人物照片换成站立回头的姿势。”
- “把这张图片提升为高清版本。”
- “参考这张图片和这段音频生成一个视频。”

Quick Image 会先检查附件并给出预估价格。确认价格前不会处理、暂存或上传附件；确认后才会准备附件并创建生成任务。任务完成后，Codex 会在当前任务中返回结果，OpenClaw 会将结果发送到发起请求的会话。

## 数据与权限

- 插件只处理当前对话中明确提供的附件，不提供任意本地文件读取能力。
- 报价阶段不上传附件、不扣费，也不锁定最终价格；最终校验和计费以服务端结果为准。

## 更多文档

- 本地开发、架构契约和发布校验：[DEVELOPMENT.md](DEVELOPMENT.md)
- 使用问题与贡献政策：[CONTRIBUTING.md](CONTRIBUTING.md)
