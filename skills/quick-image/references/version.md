# 版本升级

用户询问是否有新版本、明确请求更新 Plugin，或 MCP 工具返回 `upgrade_required` 时读取本文件。

## 处理规则

先调用远程 `get_agent_plugin_installation_plan`，再根据用户意图处理：

- 用户检查更新：`update_available` 为 false 时，告知用户当前已是最新版本；为 true 时，告知用户 `latest_version` 并询问是否安装，确认后按照返回的 `prompt` 安装。
- 用户明确请求更新：有新版本时直接按照返回的 `prompt` 安装；没有新版本时告知用户当前已是最新版本。
- 用户明确请求重装：无论是否有新版本，都按照返回的 `prompt` 重新安装。
- MCP 返回 `upgrade_required`：告知用户需要更新，确认后按照返回的 `prompt` 安装。

如果工具不可用或安装失败，停止并向用户报告错误。
