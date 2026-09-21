import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const script = path.resolve("scripts/set-plugin-version.mjs");
const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {
    recursive: true,
    force: true
  })));
});

describe("plugin:set", () => {
  it.each(["0.1.3", "1.2.3"])("同步 Plugin %s 的版本", async (version) => {
    const root = await createFixture();

    await execFileAsync(process.execPath, [script, version], { cwd: root });

    for (const file of ["package.json", "plugin.json", ".codex-plugin/plugin.json", ".codebuddy-plugin/plugin.json", ".workbuddy-plugin/plugin.json", "openclaw.plugin.json"]) {
      expect((await readJson(path.join(root, file))).version).toBe(version);
    }
    const portableMcp = await readJson(path.join(root, "mcp.json"));
    const companionMcp = await readJson(path.join(root, ".mcp.json"));
    expect(portableMcp.mcpServers["quick-image"].headers["X-Quick-Image-Plugin-Version"]).toBe(version);
    expect(companionMcp.mcpServers["quick-image"].headers["X-Quick-Image-Plugin-Version"]).toBe(version);
    expect(companionMcp.mcpServers["quick-image"].http_headers["X-Quick-Image-Plugin-Version"]).toBe(version);
  });

  it.each(["v1.2.3", "1.2", "1.2.3-rc.1", "1.2.3-01"])("拒绝不规范版本 %s", async (version) => {
    const root = await createFixture();
    await expect(execFileAsync(process.execPath, [script, version], { cwd: root })).rejects.toThrow(
      "major>.<minor>.<patch>"
    );
  });
});

async function createFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "quick-image-plugin-version-test-"));
  temporaryDirectories.push(root);
  await mkdir(path.join(root, ".codex-plugin"), { recursive: true });
  await mkdir(path.join(root, ".codebuddy-plugin"), { recursive: true });
  await mkdir(path.join(root, ".workbuddy-plugin"), { recursive: true });
  await Promise.all([
    writeJson(path.join(root, "package.json"), { version: "0.1.2" }),
    writeJson(path.join(root, "plugin.json"), { version: "0.1.2" }),
    writeJson(path.join(root, ".codex-plugin/plugin.json"), { version: "0.1.2" }),
    writeJson(path.join(root, ".codebuddy-plugin/plugin.json"), { version: "0.1.2" }),
    writeJson(path.join(root, ".workbuddy-plugin/plugin.json"), { version: "0.1.2" }),
    writeJson(path.join(root, "openclaw.plugin.json"), { version: "0.1.2" }),
    writeJson(path.join(root, "mcp.json"), { mcpServers: { "quick-image": { headers: { "X-Quick-Image-Plugin-Version": "0.1.2" } } } }),
    writeJson(path.join(root, ".mcp.json"), { mcpServers: { "quick-image": { headers: { "X-Quick-Image-Plugin-Version": "0.1.2" }, http_headers: { "X-Quick-Image-Plugin-Version": "0.1.2" } } } })
  ]);
  return root;
}

async function writeJson(file, value) {
  await writeFile(file, `${JSON.stringify(value)}\n`, "utf8");
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}
