import { describe, expect, it, vi } from "vitest";
import type { CommandExecutor, InteractiveCommandExecutor } from "../src/environment/command-executor.js";
import {
  formatOpenClawSetupResult,
  setupOpenClaw,
  type ConfirmationPrompt
} from "../src/environment/openclaw-setup.js";

describe("OpenClaw setup", () => {
  it("merges tool access, creates production MCP, and supports interactive login", async () => {
    const calls: string[][] = [];
    const executor = fixtureExecutor(calls, {
      tools: { profile: "coding", alsoAllow: ["existing-tool"] },
      servers: {}
    });
    const interactiveExecutor: InteractiveCommandExecutor = { run: vi.fn() };
    const prompt = fixturePrompt(true, [true]);

    const result = await setupOpenClaw({
      pluginVersion: "0.1.0",
      openClawBin: "/bin/echo",
      executor,
      interactiveExecutor,
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
    expect(interactiveExecutor.run).toHaveBeenCalledWith("/bin/echo", ["mcp", "login", "quick-image"]);
    expect(calls.slice(-2)).toEqual([["mcp", "reload"], ["gateway", "restart"]]);
    expect(result).toEqual({ toolAccessChanged: true, mcpAction: "created", loginAction: "started" });
  });

  it("is idempotent and updates the managed production config without prompting for replacement", async () => {
    const calls: string[][] = [];
    const executor = fixtureExecutor(calls, {
      tools: { alsoAllow: ["quick-image"] },
      servers: { "quick-image": { url: "https://quickimage.ai/mcp" } }
    });
    const prompt = fixturePrompt(true, [false]);

    const result = await setupOpenClaw({
      pluginVersion: "0.2.0",
      openClawBin: "/bin/echo",
      executor,
      interactiveExecutor: { run: vi.fn() },
      prompt
    });

    expect(calls.some((args) => args[0] === "config" && args[1] === "set")).toBe(false);
    expect(prompt.confirm).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ toolAccessChanged: false, mcpAction: "updated", loginAction: "skipped" });
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
      interactiveExecutor: { run: vi.fn() },
      prompt
    });

    expect(calls.some((args) => args[0] === "mcp" && args[1] === "set")).toBe(false);
    expect(prompt.confirm).not.toHaveBeenCalled();
    expect(result).toEqual({ toolAccessChanged: true, mcpAction: "kept-custom", loginAction: "skipped" });
  });

  it("replaces a custom MCP only after explicit confirmation", async () => {
    const calls: string[][] = [];
    const executor = fixtureExecutor(calls, {
      tools: { alsoAllow: ["quick-image"] },
      servers: { "quick-image": { url: "https://custom.example.com/mcp" } }
    });
    const prompt = fixturePrompt(true, [true, false]);

    const result = await setupOpenClaw({
      pluginVersion: "0.1.0",
      openClawBin: "/bin/echo",
      executor,
      interactiveExecutor: { run: vi.fn() },
      prompt
    });

    const mcpSet = calls.find((args) => args[0] === "mcp" && args[1] === "set");
    expect(JSON.parse(mcpSet?.[3] ?? "null")).toMatchObject({ url: "https://quickimage.ai/mcp" });
    expect(prompt.confirm).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ toolAccessChanged: false, mcpAction: "updated", loginAction: "skipped" });
  });

  it("still reloads and restarts when optional login fails", async () => {
    const calls: string[][] = [];
    const executor = fixtureExecutor(calls, { tools: {}, servers: {} });
    const interactiveExecutor: InteractiveCommandExecutor = {
      run: vi.fn(() => { throw new Error("登录取消"); })
    };

    const result = await setupOpenClaw({
      pluginVersion: "0.1.0",
      openClawBin: "/bin/echo",
      executor,
      interactiveExecutor,
      prompt: fixturePrompt(true, [true])
    });

    expect(calls.slice(-2)).toEqual([["mcp", "reload"], ["gateway", "restart"]]);
    expect(result).toMatchObject({ loginAction: "failed", loginError: "登录取消" });
    expect(formatOpenClawSetupResult(result)).toContain("openclaw mcp login quick-image");
  });

  it("stops before reload when required MCP configuration fails", async () => {
    const calls: string[][] = [];
    const executor = fixtureExecutor(calls, { tools: {}, servers: {} }, true);

    await expect(setupOpenClaw({
      pluginVersion: "0.1.0",
      openClawBin: "/bin/echo",
      executor,
      interactiveExecutor: { run: vi.fn() },
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
