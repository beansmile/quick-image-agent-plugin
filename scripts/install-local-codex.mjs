import { mkdir, realpath, rename, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { buildCodexPluginOverlay } from "./lib/codex-plugin-overlay.mjs";
import { resolveCodexCli } from "./lib/resolve-codex-cli.mjs";

const MARKETPLACE_NAME = "quick-image-local";
const PLUGIN_NAME = "quick-image";
const MARKER_NAME = ".quick-image-dev-overlay";
const DEV_SERVER_URL = "http://127.0.0.1:3000/mcp";
const DEV_FRONTEND_URL = "http://127.0.0.1:8001";
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..");
const codexCommand = resolveCodexCli();
const dataHome = process.env.XDG_DATA_HOME?.trim() || path.join(os.homedir(), ".local", "share");
const marketplaceRoot = path.join(dataHome, "quick-image-agent-plugin", "codex-marketplace");
const marketplaceManifestPath = path.join(marketplaceRoot, ".agents", "plugins", "marketplace.json");
const pluginRoot = path.join(marketplaceRoot, "plugins", PLUGIN_NAME);

await preparePluginOverlay();
await writeMarketplaceManifest();
await registerMarketplace();
installPlugin();
setDevelopmentUrls();

process.stdout.write(
  [
    "Quick Image Codex 本地调试插件已准备完成。",
    `Marketplace: ${marketplaceRoot}`,
    `MCP: ${DEV_SERVER_URL}`,
    `Frontend: ${DEV_FRONTEND_URL}`,
    "插件已安装并切换到开发 URL；请按提示重新授权，并新建 Codex 任务。"
  ].join("\n") + "\n"
);

async function preparePluginOverlay() {
  await assertOwnedOverlay();
  await buildCodexPluginOverlay({
    repositoryRoot,
    pluginRoot,
    cachebuster: `local-${timestamp()}`,
    markerName: MARKER_NAME
  });
}

async function writeMarketplaceManifest() {
  const marketplace = {
    name: MARKETPLACE_NAME,
    interface: { displayName: "Quick Image Local" },
    plugins: [
      {
        name: PLUGIN_NAME,
        source: { source: "local", path: `./plugins/${PLUGIN_NAME}` },
        policy: { installation: "AVAILABLE", authentication: "ON_USE" },
        category: "Creativity"
      }
    ]
  };
  await writeJsonAtomic(marketplaceManifestPath, marketplace);
}

async function assertOwnedOverlay() {
  try {
    const details = await stat(pluginRoot);
    if (!details.isDirectory()) throw new Error(`${pluginRoot} 不是目录`);
    await stat(path.join(pluginRoot, MARKER_NAME));
  } catch (error) {
    if (error?.code === "ENOENT") {
      try {
        await stat(pluginRoot);
      } catch (nestedError) {
        if (nestedError?.code === "ENOENT") return;
        throw nestedError;
      }
      throw new Error(`拒绝覆盖没有 ${MARKER_NAME} 标记的目录：${pluginRoot}`);
    }
    throw error;
  }
}

async function registerMarketplace() {
  const result = runCodex(["plugin", "marketplace", "list", "--json"], { capture: true });
  const marketplaces = JSON.parse(result.stdout).marketplaces ?? [];
  const existing = marketplaces.find((item) => item.name === MARKETPLACE_NAME);
  if (existing) {
    const [existingRoot, expectedRoot] = await Promise.all([realpath(existing.root), realpath(marketplaceRoot)]);
    if (existingRoot !== expectedRoot) {
      throw new Error(`Marketplace ${MARKETPLACE_NAME} 已指向其他目录：${existing.root}`);
    }
  }
  if (!existing) runCodex(["plugin", "marketplace", "add", marketplaceRoot, "--json"]);
}

function installPlugin() {
  runCodex(["plugin", "add", `${PLUGIN_NAME}@${MARKETPLACE_NAME}`, "--json"]);
}

function setDevelopmentUrls() {
  const result = spawnSync(process.execPath, [
    path.join(repositoryRoot, "dist", "cli", "quick-image.js"),
    "env",
    "set",
    "--host",
    "codex",
    "--server-url",
    DEV_SERVER_URL,
    "--frontend-url",
    DEV_FRONTEND_URL,
    "--codex-bin",
    codexCommand
  ], { cwd: repositoryRoot, encoding: "utf8", stdio: "inherit" });
  if (result.error) throw new Error(`无法设置 Codex 开发 URL：${result.error.message}`);
  if (result.status !== 0) throw new Error("quick-image env set --host codex 执行失败");
}

function runCodex(args, { capture = false } = {}) {
  const result = spawnSync(codexCommand, args, {
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit"
  });
  if (result.error) throw new Error(`无法运行 Codex CLI（${codexCommand}）：${result.error.message}`);
  if (result.status !== 0) {
    const details = capture ? (result.stderr || result.stdout).trim() : "请查看上方 Codex 输出";
    throw new Error(`codex ${args.join(" ")} 执行失败：${details}`);
  }
  return result;
}

async function writeJsonAtomic(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporaryPath, filePath);
}

function timestamp() {
  return new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
}
