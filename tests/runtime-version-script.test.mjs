import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { runtimePackagePattern } from "../scripts/lib/runtime-package.mjs";

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
  it.each(["v1.2.3", "v1.2.3-rc.1"])("同步 Runtime %s 的 Release tgz", async (tag) => {
    const root = await createFixture();
    const expected =
      `https://github.com/beansmile/quick-image-agent-runtime/releases/download/${tag}/` +
      "quick-image-agent-runtime.tgz";
    expect(expected).toMatch(runtimePackagePattern);

    await execFileAsync(process.execPath, [script, tag], { cwd: root });

    const packageJson = await readJson(path.join(root, "package.json"));
    const portableMcp = await readJson(path.join(root, "mcp.json"));
    const codexMcp = await readJson(path.join(root, ".mcp.json"));
    expect(packageJson.dependencies["quick-image-agent-runtime"]).toBe(expected);
    expect(portableMcp.mcpServers["quick-image-local"].args[2]).toBe(expected);
    expect(codexMcp.mcpServers["quick-image-local"].args[2]).toBe(expected);
  });

  it.each(["main", "v01.2.3", "v1.2.3-01"])("拒绝浮动分支或不规范版本 %s", async (tag) => {
    const root = await createFixture();
    await expect(execFileAsync(process.execPath, [script, tag], { cwd: root })).rejects.toThrow(
      "v<major>.<minor>.<patch>[-<prerelease>]"
    );
  });
});

async function createFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "quick-image-runtime-version-test-"));
  temporaryDirectories.push(root);
  const runtimeServer = {
    command: "npx",
    args: ["--yes", "--package", "https://example.com/runtime.tgz", "quick-image-local-mcp"]
  };
  await Promise.all([
    writeFile(path.join(root, "package.json"), JSON.stringify({
      dependencies: { "quick-image-agent-runtime": "https://example.com/runtime.tgz" }
    })),
    writeFile(path.join(root, "mcp.json"), JSON.stringify({
      mcpServers: { "quick-image-local": runtimeServer }
    })),
    writeFile(path.join(root, ".mcp.json"), JSON.stringify({
      mcpServers: { "quick-image-local": runtimeServer }
    }))
  ]);
  return root;
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}
