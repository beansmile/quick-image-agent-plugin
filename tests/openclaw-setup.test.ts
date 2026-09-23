import { describe, expect, it, vi } from "vitest";
import type { CommandExecutor } from "../src/environment/command-executor.js";
import { setupOpenClaw } from "../src/environment/openclaw-setup.js";
import pluginPackage from "../package.json" with { type: "json" };

const runtimeSpec = `quick-image-agent-runtime@${pluginPackage.dependencies["quick-image-agent-runtime"]}`;

describe("OpenClaw setup", () => {
  it("merges tool access, sets both MCP servers, and prompts for manual login", async () => {
    const calls: string[][] = [];
    const executor = fixtureExecutor(calls, { profile: "coding", alsoAllow: ["existing-tool"] });

    const result = await setupOpenClaw({
      pluginVersion: "0.1.0",
      openClawBin: "/bin/echo",
      executor
    });

    expect(calls).toContainEqual([
      "config", "set", "tools.alsoAllow", '["existing-tool","quick-image","quick-image-local"]', "--strict-json"
    ]);
    const remoteSet = calls.find((args) => args[0] === "mcp" && args[1] === "set" && args[2] === "quick-image");
    expect(JSON.parse(remoteSet?.[3] ?? "null")).toMatchObject({
      url: "https://quickimage.ai/mcp",
      headers: { "X-Quick-Image-Plugin-Version": "0.1.0" }
    });
    const localSet = calls.find((args) => args[0] === "mcp" && args[1] === "set" && args[2] === "quick-image-local");
    expect(JSON.parse(localSet?.[3] ?? "null")).toEqual({
      command: "npx",
      args: ["--yes", "--package", runtimeSpec, "quick-image-local-mcp"]
    });
    expect(calls).not.toContainEqual(["mcp", "login", "quick-image"]);
    expect(calls).not.toContainEqual(["gateway", "restart"]);
    expect(calls.some((args) => args[0] === "config" && args[1] === "get" && args[2] === "mcp.servers")).toBe(false);
    expect(calls.at(-1)).toEqual(["mcp", "reload"]);
    expect(result).toEqual({ toolAccessChanged: true });
  });

  it("always overwrites both MCP entries with the production config", async () => {
    const calls: string[][] = [];
    const executor = fixtureExecutor(calls, { alsoAllow: ["quick-image", "quick-image-local"] });

    const result = await setupOpenClaw({
      pluginVersion: "0.2.0",
      openClawBin: "/bin/echo",
      executor
    });

    expect(calls.some((args) => args[0] === "config" && args[1] === "set")).toBe(false);
    const remoteSet = calls.find((args) => args[0] === "mcp" && args[1] === "set" && args[2] === "quick-image");
    expect(JSON.parse(remoteSet?.[3] ?? "null")).toMatchObject({ url: "https://quickimage.ai/mcp" });
    const localSet = calls.find((args) => args[0] === "mcp" && args[1] === "set" && args[2] === "quick-image-local");
    expect(JSON.parse(localSet?.[3] ?? "null")).toMatchObject({ command: "npx" });
    expect(calls.some((args) => args[0] === "config" && args[1] === "get" && args[2] === "mcp.servers")).toBe(false);
    expect(result).toEqual({ toolAccessChanged: false });
  });

  it("stops before MCP reload when required MCP configuration fails", async () => {
    const calls: string[][] = [];
    const executor = fixtureExecutor(calls, {}, true);

    await expect(setupOpenClaw({
      pluginVersion: "0.1.0",
      openClawBin: "/bin/echo",
      executor
    })).rejects.toThrow("MCP 配置失败");

    expect(calls).not.toContainEqual(["gateway", "restart"]);
    expect(calls).not.toContainEqual(["mcp", "reload"]);
  });
});

function fixtureExecutor(
  calls: string[][],
  tools: Record<string, unknown>,
  failMcpSet = false
): CommandExecutor {
  return {
    run: vi.fn((_executable, args) => {
      calls.push(args);
      if (args[0] === "config" && args[1] === "get" && args[2] === "tools") {
        return { stdout: JSON.stringify(tools), stderr: "" };
      }
      if (failMcpSet && args[0] === "mcp" && args[1] === "set") throw new Error("MCP 配置失败");
      return { stdout: "", stderr: "" };
    })
  };
}
