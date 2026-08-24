import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveCodexCli } from "../scripts/lib/resolve-codex-cli.mjs";

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("resolveCodexCli", () => {
  it("finds codex on PATH", async () => {
    const directory = await executableDirectory("codex");

    expect(resolveCodexCli({ pathValue: directory, platform: "linux", applicationCandidates: [] }))
      .toBe(path.join(directory, "codex"));
  });

  it("falls back to a desktop application binary", async () => {
    const directory = await executableDirectory("desktop-codex");
    const candidate = path.join(directory, "desktop-codex");

    expect(resolveCodexCli({ pathValue: "", platform: "darwin", applicationCandidates: [candidate] }))
      .toBe(candidate);
  });

  it("honors an explicit binary path", async () => {
    const directory = await executableDirectory("custom-codex");
    const candidate = path.join(directory, "custom-codex");

    expect(resolveCodexCli({ explicitPath: candidate, pathValue: "", applicationCandidates: [] })).toBe(candidate);
  });

  it("fails with an actionable message when codex is unavailable", () => {
    expect(() => resolveCodexCli({ pathValue: "", platform: "linux", applicationCandidates: [] }))
      .toThrow("CODEX_CLI_PATH/--codex-bin");
  });
});

async function executableDirectory(name) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "quick-image-codex-cli-"));
  temporaryDirectories.push(directory);
  const executablePath = path.join(directory, name);
  await writeFile(executablePath, "#!/bin/sh\nexit 0\n");
  await chmod(executablePath, 0o755);
  return directory;
}
