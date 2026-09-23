import type { CommandExecutor } from "./command-executor.js";
import { systemCommandExecutor } from "./command-executor.js";
import {
  buildOpenClawLocalMcpConfig,
  buildOpenClawMcpConfig,
  productionEnvironmentUrls,
  QUICK_IMAGE_LOCAL_MCP_NAME,
  QUICK_IMAGE_MCP_NAME
} from "./config.js";
import { resolveOpenClawExecutable } from "./executables.js";

const OPENCLAW_PLUGIN_ID = "quick-image";
const LOGIN_COMMAND = "openclaw mcp login quick-image";

export interface OpenClawSetupResult {
  toolAccessChanged: boolean;
}

interface OpenClawSetupOptions {
  pluginVersion: string;
  openClawBin?: string;
  executor?: CommandExecutor;
}

export async function setupOpenClaw(options: OpenClawSetupOptions): Promise<OpenClawSetupResult> {
  const openClawBin = resolveOpenClawExecutable(options.openClawBin);
  const executor = options.executor ?? systemCommandExecutor;

  const toolAccessChanged = ensureToolAccess(openClawBin, executor);
  configureProductionMcp({
    openClawBin,
    executor,
    pluginVersion: options.pluginVersion
  });
  configureLocalMcp({ openClawBin, executor });

  // 重新加载 MCP runtime，避免重启 Gateway 中断正在执行 setup 的会话。
  executor.run(openClawBin, ["mcp", "reload"]);

  return { toolAccessChanged };
}

export function formatOpenClawSetupResult(result: OpenClawSetupResult): string {
  const toolAccess = result.toolAccessChanged
    ? "已将 quick-image 与 quick-image-local 加入 tools.alsoAllow，并保留原有条目。"
    : "tools.alsoAllow 已包含 quick-image 与 quick-image-local。";
  return [
    "Quick Image OpenClaw 配置完成。",
    toolAccess,
    "已设置 Quick Image 正式环境远程 MCP（quick-image）与本地处理 MCP（quick-image-local）。",
    "已重新加载 MCP 配置。",
    "如需登录 Quick Image MCP，无需用户手动执行命令：Agent 直接运行以下命令，从输出中提取授权链接发送给用户，再等待用户回传授权码（仅用户手动安装时才由用户在本机终端执行）：",
    LOGIN_COMMAND
  ].join("\n") + "\n";
}

function ensureToolAccess(openClawBin: string, executor: CommandExecutor): boolean {
  const tools = readOptionalConfigObject(openClawBin, executor, "tools") ?? {};
  const current = readStringArray(tools.alsoAllow, "tools.alsoAllow");
  // 插件 ID 放行原生工具；本地 MCP server 名放行 quick-image-local__* 全部工具。
  const merged = [...new Set([...current, OPENCLAW_PLUGIN_ID, QUICK_IMAGE_LOCAL_MCP_NAME])];
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

function configureProductionMcp(options: {
  openClawBin: string;
  executor: CommandExecutor;
  pluginVersion: string;
}): void {
  const config = buildOpenClawMcpConfig(productionEnvironmentUrls(), options.pluginVersion);
  options.executor.run(options.openClawBin, [
    "mcp",
    "set",
    QUICK_IMAGE_MCP_NAME,
    JSON.stringify(config)
  ]);
}

function configureLocalMcp(options: {
  openClawBin: string;
  executor: CommandExecutor;
}): void {
  const config = buildOpenClawLocalMcpConfig();
  options.executor.run(options.openClawBin, [
    "mcp",
    "set",
    QUICK_IMAGE_LOCAL_MCP_NAME,
    JSON.stringify(config)
  ]);
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
