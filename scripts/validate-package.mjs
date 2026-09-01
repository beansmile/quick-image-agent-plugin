import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { runtimePackagePattern } from "./lib/runtime-package.mjs";

const root = process.cwd();
const errors = [];

const packageJson = await readJson("package.json");
const portableManifest = await readJson("plugin.json");
const portableMcp = await readJson("mcp.json");
const codexManifest = await readJson(".codex-plugin/plugin.json");
const claudeMarketplace = await readJson(".claude-plugin/marketplace.json");
const codexMarketplace = await readJson(".agents/plugins/marketplace.json");
const companionMcp = await readJson(".mcp.json");
const openClawManifest = await readJson("openclaw.plugin.json");
if (packageJson.private !== true) {
  errors.push("package.json: package must remain private to prevent npm publication");
}
if (openClawManifest.version !== packageJson.version) {
  errors.push("OpenClaw manifest: version must match package.json");
}
if (openClawManifest.id !== "quick-image") {
  errors.push("OpenClaw manifest: plugin id must be quick-image");
}
if (openClawManifest.skills?.join(",") !== "./skills") {
  errors.push("OpenClaw manifest: skills must point to ./skills");
}
if (openClawManifest.requiresPlugins !== undefined) {
  errors.push("OpenClaw manifest: merged plugin must not require another Quick Image plugin");
}
if (openClawManifest.mcpServers !== undefined) {
  errors.push("OpenClaw manifest: native plugins must configure MCP through OpenClaw-managed mcp.servers");
}
if (openClawManifest.contracts?.tools?.join(",") !== [
  "quick_image_list_attachments",
  "quick_image_inspect_attachment",
  "quick_image_prepare_attachment",
  "quick_image_estimate_lookbook_credits",
  "quick_image_estimate_pose_credits",
  "quick_image_estimate_upscale_credits",
  "quick_image_estimate_video_credits",
  "quick_image_upload_staged_attachment",
  "quick_image_send_preview"
].join(",")) {
  errors.push("OpenClaw manifest: unexpected native tool contract");
}
if (packageJson.openclaw?.extensions?.join(",") !== "./openclaw-adapter/dist/index.js") {
  errors.push("OpenClaw runtime entry must point to ./openclaw-adapter/dist/index.js");
}
if (claudeMarketplace.plugins?.length !== 1 || claudeMarketplace.plugins[0]?.name !== "quick-image" ||
    claudeMarketplace.plugins[0]?.source !== "./") {
  errors.push("Claude Marketplace: must expose only the merged quick-image plugin from ./");
}
const codexMarketplaceEntry = codexMarketplace.plugins?.[0];
if (codexMarketplace.name !== "quick-image" || codexMarketplace.plugins?.length !== 1 ||
    codexMarketplaceEntry?.name !== "quick-image" || codexMarketplaceEntry?.source?.source !== "local" ||
    codexMarketplaceEntry?.source?.path !== "./" ||
    codexMarketplaceEntry?.policy?.installation !== "AVAILABLE" ||
    codexMarketplaceEntry?.policy?.authentication !== "ON_USE" ||
    codexMarketplaceEntry?.category !== "Creativity") {
  errors.push("Codex Marketplace: must expose the repository-root quick-image plugin");
}

for (const [name, manifest] of [
  ["plugin.json", portableManifest],
  ["Codex manifest", codexManifest]
]) {
  if (manifest.name !== "quick-image") errors.push(`${name}: plugin name must be quick-image`);
  if (manifest.version !== packageJson.version) errors.push(`${name}: version must match package.json`);
}
if (portableManifest.$schema !== "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json") {
  errors.push("plugin.json: unsupported Agent Plugins schema");
}
if (portableMcp.$schema !== "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json") {
  errors.push("mcp.json: unsupported Agent Plugins MCP schema");
}
if (portableMcp.mcpServers?.["quick-image"]?.url !== "https://quickimage.ai/mcp") {
  errors.push("mcp.json: unexpected remote MCP URL");
}
if (portableMcp.mcpServers?.["quick-image"]?.headers?.["X-Quick-Image-Plugin-Version"] !== packageJson.version) {
  errors.push("mcp.json: plugin version header must match package.json");
}
if (codexManifest.mcpServers !== "./.mcp.json") {
  errors.push("Codex manifest: mcpServers must point to ./.mcp.json");
}
if (companionMcp.mcpServers?.["quick-image"]?.headers?.["X-Quick-Image-Plugin-Version"] !== packageJson.version) {
  errors.push("Companion MCP config: plugin version header must match package.json");
}
if (companionMcp.mcpServers?.["quick-image"]?.http_headers?.["X-Quick-Image-Plugin-Version"] !== packageJson.version) {
  errors.push("Codex MCP config: plugin version header must match package.json");
}
if (companionMcp.mcpServers?.["quick-image"]?.http_headers?.["X-Quick-Image-Frontend-URL"] !== "https://quickimage.ai") {
  errors.push("Codex MCP config: default frontend URL must remain production");
}
if (portableMcp.mcpServers?.["quick-image"]?.headers?.["X-Quick-Image-Frontend-URL"] !== "https://quickimage.ai") {
  errors.push("mcp.json: default frontend URL must remain production");
}
if (companionMcp.mcpServers?.["quick-image-local"]?.tools?.inspect_attachment?.approval_mode !== "prompt") {
  errors.push("Codex MCP config: inspect_attachment must require prompt approval");
}
if (Object.keys(portableMcp.mcpServers ?? {}).sort().join(",") !== "quick-image,quick-image-local") {
  errors.push("mcp.json: only the remote MCP and local agent runtime may be declared");
}
const portableRuntime = portableMcp.mcpServers?.["quick-image-local"];
const companionRuntime = companionMcp.mcpServers?.["quick-image-local"];
for (const [name, server] of [["mcp.json", portableRuntime], ["Codex companion MCP config", companionRuntime]]) {
  const runtimePackage = server?.args?.[2];
  if (server?.command !== "npx" || server?.args?.[0] !== "--yes" || server?.args?.[1] !== "--package" ||
      server?.args?.[3] !== "quick-image-local-mcp" || !runtimePackagePattern.test(runtimePackage ?? "")) {
    errors.push(`${name}: local runtime must use a versioned quick-image-agent-runtime Release tgz`);
  }
}
if (portableRuntime?.args?.[2] !== companionRuntime?.args?.[2]) {
  errors.push("MCP configs: local runtime Release tgz must match");
}
if (packageJson.dependencies?.["quick-image-agent-runtime"] !== portableRuntime?.args?.[2]) {
  errors.push("package.json: OpenClaw runtime dependency must match the MCP runtime Release tgz");
}

for (const required of [
  ".agents/plugins/marketplace.json",
  "openclaw.plugin.json",
  "openclaw-adapter/dist/index.js",
  "skills/quick-image/SKILL.md",
  "DEVELOPMENT.md",
  "LICENSE",
]) {
  if (!(await exists(required))) errors.push(`missing required release file: ${required}`);
}
if (packageJson.bin !== undefined) {
  errors.push("package must leave all CLI binaries to quick-image-agent-runtime");
}

const skill = await readFile(path.join(root, "skills/quick-image/SKILL.md"), "utf8");
if (skill.includes("TODO")) errors.push("skill contains TODO placeholder");
for (const forbiddenTool of [
  "cancel_task",
  "retry_task",
  "delete_result",
  "list_gallery",
  "purchase_credits",
  "quote_generation",
  "submit_generation_task"
]) {
  if (skill.includes(forbiddenTool)) errors.push(`skill exposes forbidden tool: ${forbiddenTool}`);
}
for (const requiredTool of [
  "inspect_attachment",
  "quick_image_inspect_attachment",
  "quick_image_prepare_attachment",
  "quick_image_upload_staged_attachment",
  "prepare_attachment",
  "submit_lookbook_task",
  "submit_pose_task",
  "submit_upscale_task",
  "submit_video_task"
]) {
  if (!skill.includes(requiredTool)) errors.push(`skill is missing capability-specific tool: ${requiredTool}`);
}
for (const requiredRule of ["工具发现", "禁止扫描", "绝对路径", "工具审批", "立即停止"]) {
  if (!skill.includes(requiredRule)) errors.push(`skill is missing fail-closed rule: ${requiredRule}`);
}
for (const requiredRule of [
  "get_generation_config",
  "estimate_lookbook_credits",
  "estimate_pose_credits",
  "estimate_upscale_credits",
  "estimate_video_credits",
  "本地预估",
  "确认后才执行上传",
  "余额不足时立即停止"
]) {
  if (!skill.includes(requiredRule)) errors.push(`skill is missing configuration-first rule: ${requiredRule}`);
}
if (!skill.includes("attachment_handle")) errors.push("skill must retain the inspected attachment handle");
if (skill.includes("capture_attachment") || skill.includes("captured_handle")) {
  errors.push("skill must not expose the removed attachment capture contract");
}
if (packageJson.bin?.["quick-image-attachment"]) errors.push("package must not expose an attachment registration CLI");
if (await exists("src/cli/attachment.ts")) errors.push("attachment registration CLI source must be removed");
for (const removedCompatibilityFile of [
  ".claude-plugin/plugin.json",
  "openclaw-adapter/package.json",
  "openclaw-adapter/openclaw.plugin.json",
  "src/cli/quick-image.ts",
  "src/cli/doctor.ts",
  "src/cli/openclaw-policy.ts",
  "src/environment/codex.ts",
  "src/environment/openclaw.ts",
  "src/environment/service.ts",
  "scripts/install-local-claude.mjs",
  "scripts/lib/claude-plugin-overlay.mjs"
]) {
  if (await exists(removedCompatibilityFile)) {
    errors.push(`removed compatibility file must not be packaged: ${removedCompatibilityFile}`);
  }
}
if (packageJson.scripts?.["dev:install:claude"]) {
  errors.push("package must not expose the removed Claude development installer");
}

const sourceFiles = await walk(root, new Set([".git", "node_modules", "coverage", "tmp"]));
const forbiddenPatterns = [
  [/\/Users\/[A-Za-z0-9._-]+\//, "local macOS path"],
  [/\/home\/[A-Za-z0-9._-]+\//, "local Linux path"],
  [/git\.beansmile-dev\.com/i, "private repository host"],
  [/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/, "private key"],
  [/(?:access|refresh)[_-]?token\s*[:=]\s*["'][^"']{12,}/i, "token-like value"]
];
for (const relativePath of sourceFiles) {
  if (relativePath === "pnpm-lock.yaml" || relativePath.startsWith("dist/")) continue;
  const details = await stat(path.join(root, relativePath));
  if (details.size > 2 * 1024 * 1024) continue;
  const content = await readFile(path.join(root, relativePath), "utf8");
  for (const [pattern, label] of forbiddenPatterns) {
    if (pattern.test(content)) errors.push(`${relativePath}: contains ${label}`);
  }
}

if (errors.length > 0) {
  process.stderr.write(`${errors.map((error) => `- ${error}`).join("\n")}\n`);
  process.exit(1);
}
process.stdout.write("Package validation passed.\n");

async function readJson(relativePath) {
  try {
    return JSON.parse(await readFile(path.join(root, relativePath), "utf8"));
  } catch (error) {
    errors.push(`${relativePath}: invalid or missing JSON (${error instanceof Error ? error.name : "error"})`);
    return {};
  }
}

async function exists(relativePath) {
  try {
    await stat(path.join(root, relativePath));
    return true;
  } catch {
    return false;
  }
}

async function walk(directory, excludedNames, prefix = "") {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (excludedNames.has(entry.name)) continue;
    const relativePath = path.join(prefix, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(path.join(directory, entry.name), excludedNames, relativePath)));
    else if (entry.isFile()) files.push(relativePath);
  }
  return files;
}
