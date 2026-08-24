import { createInterface } from "node:readline/promises";
import type { CommandExecutor, InteractiveCommandExecutor } from "./command-executor.js";
import {
  systemCommandExecutor,
  systemInteractiveCommandExecutor
} from "./command-executor.js";
import {
  buildOpenClawMcpConfig,
  productionEnvironmentUrls,
  QUICK_IMAGE_MCP_NAME,
  QUICK_IMAGE_PRODUCTION_SERVER_URL
} from "./config.js";
import { resolveOpenClawExecutable } from "./executables.js";

const OPENCLAW_PLUGIN_ID = "quick-image";
const MANUAL_LOGIN_COMMAND = "openclaw mcp login quick-image";

export interface ConfirmationPrompt {
  readonly interactive: boolean;
  confirm(message: string, defaultValue: boolean): Promise<boolean>;
}

export type OpenClawSetupMcpAction = "created" | "updated" | "kept-custom";
export type OpenClawSetupLoginAction = "started" | "skipped" | "failed";

export interface OpenClawSetupResult {
  toolAccessChanged: boolean;
  mcpAction: OpenClawSetupMcpAction;
  loginAction: OpenClawSetupLoginAction;
  loginError?: string;
}

interface OpenClawSetupOptions {
  pluginVersion: string;
  openClawBin?: string;
  executor?: CommandExecutor;
  interactiveExecutor?: InteractiveCommandExecutor;
  prompt?: ConfirmationPrompt;
}

export async function setupOpenClaw(options: OpenClawSetupOptions): Promise<OpenClawSetupResult> {
  const openClawBin = resolveOpenClawExecutable(options.openClawBin);
  const executor = options.executor ?? systemCommandExecutor;
  const interactiveExecutor = options.interactiveExecutor ?? systemInteractiveCommandExecutor;
  const prompt = options.prompt ?? terminalConfirmationPrompt();

  const toolAccessChanged = ensureToolAccess(openClawBin, executor);
  const mcpAction = await configureProductionMcp({
    openClawBin,
    executor,
    prompt,
    pluginVersion: options.pluginVersion
  });

  let loginAction: OpenClawSetupLoginAction = "skipped";
  let loginError: string | undefined;
  if (prompt.interactive && await prompt.confirm("是否现在登录 Quick Image MCP？", true)) {
    try {
      interactiveExecutor.run(openClawBin, ["mcp", "login", QUICK_IMAGE_MCP_NAME]);
      loginAction = "started";
    } catch (error) {
      loginAction = "failed";
      loginError = errorMessage(error);
    }
  }

  // 登录是可选步骤；只要基础配置成功，始终让宿主重新加载配置。
  executor.run(openClawBin, ["mcp", "reload"]);
  executor.run(openClawBin, ["gateway", "restart"]);

  return {
    toolAccessChanged,
    mcpAction,
    loginAction,
    ...(loginError ? { loginError } : {})
  };
}

export function formatOpenClawSetupResult(result: OpenClawSetupResult): string {
  const toolAccess = result.toolAccessChanged
    ? "已将 quick-image 加入 tools.alsoAllow，并保留原有条目。"
    : "tools.alsoAllow 已包含 quick-image。";
  const mcp = result.mcpAction === "created"
    ? "已登记 Quick Image 正式环境 MCP。"
    : result.mcpAction === "updated"
      ? "已更新 Quick Image 正式环境 MCP。"
      : "已保留现有的 Quick Image 自定义 MCP 配置。";
  const login = result.loginAction === "started"
    ? "已启动 MCP 登录；请按终端中的授权提示完成操作。"
    : result.loginAction === "failed"
      ? `MCP 登录未完成：${result.loginError ?? "未知错误"}\n稍后可运行：${MANUAL_LOGIN_COMMAND}`
      : `未启动 MCP 登录。稍后可运行：${MANUAL_LOGIN_COMMAND}`;

  return [
    "Quick Image OpenClaw 配置完成。",
    toolAccess,
    mcp,
    login,
    "已重新加载 MCP 并重启 Gateway。"
  ].join("\n") + "\n";
}

function ensureToolAccess(openClawBin: string, executor: CommandExecutor): boolean {
  const tools = readOptionalConfigObject(openClawBin, executor, "tools") ?? {};
  const current = readStringArray(tools.alsoAllow, "tools.alsoAllow");
  const merged = [...new Set([...current, OPENCLAW_PLUGIN_ID])];
  if (arraysEqual(current, merged)) return false;

  executor.run(openClawBin, [
    "config",
    "set",
    "tools.alsoAllow",
    JSON.stringify(merged),
    "--strict-json"
  ]);
  return true;
}

async function configureProductionMcp(options: {
  openClawBin: string;
  executor: CommandExecutor;
  prompt: ConfirmationPrompt;
  pluginVersion: string;
}): Promise<OpenClawSetupMcpAction> {
  const servers = readOptionalConfigObject(options.openClawBin, options.executor, "mcp.servers") ?? {};
  const existing = servers[QUICK_IMAGE_MCP_NAME];
  let action: OpenClawSetupMcpAction = "created";

  if (existing !== undefined) {
    if (!isObject(existing) || existing.url !== QUICK_IMAGE_PRODUCTION_SERVER_URL) {
      const replace = options.prompt.interactive && await options.prompt.confirm(
        "检测到自定义 Quick Image MCP 配置，是否替换为正式环境？",
        false
      );
      if (!replace) return "kept-custom";
    }
    action = "updated";
  }

  const config = buildOpenClawMcpConfig(productionEnvironmentUrls(), options.pluginVersion);
  options.executor.run(options.openClawBin, [
    "mcp",
    "set",
    QUICK_IMAGE_MCP_NAME,
    JSON.stringify(config)
  ]);
  return action;
}

function readOptionalConfigObject(
  openClawBin: string,
  executor: CommandExecutor,
  path: string
): Record<string, unknown> | undefined {
  let output: string;
  try {
    output = executor.run(openClawBin, ["config", "get", path, "--json"]).stdout;
  } catch (error) {
    if (errorMessage(error).includes("Config path not found:")) return undefined;
    throw error;
  }

  let value: unknown;
  try {
    value = JSON.parse(output);
  } catch {
    throw new Error(`OpenClaw ${path} 配置不是有效 JSON`);
  }
  if (!isObject(value)) throw new Error(`OpenClaw ${path} 配置必须是对象`);
  return value;
}

function readStringArray(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length === 0)) {
    throw new Error(`OpenClaw ${field} 配置必须是非空字符串数组`);
  }
  return value;
}

function arraysEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function terminalConfirmationPrompt(): ConfirmationPrompt {
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  return {
    interactive,
    async confirm(message, defaultValue) {
      if (!interactive) return defaultValue;
      const readline = createInterface({ input: process.stdin, output: process.stdout });
      try {
        const suffix = defaultValue ? " [Y/n] " : " [y/N] ";
        const answer = (await readline.question(message + suffix)).trim().toLowerCase();
        if (answer === "") return defaultValue;
        return answer === "y" || answer === "yes";
      } finally {
        readline.close();
      }
    }
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
