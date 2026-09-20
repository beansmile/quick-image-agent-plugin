// src/openclaw-adapter/environment-check-worker.ts
import { parentPort } from "worker_threads";
import { checkEnvironmentProduction, RUNTIME_VERSION } from "quick-image-agent-runtime";
var report = await checkEnvironmentProduction({ runtimeVersion: RUNTIME_VERSION });
parentPort?.postMessage(report);
parentPort?.close();
