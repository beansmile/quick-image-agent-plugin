import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const script = path.resolve("scripts/set-runtime-version.mjs");
const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {
    recursive: true,
    force: true
  })));
});

describe("runtime:set", () => {
  it("同步 package.json 依赖与两份 MCP 清单的 Runtime 版本", async () => {
    const root = await createFixture();
    const expected = "quick-image-agent-runtime@1.2.3";

    await execFileAsync(process.execPath, [script, "1.2.3"], { cwd: root });

    const packageJson = await readJson(path.join(root, "package.json"));
    const portableMcp = await readJson(path.join(root, "mcp.json"));
    const codexMcp = await readJson(path.join(root, ".mcp.json"));
    expect(packageJson.dependencies["quick-image-agent-runtime"]).toBe("1.2.3");
    expect(portableMcp.mcpServers["quick-image-local"].args[2]).toBe(expected);
    expect(codexMcp.mcpServers["quick-image-local"].args[2]).toBe(expected);
  });

  it.each(["v1.2.3", "1.2.3-rc.1", "1.2", "main", "01.2.3"])("拒绝不规范版本 %s", async (version) => {
    const root = await createFixture();
    await expect(execFileAsync(process.execPath, [script, version], { cwd: root })).rejects.toThrow(
      "<major>.<minor>.<patch>"
    );
  });

  it("MCP 清单缺少 quick-image-local 配置时报错", async () => {
    const root = await createFixture({ withoutLocalRuntime: true });
    await expect(execFileAsync(process.execPath, [script, "1.2.3"], { cwd: root })).rejects.toThrow(
      "缺少有效的 quick-image-local 配置"
    );
  });
});

async function createFixture(options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "quick-image-runtime-version-test-"));
  temporaryDirectories.push(root);
  const mcpConfig = options.withoutLocalRuntime
    ? { mcpServers: {} }
    : {
        mcpServers: {
          "quick-image-local": {
            command: "npx",
            args: ["--yes", "--package", "quick-image-agent-runtime@0.2.3", "quick-image-local-mcp"]
          }
        }
      };
  const files = [
    ["package.json", JSON.stringify({
      dependencies: { "quick-image-agent-runtime": "0.2.3" }
    })],
    ["mcp.json", JSON.stringify(mcpConfig)],
    [".mcp.json", JSON.stringify(mcpConfig)]
  ];
  await Promise.all(files.map(([name, content]) => writeFile(path.join(root, name), content)));
  return root;
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}
