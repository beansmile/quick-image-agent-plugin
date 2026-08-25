import { describe, expect, it, vi } from "vitest";
import type { CommandExecutor } from "../src/environment/command-executor.js";
import { readCodexEnvironmentStatus } from "../src/environment/codex.js";
import {
  buildOpenClawMcpConfig,
  normalizeEnvironmentUrls,
  productionEnvironmentUrls,
  validateFrontendUrl,
  validateServerUrl
} from "../src/environment/config.js";
import { setOpenClawEnvironment } from "../src/environment/openclaw.js";
import { executeEnvironmentCommand } from "../src/environment/service.js";

describe("Quick Image environment URL validation", () => {
  it("accepts HTTPS remote URLs and loopback HTTP URLs", () => {
    expect(normalizeEnvironmentUrls(
      "https://staging-api.example.com/mcp",
      "https://staging.example.com"
    )).toEqual({
      serverUrl: "https://staging-api.example.com/mcp",
      frontendUrl: "https://staging.example.com"
    });
    expect(validateServerUrl("http://127.0.0.1:3000/mcp")).toBe("http://127.0.0.1:3000/mcp");
    expect(validateFrontendUrl("http://localhost:8001")).toBe("http://localhost:8001");
  });

  it.each([
    ["http://staging-api.example.com/mcp", "https://staging.example.com"],
    ["https://staging-api.example.com/api", "https://staging.example.com"],
    ["https://staging-api.example.com/mcp?token=test", "https://staging.example.com"],
    ["https://staging-api.example.com/mcp", "https://staging.example.com/path"]
  ])("rejects unsafe or malformed URL pairs", (serverUrl, frontendUrl) => {
    expect(() => normalizeEnvironmentUrls(serverUrl, frontendUrl)).toThrow();
  });

  it("builds the production OpenClaw MCP config without an environment label", () => {
    expect(buildOpenClawMcpConfig(productionEnvironmentUrls(), "0.1.0")).toEqual({
      transport: "streamable-http",
      url: "https://quickimage.ai/mcp",
      auth: "oauth",
      oauth: { scope: "presets:read assets:write tasks:read tasks:write" },
      headers: {
        "X-Quick-Image-Plugin-Version": "0.1.0",
        "X-Quick-Image-Frontend-URL": "https://quickimage.ai"
      }
    });
  });
});

describe("Codex plugin MCP environment", () => {
  it("reads the effective plugin manifest configuration without editing config.toml", async () => {
    const urls = {
      serverUrl: "http://127.0.0.1:3000/mcp",
      frontendUrl: "http://127.0.0.1:8001"
    };
    const executor = codexExecutor(() => urls);

    const status = await readCodexEnvironmentStatus({ codexBin: "/bin/echo", executor });

    expect(status).toMatchObject({ host: "codex", source: "custom", ...urls });
    expect(status).not.toHaveProperty("configPath");
    expect(executor.run).toHaveBeenCalledTimes(1);
  });

  it.each(["set", "reset"] as const)("rejects Codex env %s because the plugin manifest owns URLs", async (action) => {
    await expect(executeEnvironmentCommand({
      action,
      host: "codex",
      pluginVersion: "0.1.0",
      ...(action === "set" ? {
        serverUrl: "http://127.0.0.1:3000/mcp",
        frontendUrl: "http://127.0.0.1:8001"
      } : {})
    })).rejects.toThrow("Plugin MCP 清单");
  });
});

describe("OpenClaw environment adapter", () => {
  it("uses only official OpenClaw configuration and refresh commands", async () => {
    const calls: string[][] = [];
    const urls = {
      serverUrl: "https://staging-api.example.com/mcp",
      frontendUrl: "https://staging.example.com"
    };
    const executor: CommandExecutor = {
      run: vi.fn((_executable, args) => {
        calls.push(args);
        if (args[0] === "config") {
          return {
            stdout: JSON.stringify(buildOpenClawMcpConfig(urls, "0.1.0")),
            stderr: ""
          };
        }
        return { stdout: "", stderr: "" };
      })
    };

    const status = await setOpenClawEnvironment(urls, {
      pluginVersion: "0.1.0",
      openClawBin: "/bin/echo",
      executor
    });

    expect(calls.map((args) => args.slice(0, 2))).toEqual([
      ["mcp", "set"],
      ["gateway", "restart"],
      ["config", "get"]
    ]);
    expect(status).toMatchObject({ host: "openclaw", source: "custom", ...urls });
  });
});

function codexExecutor(urls: () => { serverUrl: string; frontendUrl: string }): CommandExecutor {
  return {
    run: vi.fn((_executable, args) => {
      if (args[0] === "mcp" && args[1] === "get") {
        return {
          stdout: JSON.stringify({
            transport: {
              url: urls().serverUrl,
              http_headers: { "X-Quick-Image-Frontend-URL": urls().frontendUrl }
            }
          }),
          stderr: ""
        };
      }
      return { stdout: "[]", stderr: "" };
    })
  };
}
