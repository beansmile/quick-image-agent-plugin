import { createRequire } from "node:module";
import process from "node:process";
import { parseArgs } from "node:util";
import {
  executeEnvironmentCommand,
  formatEnvironmentResult,
  type EnvironmentAction,
  type EnvironmentHost
} from "../environment/service.js";

const require = createRequire(import.meta.url);
const pluginPackage = require("../../package.json") as { version?: unknown };
const pluginVersion = typeof pluginPackage.version === "string" ? pluginPackage.version : undefined;

export async function runQuickImageCli(argv: string[]): Promise<string> {
  if (!pluginVersion) throw new Error("package.json 缺少插件版本");
  const normalized = argv[0] === "--" ? argv.slice(1) : argv;
  const [namespace, actionValue, ...optionArguments] = normalized;
  if (namespace !== "env" || !isEnvironmentAction(actionValue)) throw usageError();

  const { values } = parseArgs({
    args: optionArguments,
    allowPositionals: false,
    strict: true,
    options: {
      host: { type: "string" },
      "server-url": { type: "string" },
      "frontend-url": { type: "string" },
      "codex-bin": { type: "string" },
      "openclaw-bin": { type: "string" }
    }
  });
  const host = parseHost(values.host);
  if (actionValue !== "set" && (values["server-url"] || values["frontend-url"])) {
    throw new Error("env status/reset 不接受 --server-url 或 --frontend-url");
  }

  const statuses = await executeEnvironmentCommand({
    action: actionValue,
    host,
    pluginVersion,
    ...(values["server-url"] ? { serverUrl: values["server-url"] } : {}),
    ...(values["frontend-url"] ? { frontendUrl: values["frontend-url"] } : {}),
    ...(values["codex-bin"] ? { codexBin: values["codex-bin"] } : {}),
    ...(values["openclaw-bin"] ? { openClawBin: values["openclaw-bin"] } : {})
  });
  return formatEnvironmentResult(actionValue, statuses);
}

function parseHost(value: string | undefined): EnvironmentHost {
  if (value === "codex" || value === "openclaw" || value === "all") return value;
  throw new Error("--host 必须是 codex、openclaw 或 all");
}

function isEnvironmentAction(value: string | undefined): value is EnvironmentAction {
  return value === "set" || value === "status" || value === "reset";
}

function usageError(): Error {
  return new Error([
    "用法：",
    "  quick-image env set --host openclaw --server-url <URL> --frontend-url <URL>",
    "  quick-image env status --host <codex|openclaw|all>",
    "  quick-image env reset --host openclaw"
  ].join("\n"));
}

runQuickImageCli(process.argv.slice(2))
  .then((output) => process.stdout.write(output))
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Quick Image 环境配置失败：${message}\n`);
    process.exitCode = 1;
  });
