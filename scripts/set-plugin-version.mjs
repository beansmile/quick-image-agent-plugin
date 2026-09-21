import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const numericIdentifier = "(?:0|[1-9]\\d*)";
const pluginVersionPattern = new RegExp(
  `^${numericIdentifier}\\.${numericIdentifier}\\.${numericIdentifier}$`
);
const version = process.argv[2];
const root = process.cwd();

if (!pluginVersionPattern.test(version ?? "")) {
  throw new Error("用法：pnpm plugin:set <major>.<minor>.<patch>");
}

const packageJson = await readJson("package.json");
const portableManifest = await readJson("plugin.json");
const codexManifest = await readJson(".codex-plugin/plugin.json");
const codeBuddyManifest = await readJson(".codebuddy-plugin/plugin.json");
const workBuddyManifest = await readJson(".workbuddy-plugin/plugin.json");
const openClawManifest = await readJson("openclaw.plugin.json");
const portableMcp = await readJson("mcp.json");
const companionMcp = await readJson(".mcp.json");

packageJson.version = version;
portableManifest.version = version;
codexManifest.version = version;
codeBuddyManifest.version = version;
workBuddyManifest.version = version;
openClawManifest.version = version;
setMcpPluginVersion(portableMcp, "mcp.json", ["headers"]);
setMcpPluginVersion(companionMcp, ".mcp.json", ["headers", "http_headers"]);

await Promise.all([
  writeJsonAtomic("package.json", packageJson),
  writeJsonAtomic("plugin.json", portableManifest),
  writeJsonAtomic(".codex-plugin/plugin.json", codexManifest),
  writeJsonAtomic(".codebuddy-plugin/plugin.json", codeBuddyManifest),
  writeJsonAtomic(".workbuddy-plugin/plugin.json", workBuddyManifest),
  writeJsonAtomic("openclaw.plugin.json", openClawManifest),
  writeJsonAtomic("mcp.json", portableMcp),
  writeJsonAtomic(".mcp.json", companionMcp)
]);

process.stdout.write(`Quick Image Agent Plugin 已更新为 ${version}。\n`);

function setMcpPluginVersion(config, name, headerTypes) {
  const server = config.mcpServers?.["quick-image"];
  if (!server) throw new Error(`${name} 缺少有效的 quick-image MCP 配置`);
  for (const headerType of headerTypes) {
    const headers = server[headerType];
    if (!headers || typeof headers !== "object" || Array.isArray(headers)) {
      throw new Error(`${name} 缺少有效的 quick-image ${headerType} 配置`);
    }
    headers["X-Quick-Image-Plugin-Version"] = version;
  }
}

async function readJson(file) {
  return JSON.parse(await readFile(path.join(root, file), "utf8"));
}

async function writeJsonAtomic(file, value) {
  const target = path.join(root, file);
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, target);
}
