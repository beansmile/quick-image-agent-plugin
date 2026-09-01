import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  formatOpenClawSetupResult,
  setupOpenClaw
} from "../environment/openclaw-setup.js";

interface CommandLike {
  command(name: string): CommandLike;
  description(value: string): CommandLike;
  option?(flags: string, description: string): CommandLike;
  action(handler: (options: Record<string, string | undefined>) => void | Promise<void>): CommandLike;
}

interface OpenClawCliApi {
  version?: string;
  registerCli(
    registrar: (context: { program: CommandLike }) => void | Promise<void>,
    options: {
      descriptors: Array<{ name: string; description: string; hasSubcommands: boolean }>;
    }
  ): void;
}

export function registerOpenClawCli(api: OpenClawCliApi): void {
  api.registerCli(({ program }) => {
    const root = program.command("quick-image").description("管理 Quick Image 插件配置");
    root.command("setup")
      .description("配置工具权限和正式环境 MCP")
      .action(() => runOpenClawSetup(api));
    const env = root.command("env").description("管理 Quick Image 环境");
    for (const action of ["set", "status", "reset"] as const) {
      const command = env.command(action).description(`切换 Quick Image 环境（${action}）`);
      command.option?.("--server-url <url>", "MCP Server URL").option?.("--frontend-url <url>", "Frontend URL");
      command.action((options) => runRuntimeEnvironment(api, action, options));
    }
  }, {
    descriptors: [{
      name: "quick-image",
      description: "管理 Quick Image 插件配置",
      hasSubcommands: true
    }]
  });
}

async function runRuntimeEnvironment(
  api: OpenClawCliApi,
  action: "set" | "status" | "reset",
  options: Record<string, string | undefined>
): Promise<void> {
  if (!api.version) throw new Error("OpenClaw 未提供 Quick Image 插件版本");
  // Runtime 仅公开主入口，不能通过 package.json 子路径定位其安装目录。
  const runtimeEntry = fileURLToPath(import.meta.resolve("quick-image-agent-runtime"));
  const executable = path.join(path.dirname(runtimeEntry), "cli", "quick-image.js");
  const args = [executable, "env", action, "--host", "openclaw"];
  if (options.serverUrl) args.push("--server-url", options.serverUrl);
  if (options.frontendUrl) args.push("--frontend-url", options.frontendUrl);
  const result = spawnSync(process.execPath, args, { encoding: "utf8", stdio: "inherit" });
  if (result.error) throw new Error(`无法启动 quick-image-agent-runtime：${result.error.message}`);
  if (result.status !== 0) throw new Error(`quick-image-agent-runtime env ${action} 执行失败`);
}

async function runOpenClawSetup(api: OpenClawCliApi): Promise<void> {
  if (!api.version) throw new Error("OpenClaw 未提供 Quick Image 插件版本");
  const result = await setupOpenClaw({ pluginVersion: api.version });
  process.stdout.write(formatOpenClawSetupResult(result));
}
