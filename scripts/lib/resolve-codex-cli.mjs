import { accessSync, constants } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

export function resolveCodexCli({
  explicitPath = process.env.CODEX_CLI_PATH?.trim(),
  pathValue = process.env.PATH ?? "",
  platform = process.platform,
  homeDirectory = os.homedir(),
  applicationCandidates
} = {}) {
  if (explicitPath) return requireExecutable(explicitPath, "指定的 Codex CLI");

  const pathMatch = findOnPath("codex", pathValue, platform);
  if (pathMatch) return pathMatch;

  const candidates = applicationCandidates ?? defaultApplicationCandidates(platform, homeDirectory);
  for (const candidate of candidates) {
    if (isExecutable(candidate)) return candidate;
  }

  throw new Error(
    "找不到 Codex CLI。请安装 Codex Desktop、将 codex 加入 PATH，或设置 CODEX_CLI_PATH/--codex-bin。"
  );
}

function findOnPath(command, pathValue, platform) {
  const extensions = platform === "win32"
    ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";")
    : [""];
  for (const directory of pathValue.split(path.delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = path.join(directory, `${command}${extension.toLowerCase()}`);
      if (isExecutable(candidate)) return candidate;
    }
  }
  return undefined;
}

function defaultApplicationCandidates(platform, homeDirectory) {
  if (platform !== "darwin") return [];
  const applicationNames = ["ChatGPT.app", "Codex.app"];
  return applicationNames.flatMap((applicationName) => [
    path.join("/Applications", applicationName, "Contents", "Resources", "codex"),
    path.join(homeDirectory, "Applications", applicationName, "Contents", "Resources", "codex")
  ]);
}

function requireExecutable(filePath, label) {
  const resolved = path.resolve(filePath);
  if (!isExecutable(resolved)) throw new Error(`${label}不存在或不可执行：${resolved}`);
  return resolved;
}

function isExecutable(filePath) {
  try {
    accessSync(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
