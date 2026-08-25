# MCP 连接、状态检查与授权

本文件是 MCP 故障的唯一处理入口。只要 Quick Image MCP 无法连接、不可调用、未出现在工具列表、在启动/发现阶段失败，或 `get_generation_config` 无法调用，就先停止业务流程并按本文件检查；不得继续列模板、报价、上传或提交任务。

## 1. 检查 MCP 状态

先判断当前宿主，再执行对应的固定命令。命令只用于检查状态，不读取或输出 Token。

### OpenClaw

执行：

```bash
openclaw mcp doctor --probe quick-image --json
```

按结果分类：

- 找不到 `quick-image` server：MCP 尚未配置，先让用户重新安装或启用 Quick Image Plugin，不进入 OAuth。
- 结果包含 OAuth 未授权、`requires OAuth authorization`、`OAuth credentials are not authorized`，或 `probe failed` 的原因是 OAuth：归类为待授权，进入第 2 节。
- 结果明确为 DNS、超时、连接拒绝或其他网络故障：归类为连接故障，停止并报告故障，不执行登录。
- 命令无法执行，或输出只有“工具未连接”且没有明确网络故障：无法证明是网络问题，归类为待授权，进入第 2 节，不得用模板不可用文案结束。

`openclaw mcp status` 只查看本地配置，不连接服务器，不能代替上述探测。

### Codex

Codex CLI 当前没有 `mcp doctor` 或 `mcp probe` 子命令。执行：

```bash
codex mcp get quick-image
```

这个命令只确认 MCP 是否登记及其地址，不验证 OAuth 凭据：

- 命令提示找不到 `quick-image`：MCP 尚未被当前 Codex Plugin 加载，先让用户重新安装或启用 Plugin，不进入 OAuth。
- MCP 已登记，且宿主没有明确 DNS、超时或其他网络故障：归类为待授权，进入第 2 节；OAuth 有效性由 `codex mcp login quick-image` 触发和确认。
- 宿主明确报告网络故障：归类为连接故障，停止并报告故障，不执行登录。

## 2. 待授权时先征得确认

向用户发送以下首句，不要用“无法可靠读取/列出模板”替代：

> Quick Image 当前未登录或授权不可用，需要现在登录吗？

用户明确确认前，不得执行任何登录命令。用户拒绝时停止当前 Quick Image 请求；用户确认后，按当前宿主的登录流程继续。

## 3. Codex 登录流程

用户确认后，通过宿主 `exec` 执行固定命令：

```bash
codex mcp login quick-image
```

该命令会触发浏览器 OAuth。提示用户在浏览器完成 Quick Image 登录和授权；不要索要或展示 Token、授权码或终端中的凭据。授权完成后让用户回到 Codex 并新建任务，以重新加载 MCP 和 Skill；若仍不可用，再完全退出并重新打开 Codex。

如果命令提示找不到 `quick-image` MCP，停止 OAuth，先让用户重新安装或启用 Quick Image Plugin。

## 4. OpenClaw 登录流程

用户确认后，通过宿主 `exec` 执行第一条固定命令：

```bash
openclaw mcp login quick-image
```

从输出中提取 Quick Image 授权 URL 并原样发送给用户，不要替用户打开。提示用户在浏览器登录并批准授权：

- 一次性授权码只能在私聊中发送，不要泄露给其他人。
- 只发送授权码本身，不要发送完整命令、终端输出或授权页面截图。

用户返回授权码后，只接受由 ASCII 字母、数字、`.`、`_`、`~`、`-` 组成且不超过 512 字符的单个值。拒绝包含空白、引号、反引号、变量展开、重定向、完整命令或其他 Shell 内容的输入。

校验通过后，将授权码作为单个参数执行第二条固定命令：

```bash
openclaw mcp login quick-image --code '<code>'
```

不要在回复、日志或后续消息中重复授权码，也不要读取或展示 Token。登录成功后先报告结果，再让用户在当前聊天发送 `/restart`；不要在当前 Agent turn 中执行 `openclaw gateway restart`，避免中断登录结果回复。重启后再重试原请求。

如果第二条命令失败，不要重复展示授权码；根据新的错误重新执行第 1 节状态检查。

## 5. 连接故障边界

只有状态检查明确指向 DNS、超时、连接拒绝或其他非授权网络故障时，才按连接故障停止。不要扫描端口、工作区或插件目录，也不要改用临时 Token、Bearer Token、任意 URL 或其他上传入口。
