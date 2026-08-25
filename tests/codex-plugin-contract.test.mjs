import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildCodexPluginOverlay } from "../scripts/lib/codex-plugin-overlay.mjs";
import { runtimePackagePattern } from "../scripts/lib/runtime-package.mjs";

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("Codex plugin contract", () => {
  it("installs the repository-root plugin from the GitHub marketplace source", async () => {
    const readme = await readFile(path.resolve("README.md"), "utf8");
    const marketplace = await readJson(path.resolve(".agents/plugins/marketplace.json"));
    const installSection = readme.slice(readme.indexOf("### Codex"), readme.indexOf("### OpenClaw"));

    expect(installSection).toContain("Quick Image 暂未上架 Codex 官方 Plugin Marketplace");
    expect(installSection).toContain(
      "codex plugin marketplace add https://github.com/beansmile/quick-image-agent-plugin"
    );
    expect(installSection).toContain("codex plugin add quick-image@quick-image");
    expect(installSection).not.toContain("在 Codex 的 Plugin Marketplace 中找到");
    expect(marketplace).toMatchObject({
      name: "quick-image",
      plugins: [{
        name: "quick-image",
        source: { source: "local", path: "./" },
        policy: { installation: "AVAILABLE", authentication: "ON_USE" },
        category: "Creativity"
      }]
    });
  });

  it("loads bundled MCP servers through the companion config", async () => {
    const manifest = await readJson(path.resolve(".codex-plugin/plugin.json"));
    const mcpConfig = await readJson(path.resolve(".mcp.json"));
    const portableMcpConfig = await readJson(path.resolve("mcp.json"));
    const packageJson = await readJson(path.resolve("package.json"));

    expect(manifest.mcpServers).toBe("./.mcp.json");
    expect(Object.keys(mcpConfig.mcpServers).sort()).toEqual(["quick-image", "quick-image-local"]);
    expect(mcpConfig.mcpServers["quick-image"].http_headers?.["X-Quick-Image-Plugin-Version"])
      .toBe(packageJson.version);
    expect(mcpConfig.mcpServers["quick-image"].http_headers?.["X-Quick-Image-Frontend-URL"])
      .toBe("https://quickimage.ai");
    expect(mcpConfig.mcpServers["quick-image-local"].tools.inspect_attachment.approval_mode).toBe("prompt");
    const runtimeArgs = mcpConfig.mcpServers["quick-image-local"].args;
    expect(runtimeArgs.slice(0, 2)).toEqual(["--yes", "--package"]);
    expect(runtimeArgs[2]).toMatch(runtimePackagePattern);
    expect(runtimeArgs[3]).toBe("quick-image-local-mcp");
    expect(portableMcpConfig.mcpServers["quick-image-local"].args).toEqual(runtimeArgs);
    expect(packageJson.dependencies["quick-image-agent-runtime"]).toBe(runtimeArgs[2]);
    expect(packageJson.bin["quick-image"]).toBe("./dist/cli/quick-image.js");
    expect(packageJson.bin).not.toHaveProperty("quick-image-upload-bridge");
    expect(packageJson.bin).not.toHaveProperty("quick-image-local-mcp");
  });

  it("writes a self-contained development overlay with a cache-busted MCP config", async () => {
    const fixtureRoot = await createPluginFixture();
    const pluginRoot = path.join(fixtureRoot, "overlay");

    await buildCodexPluginOverlay({
      repositoryRoot: fixtureRoot,
      pluginRoot,
      cachebuster: "local-test",
      markerName: ".quick-image-dev-overlay"
    });

    const manifest = await readJson(path.join(pluginRoot, ".codex-plugin", "plugin.json"));
    const mcpConfig = await readJson(path.join(pluginRoot, ".mcp.json"));
    expect(manifest.version).toBe("0.1.0+codex.local-test");
    expect(manifest.mcpServers).toBe("./.mcp.json");
    expect(mcpConfig.mcpServers["quick-image"].url).toBe("https://quickimage.ai/mcp");
    expect(mcpConfig.mcpServers["quick-image"].http_headers).toEqual({
      "X-Quick-Image-Plugin-Version": "0.1.0",
      "X-Quick-Image-Frontend-URL": "https://quickimage.ai"
    });
    expect(mcpConfig.mcpServers["quick-image"].headers).toEqual({
      "X-Quick-Image-Plugin-Version": "0.1.0",
      "X-Quick-Image-Frontend-URL": "https://quickimage.ai"
    });
    expect(mcpConfig.mcpServers["quick-image-local"]).toEqual({
      command: "npx",
      args: ["--yes", "--package", "https://github.com/beansmile/quick-image-agent-runtime/releases/download/v0.1.0/quick-image-agent-runtime-0.1.0.tgz", "quick-image-local-mcp"],
      tools: { inspect_attachment: { approval_mode: "prompt" } }
    });
  });
});

async function createPluginFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "quick-image-codex-overlay-"));
  temporaryDirectories.push(root);
  await mkdir(path.join(root, ".codex-plugin"), { recursive: true });
  await mkdir(path.join(root, "skills", "quick-image"), { recursive: true });
  await writeFile(path.join(root, ".codex-plugin", "plugin.json"), JSON.stringify({
    name: "quick-image",
    version: "0.1.0",
    description: "fixture",
    mcpServers: "./.mcp.json"
  }));
  await writeFile(path.join(root, ".mcp.json"), JSON.stringify({
    mcpServers: {
      "quick-image": {
        type: "http",
        url: "https://quickimage.ai/mcp",
        headers: {
          "X-Quick-Image-Plugin-Version": "0.1.0",
          "X-Quick-Image-Frontend-URL": "https://quickimage.ai"
        },
        http_headers: {
          "X-Quick-Image-Plugin-Version": "0.1.0",
          "X-Quick-Image-Frontend-URL": "https://quickimage.ai"
        }
      },
      "quick-image-local": {
        command: "npx",
        args: ["--yes", "--package", "https://github.com/beansmile/quick-image-agent-runtime/releases/download/v0.1.0/quick-image-agent-runtime-0.1.0.tgz", "quick-image-local-mcp"],
        tools: { inspect_attachment: { approval_mode: "prompt" } }
      }
    }
  }));
  return root;
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}
