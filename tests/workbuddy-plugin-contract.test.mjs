import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runtimePackagePattern } from "../scripts/lib/runtime-package.mjs";

describe("WorkBuddy plugin contract", () => {
  it("declares the portable MCP config in the codebuddy manifest", async () => {
    const manifest = await readJson(path.resolve(".codebuddy-plugin/plugin.json"));
    const portableMcpConfig = await readJson(path.resolve("mcp.json"));
    const packageJson = await readJson(path.resolve("package.json"));

    expect(manifest.name).toBe("quick-image");
    expect(manifest.version).toBe(packageJson.version);
    expect(manifest.mcpServers).toBe("./mcp.json");
    expect(Object.keys(portableMcpConfig.mcpServers).sort()).toEqual(["quick-image", "quick-image-local"]);
    const runtimeArgs = portableMcpConfig.mcpServers["quick-image-local"].args;
    expect(runtimeArgs.slice(0, 2)).toEqual(["--yes", "--package"]);
    expect(runtimeArgs[2]).toMatch(runtimePackagePattern);
    expect(runtimeArgs[3]).toBe("quick-image-local-mcp");
  });

  it("declares the Codex-style skills and companion MCP config in the workbuddy manifest", async () => {
    const manifest = await readJson(path.resolve(".workbuddy-plugin/plugin.json"));
    const codexManifest = await readJson(path.resolve(".codex-plugin/plugin.json"));
    const mcpConfig = await readJson(path.resolve(".mcp.json"));
    const packageJson = await readJson(path.resolve("package.json"));

    expect(manifest.name).toBe("quick-image");
    expect(manifest.version).toBe(packageJson.version);
    expect(manifest.skills).toBe("./skills/");
    expect(manifest.mcpServers).toBe("./.mcp.json");
    expect(manifest.mcpServers).toBe(codexManifest.mcpServers);
    expect(Object.keys(mcpConfig.mcpServers).sort()).toEqual(["quick-image", "quick-image-local"]);
    const runtimeArgs = mcpConfig.mcpServers["quick-image-local"].args;
    expect(runtimeArgs.slice(0, 2)).toEqual(["--yes", "--package"]);
    expect(runtimeArgs[2]).toMatch(runtimePackagePattern);
    expect(runtimeArgs[3]).toBe("quick-image-local-mcp");
  });

  it("shares the host-agnostic skill wording across hosts", async () => {
    const skill = await readFile(path.resolve("skills/quick-image/SKILL.md"), "utf8");

    expect(skill).toContain("`quick-image-local` 本地 MCP");
    expect(skill).toContain("quick_image_list_attachments");
    expect(skill).toContain("quick_image_send_preview");
    expect(skill).not.toContain("Codex 本地工具");
    expect(skill).not.toContain("或 `quick_image_");
    expect(skill).not.toContain("quick_image_inspect_attachment");
  });
});

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}
