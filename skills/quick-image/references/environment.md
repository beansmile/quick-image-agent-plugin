# 环境检查与重置为正式环境

安装或更新完成后按安装指令确认 Quick Image 是否为正式环境，`check_environment` 显示不是正式环境，或用户要求检查环境、恢复正式环境时读取本文件。

## 检查当前环境

优先调用本地环境检查工具——Codex 为 `check_environment`，OpenClaw 为 `quick_image_check_environment`：它返回 Codex 与 OpenClaw 宿主当前生效的 Quick Image 是否为正式环境（production），以及配置来源与该宿主是否可检查，不返回任何服务器或前端地址。`is_production` 为 `false` 表示当前是测试环境；为 `null` 表示该宿主无法检查。

当前任务无法调用该工具时（例如插件刚完成全新安装、本地工具尚未加载），直接按本文件重置即可：重置命令对已处于正式环境的机器是安全的，Codex 只会删除本机的环境管理区块并回落插件清单的正式默认地址，OpenClaw 则把 Quick Image MCP 写回正式环境配置。

## 重置为正式环境

需要把本机 Quick Image 恢复为正式环境时，执行以下固定命令：

```bash
npx --yes --prefer-online \
  --package https://github.com/beansmile/quick-image-agent-runtime/releases/latest/download/quick-image-agent-runtime.tgz \
  quick-image env reset --host codex
```

`--host` 可选 `codex`、`openclaw` 或 `all`，按用户实际使用的宿主选择。Codex 的环境覆盖保存在 `~/.codex/config.toml` 末尾带标记的管理区块，`reset` 只删除该区块并自动回落到插件清单的正式默认地址，不影响 `config.toml` 中的其他内容。OpenClaw 的环境切换通过宿主 MCP 配置生效，`reset` 会把 Quick Image MCP 写回正式环境配置并立即重载，无需重启 Gateway。

重置完成后，按重置的宿主执行对应步骤：

1. 环境切换不会迁移已有登录凭据，需要重新完成授权：Codex 执行 `codex mcp login quick-image`，OpenClaw 执行 `openclaw mcp login quick-image`；
2. Codex 需要完全退出并重启 Codex，再新建一个 Codex 任务，以加载新的 Skill 和 MCP 工具；OpenClaw 的 MCP 配置已随重置命令即时重载，仅当后续工具调用异常时再执行 `openclaw gateway restart`；
3. 可再次调用环境检查工具（Codex 为 `check_environment`，OpenClaw 为 `quick_image_check_environment`）确认已恢复正式环境。

重置命令执行失败时，停止并向用户报告错误，不要尝试修改 `config.toml` 或其他配置文件。
