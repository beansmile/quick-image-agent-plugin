import { parentPort } from "node:worker_threads";
import { checkEnvironmentProduction, RUNTIME_VERSION } from "quick-image-agent-runtime";

// 独立 worker 入口：runtime 的环境检查用 spawnSync 派生 codex/openclaw CLI，
// 必须移出 OpenClaw Gateway 主线程执行。
const report = await checkEnvironmentProduction({ runtimeVersion: RUNTIME_VERSION });
parentPort?.postMessage(report);
parentPort?.close();
