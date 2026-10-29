import { accessSync, constants } from "node:fs";
import path from "node:path";

export function resolveOpenClawExecutable(explicitPath?: string): string {
  const configured = explicitPath?.trim() || process.env.OPENCLAW_CLI_PATH?.trim();
  if (configured) return requireExecutable(configured, "指定的 OpenClaw CLI");
  return findOnPath("openclaw") ?? "openclaw";
}

function findOnPath(command: string): string | undefined {
  const extensions = process.platform === "win32"
    ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";")
    : [""];
  for (const directory of (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = path.join(directory, `${command}${extension.toLowerCase()}`);
      if (isExecutable(candidate)) return candidate;
    }
  }
  return undefined;
}

function requireExecutable(filePath: string, label: string): string {
  const resolved = path.resolve(filePath);
  if (!isExecutable(resolved)) throw new Error(`${label}不存在或不可执行：${resolved}`);
  return resolved;
}

function isExecutable(filePath: string): boolean {
  try {
    accessSync(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
