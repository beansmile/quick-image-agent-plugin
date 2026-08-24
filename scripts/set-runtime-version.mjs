import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { runtimePackageForTag } from "./lib/runtime-package.mjs";

const tag = process.argv[2];
const root = process.cwd();
const runtimePackage = runtimePackageForTag(tag);
const packageJson = await readJson("package.json");
const portableMcp = await readJson("mcp.json");
const codexMcp = await readJson(".mcp.json");

packageJson.dependencies["quick-image-agent-runtime"] = runtimePackage;
setRuntimePackage(portableMcp, "mcp.json");
setRuntimePackage(codexMcp, ".mcp.json");

await Promise.all([
  writeJsonAtomic("package.json", packageJson),
  writeJsonAtomic("mcp.json", portableMcp),
  writeJsonAtomic(".mcp.json", codexMcp)
]);

process.stdout.write(
  `Quick Image Agent Runtime 已更新为 ${tag}。请运行 pnpm install --lockfile-only 更新锁文件。\n`
);

function setRuntimePackage(config, name) {
  const args = config.mcpServers?.["quick-image-local"]?.args;
  if (!Array.isArray(args) || args[1] !== "--package" || args[3] !== "quick-image-local-mcp") {
    throw new Error(`${name} 缺少有效的 quick-image-local 配置`);
  }
  args[2] = runtimePackage;
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
