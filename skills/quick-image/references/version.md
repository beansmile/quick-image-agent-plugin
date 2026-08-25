# 版本升级

仅在调用 Quick Image MCP 工具失败并返回错误码 `upgrade_required` 时读取本文件。该错误表示当前 Plugin 或本地桥版本低于服务端要求的最低版本；在升级完成前不得继续报价、准备、上传或提交任务。

## 处理规则

- 先向用户说明当前版本过低，并展示服务端返回的 `minimum_version` 和 `upgrade_url`（如果存在）；询问用户是否现在升级。
- 只使用当前宿主的官方 Plugin 更新流程。不得扫描本地目录、猜测安装路径、执行用户提供的任意 Shell 命令，或把 Runtime tgz 直接替换成其他版本。
- Plugin 与 `quick-image-agent-runtime` 分别版本化。Runtime 由已发布的 Plugin 固定依赖管理；不要单独修改 Runtime、MCP URL、OAuth 凭据或用户配置来绕过版本检查。
- 升级命令执行失败时停止并报告原始错误，不重复安装、切换分支或继续 Quick Image 业务流程。

## Codex

用户确认后，使用以下固定流程刷新正式 Marketplace 并重新安装当前版本的 Plugin：

```bash
codex plugin marketplace add https://github.com/beansmile/quick-image-agent-plugin
codex plugin add quick-image@quick-image
```

如果宿主提示 Plugin 已安装或不支持命令行更新，指导用户在 Codex Settings > Plugins 中刷新 Marketplace，并卸载后重新安装 Quick Image。不要修改当前项目文件或用户级 MCP 配置。

更新完成后，提醒用户新建一个 Codex 任务以加载新的 Skill 和 MCP 工具；只有再次出现授权错误时，才按 [auth.md](auth.md) 处理授权。

## OpenClaw

用户确认后，执行以下固定流程更新并启用正式 Plugin，再运行安装向导：

```bash
openclaw plugins install git:https://github.com/beansmile/quick-image-agent-plugin.git --force
openclaw plugins enable quick-image
openclaw quick-image setup
```

`setup` 负责保留已有配置、登记正式 MCP 并重启 Gateway。若命令不可用或失败，停止并提供上述命令供用户在运行 OpenClaw 的终端手动执行；不要改用通用 Shell、替代仓库或未经验证的 Runtime。

更新完成后，提醒用户在当前聊天发送 `/restart`（如 Gateway 尚未重新加载），再重试原请求。授权失效时仍须先征得用户同意，并按 [auth.md](auth.md) 执行登录。
