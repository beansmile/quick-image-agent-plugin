import { describe, expect, it, vi } from "vitest";
import type { CommandExecutor } from "../src/environment/command-executor.js";
import {
  formatOpenClawSetupResult,
  setupOpenClaw,
  type ConfirmationPrompt
} from "../src/environment/openclaw-setup.js";

describe("OpenClaw setup", () => {
  it("merges tool access, creates production MCP, and prompts for manual login", async () => {
    const calls: string[][] = [];
    const executor = fixtureExecutor(calls, {
      tools: { profile: "coding", alsoAllow: ["existing-tool"] },
      servers: {}
    });
    const prompt = fixturePrompt(true, []);

    const result = await setupOpenClaw({
      pluginVersion: "0.1.0",
      openClawBin: "/bin/echo",
      executor,
      prompt
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
    expect(calls).not.toContainEqual(["mcp", "reload"]);
    expect(prompt.confirm).not.toHaveBeenCalled();
    expect(calls.at(-1)).toEqual(["gateway", "restart"]);
    expect(result).toEqual({ toolAccessChanged: true, mcpAction: "created" });
    expect(formatOpenClawSetupResult(result)).toContain("请运行以下命令登录 Quick Image MCP：\nopenclaw mcp login quick-image");
  });

  it("is idempotent and updates the managed production config without prompting for replacement", async () => {
    const calls: string[][] = [];
    const executor = fixtureExecutor(calls, {
      tools: { alsoAllow: ["quick-image"] },
      servers: { "quick-image": { url: "https://quickimage.ai/mcp" } }
    });
    const prompt = fixturePrompt(true, []);

    const result = await setupOpenClaw({
      pluginVersion: "0.2.0",
      openClawBin: "/bin/echo",
      executor,
      prompt
    });

    expect(calls.some((args) => args[0] === "config" && args[1] === "set")).toBe(false);
    expect(prompt.confirm).not.toHaveBeenCalled();
    expect(result).toEqual({ toolAccessChanged: false, mcpAction: "updated" });
  });

  it("does not overwrite a custom MCP in a non-interactive environment", async () => {
    const calls: string[][] = [];
    const executor = fixtureExecutor(calls, {
      tools: {},
      servers: { "quick-image": { url: "https://custom.example.com/mcp" } }
    });
    const prompt = fixturePrompt(false, []);

    const result = await setupOpenClaw({
      pluginVersion: "0.1.0",
      openClawBin: "/bin/echo",
      executor,
      prompt
    });

    expect(calls.some((args) => args[0] === "mcp" && args[1] === "set")).toBe(false);
    expect(prompt.confirm).not.toHaveBeenCalled();
    expect(result).toEqual({ toolAccessChanged: true, mcpAction: "kept-custom" });
  });

  it("replaces a custom MCP only after explicit confirmation", async () => {
    const calls: string[][] = [];
    const executor = fixtureExecutor(calls, {
      tools: { alsoAllow: ["quick-image"] },
      servers: { "quick-image": { url: "https://custom.example.com/mcp" } }
    });
    const prompt = fixturePrompt(true, [true]);

    const result = await setupOpenClaw({
      pluginVersion: "0.1.0",
      openClawBin: "/bin/echo",
      executor,
      prompt
    });

    const mcpSet = calls.find((args) => args[0] === "mcp" && args[1] === "set");
    expect(JSON.parse(mcpSet?.[3] ?? "null")).toMatchObject({ url: "https://quickimage.ai/mcp" });
    expect(prompt.confirm).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ toolAccessChanged: false, mcpAction: "updated" });
  });

  it("stops before gateway restart when required MCP configuration fails", async () => {
    const calls: string[][] = [];
    const executor = fixtureExecutor(calls, { tools: {}, servers: {} }, true);

    await expect(setupOpenClaw({
      pluginVersion: "0.1.0",
      openClawBin: "/bin/echo",
      executor,
      prompt: fixturePrompt(false, [])
    })).rejects.toThrow("MCP 配置失败");

    expect(calls).not.toContainEqual(["mcp", "reload"]);
    expect(calls).not.toContainEqual(["gateway", "restart"]);
  });
});

function fixtureExecutor(
  calls: string[][],
  config: { tools: Record<string, unknown>; servers: Record<string, unknown> },
  failMcpSet = false
): CommandExecutor {
  return {
    run: vi.fn((_executable, args) => {
      calls.push(args);
      if (args[0] === "config" && args[1] === "get" && args[2] === "tools") {
        return { stdout: JSON.stringify(config.tools), stderr: "" };
      }
      if (args[0] === "config" && args[1] === "get" && args[2] === "mcp.servers") {
        return { stdout: JSON.stringify(config.servers), stderr: "" };
      }
      if (failMcpSet && args[0] === "mcp" && args[1] === "set") throw new Error("MCP 配置失败");
      return { stdout: "", stderr: "" };
    })
  };
}

function fixturePrompt(interactive: boolean, answers: boolean[]): ConfirmationPrompt {
  return {
    interactive,
    confirm: vi.fn(async () => answers.shift() ?? false)
  };
}
