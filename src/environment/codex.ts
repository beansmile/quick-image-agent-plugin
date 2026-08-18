import { lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { CommandExecutor } from "./command-executor.js";
import { systemCommandExecutor } from "./command-executor.js";
import {
  QUICK_IMAGE_FRONTEND_HEADER,
  QUICK_IMAGE_MCP_NAME,
  QUICK_IMAGE_PRODUCTION_FRONTEND_URL,
  QUICK_IMAGE_PRODUCTION_SERVER_URL,
  QUICK_IMAGE_VERSION_HEADER,
  type EnvironmentUrls
} from "./config.js";
import { resolveCodexExecutable } from "./executables.js";

const MANAGED_BLOCK_BEGIN = "# BEGIN quick-image managed MCP environment";
const MANAGED_BLOCK_END = "# END quick-image managed MCP environment";
const QUICK_IMAGE_TABLE_PATTERN = /^\s*\[\s*mcp_servers\s*\.\s*(?:quick-image|"quick-image"|'quick-image')\s*\]\s*(?:#.*)?$/m;

export interface EnvironmentStatus {
  host: "codex" | "openclaw";
  configured: boolean;
  source: "plugin-default" | "custom" | "production-default" | "external" | "missing";
  serverUrl?: string;
  frontendUrl?: string;
  configPath?: string;
  authenticationCommand?: string;
}

interface CodexOptions {
  pluginVersion: string;
  codexBin?: string;
  configPath?: string;
  executor?: CommandExecutor;
}

export async function setCodexEnvironment(urls: EnvironmentUrls, options: CodexOptions): Promise<EnvironmentStatus> {
  const runtime = codexRuntime(options);
  const source = await readCodexConfig(runtime.configPath);
  const updated = upsertCodexManagedBlock(source, urls, options.pluginVersion);
  await writeCodexConfigAndVerify(runtime, source, updated, urls);
  return readCodexEnvironmentStatus(options);
}

export async function resetCodexEnvironment(options: CodexOptions): Promise<EnvironmentStatus> {
  const runtime = codexRuntime(options);
  const source = await readCodexConfig(runtime.configPath);
  const updated = removeCodexManagedBlock(source);
  if (updated !== source) {
    await writeCodexConfigAndVerify(runtime, source, updated);
  }
  const status = await readCodexEnvironmentStatus(options);
  if (status.configured && (
    status.serverUrl !== QUICK_IMAGE_PRODUCTION_SERVER_URL ||
    status.frontendUrl !== QUICK_IMAGE_PRODUCTION_FRONTEND_URL
  )) {
    throw new Error("Codex 当前仍由其他配置提供自定义 Quick Image URL，env reset 无法安全覆盖该配置");
  }
  return status;
}

export async function readCodexEnvironmentStatus(options: CodexOptions): Promise<EnvironmentStatus> {
  const runtime = codexRuntime(options);
  const source = await readCodexConfig(runtime.configPath);
  let output: string;
  try {
    output = runtime.executor.run(runtime.codexBin, ["mcp", "get", QUICK_IMAGE_MCP_NAME, "--json"]).stdout;
  } catch {
    return {
      host: "codex",
      configured: false,
      source: "missing",
      configPath: runtime.configPath
    };
  }
  const raw: unknown = JSON.parse(output);
  const config = parseCodexMcpOutput(raw);
  return {
    host: "codex",
    configured: true,
    source: containsManagedBlock(source)
      ? "custom"
      : config.serverUrl === QUICK_IMAGE_PRODUCTION_SERVER_URL &&
          config.frontendUrl === QUICK_IMAGE_PRODUCTION_FRONTEND_URL
        ? "plugin-default"
        : "external",
    serverUrl: config.serverUrl,
    frontendUrl: config.frontendUrl,
    configPath: runtime.configPath,
    authenticationCommand: "codex mcp login quick-image"
  };
}

export function upsertCodexManagedBlock(
  source: string,
  urls: EnvironmentUrls,
  pluginVersion: string
): string {
  const range = managedBlockRange(source);
  if (!range && QUICK_IMAGE_TABLE_PATTERN.test(source)) {
    throw new Error("Codex config.toml 已包含非 Quick Image 管理的 mcp_servers.quick-image 配置；请先手工处理该冲突");
  }
  const block = renderManagedBlock(urls, pluginVersion);
  if (range) return `${source.slice(0, range.start)}${block}${source.slice(range.end)}`;
  const prefix = source.length === 0 ? "" : `${source.replace(/\s*$/, "")}\n\n`;
  return `${prefix}${block}`;
}

export function removeCodexManagedBlock(source: string): string {
  const range = managedBlockRange(source);
  if (!range) return source;
  const separatorLength = source.slice(0, range.start).endsWith("\n\n") ? 1 : 0;
  const before = source.slice(0, range.start - separatorLength);
  const after = source.slice(range.end).replace(/^\n{2,}/, "\n");
  return `${before}${after}`;
}

export function containsManagedBlock(source: string): boolean {
  return managedBlockRange(source) !== undefined;
}

function renderManagedBlock(urls: EnvironmentUrls, pluginVersion: string): string {
  return [
    MANAGED_BLOCK_BEGIN,
    `[mcp_servers.${QUICK_IMAGE_MCP_NAME}]`,
    `url = ${tomlString(urls.serverUrl)}`,
    `oauth_resource = ${tomlString(urls.serverUrl)}`,
    'auth = "oauth"',
    `http_headers = { ${tomlString(QUICK_IMAGE_VERSION_HEADER)} = ${tomlString(pluginVersion)}, ${tomlString(QUICK_IMAGE_FRONTEND_HEADER)} = ${tomlString(urls.frontendUrl)} }`,
    MANAGED_BLOCK_END,
    ""
  ].join("\n");
}

function managedBlockRange(source: string): { start: number; end: number } | undefined {
  const begins = markerIndexes(source, MANAGED_BLOCK_BEGIN);
  const ends = markerIndexes(source, MANAGED_BLOCK_END);
  if (begins.length === 0 && ends.length === 0) return undefined;
  if (begins.length !== 1 || ends.length !== 1 || begins[0] === undefined || ends[0] === undefined) {
    throw new Error("Codex config.toml 中的 Quick Image 管理区块标记不完整或重复");
  }
  if (begins[0] >= ends[0]) throw new Error("Codex config.toml 中的 Quick Image 管理区块顺序无效");
  const start = lineStart(source, begins[0]);
  const endLine = source.indexOf("\n", ends[0]);
  return { start, end: endLine === -1 ? source.length : endLine + 1 };
}

function markerIndexes(source: string, marker: string): number[] {
  const indexes: number[] = [];
  let offset = 0;
  while (offset < source.length) {
    const index = source.indexOf(marker, offset);
    if (index === -1) break;
    indexes.push(index);
    offset = index + marker.length;
  }
  return indexes;
}

function lineStart(source: string, index: number): number {
  const previousNewline = source.lastIndexOf("\n", index - 1);
  return previousNewline === -1 ? 0 : previousNewline + 1;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function codexRuntime(options: CodexOptions) {
  return {
    codexBin: resolveCodexExecutable(options.codexBin),
    configPath: options.configPath ?? resolveCodexConfigPath(),
    executor: options.executor ?? systemCommandExecutor
  };
}

function resolveCodexConfigPath(): string {
  const codexHome = process.env.CODEX_HOME?.trim();
  return path.join(codexHome ? path.resolve(codexHome) : path.join(os.homedir(), ".codex"), "config.toml");
}

async function readCodexConfig(configPath: string): Promise<string> {
  try {
    const details = await lstat(configPath);
    if (details.isSymbolicLink()) throw new Error(`拒绝修改符号链接形式的 Codex 配置：${configPath}`);
    if (!details.isFile()) throw new Error(`Codex 配置不是普通文件：${configPath}`);
    return await readFile(configPath, "utf8");
  } catch (error) {
    if (isFileSystemError(error, "ENOENT")) return "";
    throw error;
  }
}

async function writeCodexConfigAndVerify(
  runtime: ReturnType<typeof codexRuntime>,
  original: string,
  updated: string,
  expected?: EnvironmentUrls
): Promise<void> {
  await writeAtomic(runtime.configPath, updated);
  try {
    runtime.executor.run(runtime.codexBin, ["mcp", "list", "--json"]);
    if (expected) {
      const output = runtime.executor.run(runtime.codexBin, ["mcp", "get", QUICK_IMAGE_MCP_NAME, "--json"]);
      const actual = parseCodexMcpOutput(JSON.parse(output.stdout));
      if (actual.serverUrl !== expected.serverUrl || actual.frontendUrl !== expected.frontendUrl) {
        throw new Error("Codex 未加载刚写入的 Quick Image MCP 配置");
      }
    }
  } catch (error) {
    await restoreCodexConfig(runtime.configPath, original);
    throw error;
  }
}

async function writeAtomic(filePath: string, content: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${filePath}.quick-image-${process.pid}.tmp`;
  await writeFile(temporaryPath, content, { mode: 0o600 });
  await rename(temporaryPath, filePath);
}

async function restoreCodexConfig(filePath: string, original: string): Promise<void> {
  if (original === "") {
    try {
      await unlink(filePath);
    } catch (error) {
      if (!isFileSystemError(error, "ENOENT")) throw error;
    }
    return;
  }
  await writeAtomic(filePath, original);
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

function isFileSystemError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
