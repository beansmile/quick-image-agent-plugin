import { cp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export async function buildCodexPluginOverlay({
  repositoryRoot,
  pluginRoot,
  cachebuster,
  markerName
}) {
  const [sourceManifest, sourceMcpConfig] = await Promise.all([
    readJson(path.join(repositoryRoot, ".codex-plugin", "plugin.json")),
    readJson(path.join(repositoryRoot, ".mcp.json"))
  ]);
  const mcpServers = sourceMcpConfig.mcpServers;
  if (!mcpServers?.["quick-image"] || !mcpServers?.["quick-image-local"]) {
    throw new Error(".mcp.json 必须声明 quick-image 和 quick-image-local");
  }

  const baseVersion = String(sourceManifest.version).split("+")[0];
  sourceManifest.version = `${baseVersion}+codex.${cachebuster}`;
  sourceManifest.mcpServers = "./.mcp.json";
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

async function writeJsonAtomic(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporaryPath, filePath);
}
