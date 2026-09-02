import { describe, expect, it, vi } from "vitest";
import type { CommandExecutor } from "../src/environment/command-executor.js";
import {
  formatOpenClawSetupResult,
  setupOpenClaw
} from "../src/environment/openclaw-setup.js";

describe("OpenClaw setup", () => {
  it("merges tool access, sets production MCP, and prompts for manual login", async () => {
    const calls: string[][] = [];
    const executor = fixtureExecutor(calls, { profile: "coding", alsoAllow: ["existing-tool"] });

    const result = await setupOpenClaw({
      pluginVersion: "0.1.0",
      openClawBin: "/bin/echo",
      executor
    });

    expect(calls).toContainEqual([
      "config", "set", "tools.alsoAllow", '["existing-tool","quick-image"]', "--strict-json"
    ]);
    const mcpSet = calls.find((args) => args[0] === "mcp" && args[1] === "set");
    expect(JSON.parse(mcpSet?.[3] ?? "null")).toMatchObject({
      url: "https://quickimage.ai/mcp",
      headers: { "X-Quick-Image-Plugin-Version": "0.1.0" }
    });
    expect(calls).not.toContainEqual(["mcp", "login", "quick-image"]);
    expect(calls).not.toContainEqual(["gateway", "restart"]);
    expect(calls.some((args) => args[0] === "config" && args[1] === "get" && args[2] === "mcp.servers")).toBe(false);
    expect(calls.at(-1)).toEqual(["mcp", "reload"]);
    expect(result).toEqual({ toolAccessChanged: true });
    expect(formatOpenClawSetupResult(result)).toContain("请运行以下命令登录 Quick Image MCP：\nopenclaw mcp login quick-image");
  });

  it("always overwrites the MCP with the production config", async () => {
    const calls: string[][] = [];
    const executor = fixtureExecutor(calls, { alsoAllow: ["quick-image"] });

    const result = await setupOpenClaw({
      pluginVersion: "0.2.0",
      openClawBin: "/bin/echo",
      executor
    });

    expect(calls.some((args) => args[0] === "config" && args[1] === "set")).toBe(false);
    const mcpSet = calls.find((args) => args[0] === "mcp" && args[1] === "set");
    expect(JSON.parse(mcpSet?.[3] ?? "null")).toMatchObject({ url: "https://quickimage.ai/mcp" });
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
