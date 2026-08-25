import { cp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export async function buildCodexPluginOverlay({
  repositoryRoot,
  pluginRoot,
  cachebuster,
  markerName,
  serverUrl,
  frontendUrl
}) {
  const [sourceManifest, sourceMcpConfig] = await Promise.all([
    readJson(path.join(repositoryRoot, ".codex-plugin", "plugin.json")),
    readJson(path.join(repositoryRoot, ".mcp.json"))
  ]);
  const mcpServers = sourceMcpConfig.mcpServers;
  const remoteServer = mcpServers?.["quick-image"];
  if (!remoteServer || !mcpServers?.["quick-image-local"]) {
    throw new Error(".mcp.json 必须声明 quick-image 和 quick-image-local");
  }
  if (!isObject(remoteServer.headers) || !isObject(remoteServer.http_headers)) {
    throw new Error(".mcp.json 的 quick-image 必须声明 headers 和 http_headers");
  }

  const baseVersion = String(sourceManifest.version).split("+")[0];
  sourceManifest.version = `${baseVersion}+codex.${cachebuster}`;
  sourceManifest.mcpServers = "./.mcp.json";

  // 开发地址只进入隔离 Overlay，正式清单和用户 config.toml 均不修改。
  const developmentHeaders = {
    "X-Quick-Image-Plugin-Version": baseVersion,
    "X-Quick-Image-Frontend-URL": frontendUrl
  };
  remoteServer.url = serverUrl;
  remoteServer.headers = { ...remoteServer.headers, ...developmentHeaders };
  remoteServer.http_headers = { ...remoteServer.http_headers, ...developmentHeaders };

  await rm(pluginRoot, { recursive: true, force: true });
  await mkdir(path.join(pluginRoot, ".codex-plugin"), { recursive: true });
  await Promise.all([
    writeJsonAtomic(path.join(pluginRoot, ".codex-plugin", "plugin.json"), sourceManifest),
    writeJsonAtomic(path.join(pluginRoot, ".mcp.json"), sourceMcpConfig),
    cp(path.join(repositoryRoot, "skills"), path.join(pluginRoot, "skills"), { recursive: true })
  ]);
  await writeFile(path.join(pluginRoot, markerName), `${repositoryRoot}\n`, { mode: 0o600 });
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function writeJsonAtomic(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporaryPath, filePath);
}
