import type { CommandExecutor } from "./command-executor.js";
import { systemCommandExecutor } from "./command-executor.js";
import {
  QUICK_IMAGE_FRONTEND_HEADER,
  QUICK_IMAGE_MCP_NAME,
  QUICK_IMAGE_PRODUCTION_FRONTEND_URL,
  QUICK_IMAGE_PRODUCTION_SERVER_URL,
  type EnvironmentStatus,
  type EnvironmentUrls
} from "./config.js";
import { resolveCodexExecutable } from "./executables.js";

interface CodexOptions {
  codexBin?: string;
  executor?: CommandExecutor;
}

export async function readCodexEnvironmentStatus(options: CodexOptions): Promise<EnvironmentStatus> {
  const runtime = codexRuntime(options);
  let output: string;
  try {
    output = runtime.executor.run(runtime.codexBin, ["mcp", "get", QUICK_IMAGE_MCP_NAME, "--json"]).stdout;
  } catch {
    return { host: "codex", configured: false, source: "missing" };
  }

  const config = parseCodexMcpOutput(JSON.parse(output));
  const usesProduction = config.serverUrl === QUICK_IMAGE_PRODUCTION_SERVER_URL &&
    config.frontendUrl === QUICK_IMAGE_PRODUCTION_FRONTEND_URL;
  return {
    host: "codex",
    configured: true,
    source: usesProduction ? "plugin-default" : "custom",
    ...config,
    authenticationCommand: "codex mcp login quick-image"
  };
}

function codexRuntime(options: CodexOptions) {
  return {
    codexBin: resolveCodexExecutable(options.codexBin),
    executor: options.executor ?? systemCommandExecutor
  };
}

function parseCodexMcpOutput(value: unknown): EnvironmentUrls {
  if (!isObject(value) || !isObject(value.transport)) throw new Error("Codex MCP 状态输出无效");
  const headers = isObject(value.transport.http_headers) ? value.transport.http_headers : {};
  const serverUrl = value.transport.url;
  const frontendUrl = headers[QUICK_IMAGE_FRONTEND_HEADER];
  if (typeof serverUrl !== "string" || typeof frontendUrl !== "string") {
    throw new Error("Codex Quick Image MCP 缺少 Server URL 或 Frontend URL");
  }
  return { serverUrl, frontendUrl };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
