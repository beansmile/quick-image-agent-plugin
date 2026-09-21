import { Worker } from "node:worker_threads";
import type { ProductionEnvironmentReport } from "quick-image-agent-runtime";

const ENVIRONMENT_CHECK_TIMEOUT_MS = 10_000;

export function runEnvironmentProductionCheck(): Promise<ProductionEnvironmentReport> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (report: ProductionEnvironmentReport) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(report);
    };
    const worker = new Worker(new URL("./environment-check-worker.js", import.meta.url));
    const timeout = setTimeout(() => {
      void worker.terminate()
        .catch(() => undefined)
        .then(() => settle(unavailableEnvironmentReport()));
    }, ENVIRONMENT_CHECK_TIMEOUT_MS);
    timeout.unref();
    worker.once("message", (report: ProductionEnvironmentReport) => settle(report));
    worker.once("error", () => {
      void worker.terminate()
        .catch(() => undefined)
        .then(() => settle(unavailableEnvironmentReport()));
    });
    worker.once("exit", (exitCode) => {
      if (exitCode !== 0) settle(unavailableEnvironmentReport());
    });
  });
}

function unavailableEnvironmentReport(): ProductionEnvironmentReport {
  return {
    hosts: [
      { host: "codex", available: false, is_production: null, source: "unavailable" },
      { host: "openclaw", available: false, is_production: null, source: "unavailable" }
    ]
  };
}
