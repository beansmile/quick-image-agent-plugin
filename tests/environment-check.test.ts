import { describe, expect, it } from "vitest";
import { runEnvironmentProductionCheck } from "../src/openclaw-adapter/environment-check.js";

describe("environment check runner", () => {
  it("resolves with an unavailable report instead of throwing when the worker entry cannot load", async () => {
    // vitest 从 src 加载本模块，编译产物 environment-check-worker.js 不在旁边，
    // worker 必然加载失败，正好覆盖降级路径。
    const report = await runEnvironmentProductionCheck();

    expect(report.hosts).toEqual([
      { host: "codex", available: false, is_production: null, source: "unavailable" },
      { host: "openclaw", available: false, is_production: null, source: "unavailable" }
    ]);
  });
});
