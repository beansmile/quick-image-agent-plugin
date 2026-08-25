import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("OpenClaw plugin contract", () => {
  it("declares the native tool and runtime contracts", async () => {
    const manifest = await readJson(path.resolve("openclaw.plugin.json"));
    const pluginPackage = await readJson(path.resolve("package.json"));

    expect(manifest.id).toBe("quick-image");
    expect(manifest).not.toHaveProperty("requiresPlugins");
    expect(manifest).not.toHaveProperty("mcpServers");
    expect(manifest.skills).toEqual(["./skills"]);
    expect(manifest.contracts.tools).toEqual([
      "quick_image_list_attachments",
      "quick_image_inspect_attachment",
      "quick_image_prepare_attachment",
      "quick_image_estimate_lookbook_credits",
      "quick_image_estimate_pose_credits",
      "quick_image_estimate_upscale_credits",
      "quick_image_estimate_video_credits",
      "quick_image_upload_staged_attachment",
      "quick_image_send_preview"
    ]);
    expect(manifest.contracts).not.toHaveProperty("trustedToolPolicies");
    expect(pluginPackage.openclaw.extensions).toEqual(["./openclaw-adapter/dist/index.js"]);
  });

  it("keeps the local installer focused on official install, enable, and environment commands", async () => {
    const packageJson = await readJson(path.resolve("package.json"));
    const installer = packageJson.scripts["dev:install:openclaw"];

    expect(installer).toContain("openclaw plugins install . --force");
    expect(installer).toContain("openclaw plugins enable quick-image");
    expect(installer).toContain("openclaw quick-image env set");
    expect(installer).not.toContain("plugins doctor");
    expect(installer).not.toContain("mcp login");
    expect(installer).not.toContain("install-local-openclaw.mjs");
  });
});

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}
