import {
  executeEnvironmentCommand,
  formatEnvironmentResult,
  type EnvironmentAction
} from "../environment/service.js";
import {
  formatOpenClawSetupResult,
  setupOpenClaw
} from "../environment/openclaw-setup.js";

interface CommandLike {
  command(name: string): CommandLike;
  description(value: string): CommandLike;
  requiredOption(flags: string, description: string): CommandLike;
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

export function registerOpenClawEnvironmentCli(api: OpenClawCliApi): void {
  api.registerCli(({ program }) => {
    const root = program.command("quick-image").description("管理 Quick Image 插件配置");
    root.command("setup")
      .description("配置工具权限和正式环境 MCP")
      .action(() => runOpenClawSetup(api));
    const environment = root.command("env").description("管理 Quick Image Server 和 Frontend URL");
    environment.command("set")
      .description("设置 Quick Image Server 和 Frontend URL")
      .requiredOption("--server-url <url>", "Quick Image MCP URL")
      .requiredOption("--frontend-url <url>", "Quick Image 前端 origin")
      .action((options) => runOpenClawAction(api, "set", options));
    environment.command("status")
      .description("显示当前生效的 Quick Image URL")
      .action((options) => runOpenClawAction(api, "status", options));
    environment.command("reset")
      .description("恢复 Quick Image 正式默认 URL")
      .action((options) => runOpenClawAction(api, "reset", options));
  }, {
    descriptors: [{
      name: "quick-image",
      description: "管理 Quick Image 插件配置",
      hasSubcommands: true
    }]
  });
}

async function runOpenClawSetup(api: OpenClawCliApi): Promise<void> {
  if (!api.version) throw new Error("OpenClaw 未提供 Quick Image 插件版本");
  const result = await setupOpenClaw({ pluginVersion: api.version });
  process.stdout.write(formatOpenClawSetupResult(result));
}

async function runOpenClawAction(
  api: OpenClawCliApi,
  action: EnvironmentAction,
  options: Record<string, string | undefined>
): Promise<void> {
  if (!api.version) throw new Error("OpenClaw 未提供 Quick Image 插件版本");
  const statuses = await executeEnvironmentCommand({
    action,
    host: "openclaw",
    pluginVersion: api.version,
    ...(options.serverUrl ? { serverUrl: options.serverUrl } : {}),
    ...(options.frontendUrl ? { frontendUrl: options.frontendUrl } : {})
  });
  process.stdout.write(formatEnvironmentResult(action, statuses));
}
