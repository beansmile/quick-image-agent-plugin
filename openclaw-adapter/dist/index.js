// src/openclaw-adapter/index.ts
import path4 from "path";
import {
  assertSupportedRuntime,
  AttachmentPipeline,
  HANDLE_CLEANUP_INTERVAL_MS,
  resolveOpenClawAttachmentRegistryDirectory
} from "quick-image-agent-runtime";

// src/openclaw/attachment-registry.ts
import { createHash, randomBytes, timingSafeEqual } from "crypto";
import { constants as fsConstants } from "fs";
import { chmod, lstat, mkdir, open, readFile, readdir, rm } from "fs/promises";
import path from "path";
import { HANDLE_TTL_MS, PluginError } from "quick-image-agent-runtime";
var ATTACHMENT_ID_PATTERN = /^qio_[A-Za-z0-9_-]{43}$/;
var DEFAULT_LIST_LIMIT = 10;
var OpenClawAttachmentRegistry = class {
  recordsDirectory;
  initialized;
  lastRegistrationTimeMs = 0;
  constructor(root) {
    this.recordsDirectory = path.join(root, "openclaw-attachment-records");
  }
  initialize() {
    this.initialized ??= this.initializeOnce();
    return this.initialized;
  }
  async register(params) {
    await this.initialize();
    const registrationTimeMs = Math.max(Date.now(), this.lastRegistrationTimeMs + 1);
    this.lastRegistrationTimeMs = registrationTimeMs;
    const now = new Date(registrationTimeMs);
    const sessionDigest = digest(params.sessionKey);
    await Promise.all(params.attachments.map(async (attachment) => {
      if (!isSupportedSourceReference(attachment.source_reference)) return;
      const attachmentId = createAttachmentId();
      const record = {
        ...attachment,
        attachment_id: attachmentId,
        session_digest: sessionDigest,
        ...params.runId ? { run_id: params.runId } : {},
        ...params.messageId ? { message_id: params.messageId } : {},
        received_at: now.toISOString(),
        expires_at: new Date(now.getTime() + HANDLE_TTL_MS).toISOString()
      };
      await writePrivateJson(this.recordPath(attachmentId), record);
    }));
  }
  async list(sessionKey, options = {}) {
    return (await this.listCandidates(sessionKey, options)).attachments;
  }
  async listCandidates(sessionKey, options = {}) {
    await this.initialize();
    const records = await this.readActiveRecords();
    const sessionDigest = digest(sessionKey);
    const limit = Math.min(20, Math.max(1, options.limit ?? DEFAULT_LIST_LIMIT));
    const sessionRecords = records.filter((record) => secureEqual(record.session_digest, sessionDigest));
    const selected = options.messageId ? sessionRecords.filter((record) => record.message_id === options.messageId) : sessionRecords;
    return {
      attachments: recentAttachmentsInChronologicalOrder(selected, limit),
      has_more: selected.length > limit
    };
  }
  async cleanupExpired() {
    await this.initialize();
    await this.readActiveRecords();
  }
  async resolve(attachmentId) {
    await this.initialize();
    assertAttachmentId(attachmentId);
    try {
      const record = parseRecord(await readFile(this.recordPath(attachmentId), "utf8"));
      if (!secureEqual(record.attachment_id, attachmentId)) throw new Error("attachment id mismatch");
      if (Date.parse(record.expires_at) <= Date.now()) throw new Error("attachment reference expired");
      return record;
    } catch {
      throw new PluginError("OPENCLAW_ATTACHMENT_NOT_FOUND", "OpenClaw \u9644\u4EF6\u5F15\u7528\u4E0D\u5B58\u5728\u6216\u5DF2\u8FC7\u671F\u3002", {
        field: "attachment_id",
        suggested_action: "\u8BF7\u91CD\u65B0\u53D1\u9001\u6216\u91CD\u65B0\u5F15\u7528\u9644\u4EF6\u3002"
      });
    }
  }
  async resolveForSession(attachmentId, sessionKey) {
    const record = await this.resolve(attachmentId);
    if (!secureEqual(record.session_digest, digest(sessionKey))) {
      throw new PluginError("OPENCLAW_ATTACHMENT_NOT_FOUND", "OpenClaw \u9644\u4EF6\u5F15\u7528\u4E0D\u5B58\u5728\u6216\u5DF2\u8FC7\u671F\u3002", {
        field: "attachment_id",
        suggested_action: "\u8BF7\u91CD\u65B0\u53D1\u9001\u6216\u91CD\u65B0\u5F15\u7528\u9644\u4EF6\u3002"
      });
    }
    return record;
  }
  async deleteSession(sessionKey) {
    await this.initialize();
    const sessionDigest = digest(sessionKey);
    const entries = await readdir(this.recordsDirectory, { withFileTypes: true });
    await Promise.all(entries.filter((entry) => entry.isFile()).map(async (entry) => {
      const filePath = path.join(this.recordsDirectory, entry.name);
      try {
        const record = parseRecord(await readFile(filePath, "utf8"));
        if (secureEqual(record.session_digest, sessionDigest)) await rm(filePath, { force: true });
      } catch {
        await rm(filePath, { force: true });
      }
    }));
  }
  async initializeOnce() {
    await ensurePrivateDirectory(this.recordsDirectory);
    const records = await this.readActiveRecords();
    this.lastRegistrationTimeMs = records.reduce(
      (latest, record) => Math.max(latest, Date.parse(record.received_at)),
      0
    );
  }
  async readActiveRecords() {
    const entries = await readdir(this.recordsDirectory, { withFileTypes: true });
    const records = [];
    await Promise.all(entries.filter((entry) => entry.isFile()).map(async (entry) => {
      const filePath = path.join(this.recordsDirectory, entry.name);
      try {
        const record = parseRecord(await readFile(filePath, "utf8"));
        if (Date.parse(record.expires_at) <= Date.now()) {
          await rm(filePath, { force: true });
          return;
        }
        records.push(record);
      } catch {
        await rm(filePath, { force: true });
      }
    }));
    return records;
  }
  recordPath(attachmentId) {
    return path.join(this.recordsDirectory, `${digest(attachmentId)}.json`);
  }
};
function createAttachmentId() {
  return `qio_${randomBytes(32).toString("base64url")}`;
}
function assertAttachmentId(value) {
  if (!ATTACHMENT_ID_PATTERN.test(value)) {
    throw new PluginError("INVALID_OPENCLAW_ATTACHMENT_ID", "OpenClaw \u9644\u4EF6\u5F15\u7528\u683C\u5F0F\u65E0\u6548\u3002", {
      field: "attachment_id"
    });
  }
}
function isSupportedSourceReference(value) {
  return path.isAbsolute(value) || /^media:\/\/inbound\/[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/.test(value);
}
function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}
function secureEqual(left, right) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}
function parseRecord(value) {
  const record = JSON.parse(value);
  if (typeof record.attachment_id !== "string" || !ATTACHMENT_ID_PATTERN.test(record.attachment_id) || typeof record.session_digest !== "string" || !/^[0-9a-f]{64}$/.test(record.session_digest) || typeof record.source_reference !== "string" || !isSupportedSourceReference(record.source_reference) || !Number.isInteger(record.position) || (record.position ?? 0) < 1 || !["image", "video", "audio", "unknown"].includes(record.kind ?? "") || typeof record.received_at !== "string" || !Number.isFinite(Date.parse(record.received_at)) || typeof record.expires_at !== "string" || !Number.isFinite(Date.parse(record.expires_at))) {
    throw new Error("invalid OpenClaw attachment record");
  }
  return record;
}
function recentAttachmentsInChronologicalOrder(records, limit) {
  return records.sort((left, right) => right.received_at.localeCompare(left.received_at) || right.position - left.position).slice(0, limit).sort((left, right) => left.received_at.localeCompare(right.received_at) || left.position - right.position);
}
async function writePrivateJson(filePath, value) {
  const file = await open(filePath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 384);
  try {
    await file.writeFile(`${JSON.stringify(value)}
`, "utf8");
    await file.sync();
  } finally {
    await file.close();
  }
}
async function ensurePrivateDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 448 });
  const details = await lstat(directory);
  if (!details.isDirectory() || details.isSymbolicLink()) {
    throw new PluginError("INSECURE_STATE_DIRECTORY", "\u672C\u5730\u9644\u4EF6\u5904\u7406\u72B6\u6001\u76EE\u5F55\u4E0D\u5B89\u5168\u3002", {
      suggested_action: "\u5C06 QUICK_IMAGE_DATA_DIR \u6307\u5411\u4EC5\u5F53\u524D\u7528\u6237\u53EF\u8BBF\u95EE\u7684\u771F\u5B9E\u76EE\u5F55\u3002"
    });
  }
  if ((details.mode & 63) !== 0) await chmod(directory, 448);
}

// src/openclaw-adapter/local-tools.ts
import { z } from "zod";
import * as z4 from "zod/v4";
import {
  directUploadSchema,
  estimateGenerationCredits,
  lookbookEstimateInputSchema,
  PluginError as PluginError2,
  poseEstimateInputSchema,
  toPluginError,
  upscaleEstimateInputSchema,
  videoEstimateInputSchema
} from "quick-image-agent-runtime";
var OPENCLAW_LOCAL_TOOL_NAMES = [
  "quick_image_inspect_attachment",
  "quick_image_prepare_attachment",
  "quick_image_estimate_lookbook_credits",
  "quick_image_estimate_pose_credits",
  "quick_image_estimate_upscale_credits",
  "quick_image_estimate_video_credits",
  "quick_image_upload_staged_attachment"
];
var inspectInputSchema = z.object({
  attachment_id: z.string().regex(/^qio_[A-Za-z0-9_-]{43}$/)
}).strict();
var prepareInputSchema = z.object({
  attachment_handle: z.string().regex(/^qia_[A-Za-z0-9_-]{43}$/)
}).strict();
var uploadInputSchema = z.object({
  staged_handle: z.string().regex(/^qis_[A-Za-z0-9_-]{43}$/),
  direct_upload: directUploadSchema
}).strict();
var readOnlyAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false
};
function createOpenClawLocalTools(registry, pipelineProvider, context) {
  return [
    createInspectTool(registry, pipelineProvider, context),
    createPrepareTool(pipelineProvider, context),
    createLookbookEstimateTool(),
    createPoseEstimateTool(),
    createUpscaleEstimateTool(),
    createVideoEstimateTool(),
    createUploadTool(pipelineProvider, context)
  ];
}
function createInspectTool(registry, pipelineProvider, context) {
  return {
    name: "quick_image_inspect_attachment",
    label: "\u68C0\u67E5 Quick Image \u9644\u4EF6",
    description: "\u68C0\u67E5\u5F53\u524D OpenClaw \u4F1A\u8BDD\u4E2D\u7684\u9644\u4EF6\u5E76\u8FD4\u56DE\u4E0D\u5305\u542B\u672C\u5730\u8DEF\u5F84\u6216\u9644\u4EF6\u5B57\u8282\u7684\u4E00\u6B21\u6027\u53E5\u67C4\u3002\u6B64\u6B65\u9AA4\u4E0D\u5904\u7406\u3001\u4E0D\u6682\u5B58\u3001\u4E0D\u4E0A\u4F20\u9644\u4EF6\u3002",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        attachment_id: {
          type: "string",
          pattern: "^qio_[A-Za-z0-9_-]{43}$",
          description: "quick_image_list_attachments \u8FD4\u56DE\u7684\u5F53\u524D\u4F1A\u8BDD\u9644\u4EF6 ID\u3002"
        }
      },
      required: ["attachment_id"]
    },
    annotations: readOnlyAnnotations,
    async execute(_toolCallId, rawParameters) {
      return executeLocalTool(async () => {
        const parameters = inspectInputSchema.parse(rawParameters);
        const sessionKey = requireSessionKey(context);
        const attachment = await registry.resolveForSession(parameters.attachment_id, sessionKey);
        return (await pipelineProvider()).inspect(attachment.source_reference, sessionKey);
      });
    }
  };
}
function createPrepareTool(pipelineProvider, context) {
  return {
    name: "quick_image_prepare_attachment",
    label: "\u51C6\u5907 Quick Image \u9644\u4EF6",
    description: "\u7528\u6237\u786E\u8BA4\u62A5\u4EF7\u540E\u91CD\u65B0\u6821\u9A8C\u5F53\u524D\u4F1A\u8BDD\u9644\u4EF6\u5E76\u5904\u7406\u5A92\u4F53\uFF0C\u8FD4\u56DE\u4E00\u6B21\u6027\u6682\u5B58\u53E5\u67C4\u548C\u53EF\u539F\u6837\u4F20\u7ED9 create_direct_upload \u7684\u53C2\u6570\u3002",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        attachment_handle: {
          type: "string",
          pattern: "^qia_[A-Za-z0-9_-]{43}$",
          description: "quick_image_inspect_attachment \u8FD4\u56DE\u7684\u4E00\u6B21\u6027\u68C0\u67E5\u53E5\u67C4\u3002"
        }
      },
      required: ["attachment_handle"]
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false
    },
    async execute(_toolCallId, rawParameters) {
      return executeLocalTool(async () => {
        const parameters = prepareInputSchema.parse(rawParameters);
        const sessionKey = requireSessionKey(context);
        return (await pipelineProvider()).prepare(parameters.attachment_handle, sessionKey);
      });
    }
  };
}
function createUploadTool(pipelineProvider, context) {
  return {
    name: "quick_image_upload_staged_attachment",
    label: "\u4E0A\u4F20 Quick Image \u6682\u5B58\u9644\u4EF6",
    description: "\u4F7F\u7528\u8FDC\u7A0B Quick Image MCP \u7B7E\u53D1\u7684\u5B8C\u6574\u76F4\u4F20\u4FE1\u606F\u4E0A\u4F20\u5F53\u524D\u4F1A\u8BDD\u4E2D\u5B8C\u5168\u76F8\u540C\u7684\u6682\u5B58\u6587\u4EF6\uFF0C\u6210\u529F\u540E\u6D88\u8D39\u53E5\u67C4\u3002",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        staged_handle: {
          type: "string",
          pattern: "^qis_[A-Za-z0-9_-]{43}$"
        },
        direct_upload: {
          type: "object",
          additionalProperties: false,
          properties: {
            asset_id: { type: "string", minLength: 1, maxLength: 200 },
            upload_url: { type: "string", format: "uri", maxLength: 8192 },
            headers: { type: "object", additionalProperties: { type: "string" } },
            expires_at: { type: "string", format: "date-time" }
          },
          required: ["asset_id", "upload_url", "headers", "expires_at"]
        }
      },
      required: ["staged_handle", "direct_upload"]
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true
    },
    async execute(_toolCallId, rawParameters) {
      return executeLocalTool(async () => {
        const parameters = uploadInputSchema.parse(rawParameters);
        const sessionKey = requireSessionKey(context);
        return (await pipelineProvider()).upload(parameters.staged_handle, parameters.direct_upload, sessionKey);
      });
    }
  };
}
function createLookbookEstimateTool() {
  return estimateTool(
    "quick_image_estimate_lookbook_credits",
    "\u9884\u4F30 Quick Image \u642D\u914D\u79EF\u5206",
    "\u4F7F\u7528\u642D\u914D\u6A21\u578B\u4EF7\u683C\u3001\u53EF\u9009\u6A21\u677F\u4EF7\u683C\u548C\u8F93\u51FA\u6570\u91CF\u786E\u5B9A\u6027\u8BA1\u7B97\u9884\u8BA1\u79EF\u5206\u4E0E\u989D\u5916\u786E\u8BA4\u539F\u56E0\u3002",
    lookbookEstimateInputSchema,
    (parameters) => estimateGenerationCredits({
      ...parameters,
      measurements: { output_count: parameters.output_count }
    })
  );
}
function createPoseEstimateTool() {
  return estimateTool(
    "quick_image_estimate_pose_credits",
    "\u9884\u4F30 Quick Image \u6362\u59FF\u79EF\u5206",
    "\u4F7F\u7528\u6362\u59FF\u6A21\u578B\u4EF7\u683C\u3001\u53EF\u9009\u6A21\u677F\u4EF7\u683C\u3001\u4EBA\u7269\u6570\u548C\u5355\u4EBA\u8F93\u51FA\u6570\u786E\u5B9A\u6027\u8BA1\u7B97\u9884\u8BA1\u79EF\u5206\u4E0E\u989D\u5916\u786E\u8BA4\u539F\u56E0\u3002",
    poseEstimateInputSchema,
    (parameters) => estimateGenerationCredits({
      ...parameters,
      measurements: {
        person_count: parameters.person_count,
        output_count_per_person: parameters.output_count_per_person
      }
    })
  );
}
function createUpscaleEstimateTool() {
  return estimateTool(
    "quick_image_estimate_upscale_credits",
    "\u9884\u4F30 Quick Image \u9AD8\u6E05\u79EF\u5206",
    "\u4F7F\u7528\u9AD8\u6E05\u4EF7\u683C\u548C\u8F93\u5165\u56FE\u7247\u6570\u91CF\u786E\u5B9A\u6027\u8BA1\u7B97\u9884\u8BA1\u79EF\u5206\u4E0E\u989D\u5916\u786E\u8BA4\u539F\u56E0\u3002",
    upscaleEstimateInputSchema,
    (parameters) => estimateGenerationCredits({
      ...parameters,
      measurements: { input_count: parameters.input_count }
    })
  );
}
function createVideoEstimateTool() {
  return estimateTool(
    "quick_image_estimate_video_credits",
    "\u9884\u4F30 Quick Image \u89C6\u9891\u79EF\u5206",
    "\u4F7F\u7528\u89C6\u9891\u4EF7\u683C\u3001\u8F93\u51FA\u65F6\u957F\u548C\u53EF\u9009\u8F93\u5165\u89C6\u9891\u65F6\u957F\u786E\u5B9A\u6027\u8BA1\u7B97\u9884\u8BA1\u79EF\u5206\u4E0E\u989D\u5916\u786E\u8BA4\u539F\u56E0\u3002",
    videoEstimateInputSchema,
    (parameters) => estimateGenerationCredits({
      ...parameters,
      measurements: {
        output_duration_seconds: parameters.output_duration_seconds,
        ...parameters.input_video_duration_seconds === null ? {} : { input_video_duration_seconds: parameters.input_video_duration_seconds }
      }
    })
  );
}
function estimateTool(name, label, description, schema, estimate) {
  return {
    name,
    label,
    description,
    parameters: toOpenClawParameters(schema),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    },
    async execute(_toolCallId, rawParameters) {
      return executeLocalTool(() => estimate(schema.parse(rawParameters)));
    }
  };
}
function toOpenClawParameters(schema) {
  const jsonSchema = z4.toJSONSchema(schema);
  const { $schema: _schema, ...parameters } = jsonSchema;
  return parameters;
}
function requireSessionKey(context) {
  if (!context.sessionKey) {
    throw new PluginError2("OPENCLAW_SESSION_UNAVAILABLE", "\u5F53\u524D OpenClaw \u4F1A\u8BDD\u6CA1\u6709\u53EF\u7528\u7684\u9644\u4EF6\u4E0A\u4E0B\u6587\u3002", {
      suggested_action: "\u8BF7\u5728\u539F\u9644\u4EF6\u6240\u5728\u4F1A\u8BDD\u4E2D\u91CD\u8BD5\u3002"
    });
  }
  return context.sessionKey;
}
async function executeLocalTool(action) {
  try {
    const value = await action();
    return { content: [{ type: "text", text: JSON.stringify(value) }] };
  } catch (error) {
    const publicError = toPluginError(error).toPublicObject();
    return {
      content: [{ type: "text", text: JSON.stringify(publicError) }],
      isError: true
    };
  }
}

// src/openclaw-adapter/environment-cli.ts
import path3 from "path";
import { spawnSync as spawnSync2 } from "child_process";
import { fileURLToPath } from "url";

// src/environment/command-executor.ts
import { spawnSync } from "child_process";
var systemCommandExecutor = {
  run(executable, args) {
    const result = spawnSync(executable, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    });
    if (result.error) throw new Error(`\u65E0\u6CD5\u8FD0\u884C ${executable}\uFF1A${result.error.message}`);
    if (result.status !== 0) {
      const details = (result.stderr || result.stdout).trim();
      throw new Error(`${executable} ${args.join(" ")} \u6267\u884C\u5931\u8D25${details ? `\uFF1A${details}` : ""}`);
    }
    return { stdout: result.stdout, stderr: result.stderr };
  }
};

// src/environment/config.ts
var QUICK_IMAGE_MCP_NAME = "quick-image";
var QUICK_IMAGE_PRODUCTION_SERVER_URL = "https://quickimage.ai/mcp";
var QUICK_IMAGE_PRODUCTION_FRONTEND_URL = "https://quickimage.ai";
var QUICK_IMAGE_FRONTEND_HEADER = "X-Quick-Image-Frontend-URL";
var QUICK_IMAGE_VERSION_HEADER = "X-Quick-Image-Plugin-Version";
var QUICK_IMAGE_OAUTH_SCOPE = "presets:read assets:write tasks:read tasks:write";
function productionEnvironmentUrls() {
  return {
    serverUrl: QUICK_IMAGE_PRODUCTION_SERVER_URL,
    frontendUrl: QUICK_IMAGE_PRODUCTION_FRONTEND_URL
  };
}
function buildOpenClawMcpConfig(urls, pluginVersion) {
  return {
    transport: "streamable-http",
    url: urls.serverUrl,
    auth: "oauth",
    oauth: { scope: QUICK_IMAGE_OAUTH_SCOPE },
    headers: {
      [QUICK_IMAGE_VERSION_HEADER]: pluginVersion,
      [QUICK_IMAGE_FRONTEND_HEADER]: urls.frontendUrl
    }
  };
}

// src/environment/executables.ts
import { accessSync, constants } from "fs";
import os from "os";
import path2 from "path";
function resolveOpenClawExecutable(explicitPath) {
  const configured = explicitPath?.trim() || process.env.OPENCLAW_CLI_PATH?.trim();
  if (configured) return requireExecutable(configured, "\u6307\u5B9A\u7684 OpenClaw CLI");
  return findOnPath("openclaw") ?? "openclaw";
}
function findOnPath(command) {
  const extensions = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";") : [""];
  for (const directory of (process.env.PATH ?? "").split(path2.delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = path2.join(directory, `${command}${extension.toLowerCase()}`);
      if (isExecutable(candidate)) return candidate;
    }
  }
  return void 0;
}
function requireExecutable(filePath, label) {
  const resolved = path2.resolve(filePath);
  if (!isExecutable(resolved)) throw new Error(`${label}\u4E0D\u5B58\u5728\u6216\u4E0D\u53EF\u6267\u884C\uFF1A${resolved}`);
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

// src/environment/openclaw-setup.ts
var OPENCLAW_PLUGIN_ID = "quick-image";
var MANUAL_LOGIN_COMMAND = "openclaw mcp login quick-image";
async function setupOpenClaw(options) {
  const openClawBin = resolveOpenClawExecutable(options.openClawBin);
  const executor = options.executor ?? systemCommandExecutor;
  const toolAccessChanged = ensureToolAccess(openClawBin, executor);
  configureProductionMcp({
    openClawBin,
    executor,
    pluginVersion: options.pluginVersion
  });
  executor.run(openClawBin, ["mcp", "reload"]);
  return { toolAccessChanged };
}
function formatOpenClawSetupResult(result) {
  const toolAccess = result.toolAccessChanged ? "\u5DF2\u5C06 quick-image \u52A0\u5165 tools.alsoAllow\uFF0C\u5E76\u4FDD\u7559\u539F\u6709\u6761\u76EE\u3002" : "tools.alsoAllow \u5DF2\u5305\u542B quick-image\u3002";
  return [
    "Quick Image OpenClaw \u914D\u7F6E\u5B8C\u6210\u3002",
    toolAccess,
    "\u5DF2\u8BBE\u7F6E Quick Image \u6B63\u5F0F\u73AF\u5883 MCP\u3002",
    "\u5DF2\u91CD\u65B0\u52A0\u8F7D MCP \u914D\u7F6E\u3002",
    "\u8BF7\u8FD0\u884C\u4EE5\u4E0B\u547D\u4EE4\u767B\u5F55 Quick Image MCP\uFF1A",
    MANUAL_LOGIN_COMMAND
  ].join("\n") + "\n";
}
function ensureToolAccess(openClawBin, executor) {
  const tools = readOptionalConfigObject(openClawBin, executor, "tools") ?? {};
  const current = readStringArray(tools.alsoAllow, "tools.alsoAllow");
  const merged = [.../* @__PURE__ */ new Set([...current, OPENCLAW_PLUGIN_ID])];
  if (arraysEqual(current, merged)) return false;
  executor.run(openClawBin, [
    "config",
    "set",
    "tools.alsoAllow",
    JSON.stringify(merged),
    "--strict-json"
  ]);
  return true;
}
function configureProductionMcp(options) {
  const config = buildOpenClawMcpConfig(productionEnvironmentUrls(), options.pluginVersion);
  options.executor.run(options.openClawBin, [
    "mcp",
    "set",
    QUICK_IMAGE_MCP_NAME,
    JSON.stringify(config)
  ]);
}
function readOptionalConfigObject(openClawBin, executor, path5) {
  let output;
  try {
    output = executor.run(openClawBin, ["config", "get", path5, "--json"]).stdout;
  } catch (error) {
    if (errorMessage(error).includes("Config path not found:")) return void 0;
    throw error;
  }
  let value;
  try {
    value = JSON.parse(output);
  } catch {
    throw new Error(`OpenClaw ${path5} \u914D\u7F6E\u4E0D\u662F\u6709\u6548 JSON`);
  }
  if (!isObject(value)) throw new Error(`OpenClaw ${path5} \u914D\u7F6E\u5FC5\u987B\u662F\u5BF9\u8C61`);
  return value;
}
function readStringArray(value, field) {
  if (value === void 0) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length === 0)) {
    throw new Error(`OpenClaw ${field} \u914D\u7F6E\u5FC5\u987B\u662F\u975E\u7A7A\u5B57\u7B26\u4E32\u6570\u7EC4`);
  }
  return value;
}
function arraysEqual(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// src/openclaw-adapter/environment-cli.ts
function registerOpenClawCli(api) {
  api.registerCli(({ program }) => {
    const root = program.command("quick-image").description("\u7BA1\u7406 Quick Image \u63D2\u4EF6\u914D\u7F6E");
    root.command("setup").description("\u914D\u7F6E\u5DE5\u5177\u6743\u9650\u548C\u6B63\u5F0F\u73AF\u5883 MCP").action(() => runOpenClawSetup(api));
    const env = root.command("env").description("\u7BA1\u7406 Quick Image \u73AF\u5883");
    for (const action of ["set", "status", "reset"]) {
      const command = env.command(action).description(`\u5207\u6362 Quick Image \u73AF\u5883\uFF08${action}\uFF09`);
      command.option?.("--server-url <url>", "MCP Server URL").option?.("--frontend-url <url>", "Frontend URL");
      command.action((options) => runRuntimeEnvironment(api, action, options));
    }
  }, {
    descriptors: [{
      name: "quick-image",
      description: "\u7BA1\u7406 Quick Image \u63D2\u4EF6\u914D\u7F6E",
      hasSubcommands: true
    }]
  });
}
async function runRuntimeEnvironment(api, action, options) {
  if (!api.version) throw new Error("OpenClaw \u672A\u63D0\u4F9B Quick Image \u63D2\u4EF6\u7248\u672C");
  const runtimeEntry = fileURLToPath(import.meta.resolve("quick-image-agent-runtime"));
  const executable = path3.join(path3.dirname(runtimeEntry), "cli", "quick-image.js");
  const args = [executable, "env", action, "--host", "openclaw"];
  if (options.serverUrl) args.push("--server-url", options.serverUrl);
  if (options.frontendUrl) args.push("--frontend-url", options.frontendUrl);
  const result = spawnSync2(process.execPath, args, { encoding: "utf8", stdio: "inherit" });
  if (result.error) throw new Error(`\u65E0\u6CD5\u542F\u52A8 quick-image-agent-runtime\uFF1A${result.error.message}`);
  if (result.status !== 0) throw new Error(`quick-image-agent-runtime env ${action} \u6267\u884C\u5931\u8D25`);
}
async function runOpenClawSetup(api) {
  if (!api.version) throw new Error("OpenClaw \u672A\u63D0\u4F9B Quick Image \u63D2\u4EF6\u7248\u672C");
  const result = await setupOpenClaw({ pluginVersion: api.version });
  process.stdout.write(formatOpenClawSetupResult(result));
}

// src/openclaw-adapter/index.ts
var PREVIEW_TOOL_NAME = "quick_image_send_preview";
var LIST_ATTACHMENTS_TOOL_NAME = "quick_image_list_attachments";
function createPreviewTool(api, context) {
  return {
    name: PREVIEW_TOOL_NAME,
    label: "\u53D1\u9001 Quick Image \u9884\u89C8",
    description: "\u5C06 Quick Image \u6210\u529F\u4EFB\u52A1\u7684\u9884\u89C8\u5A92\u4F53\u53D1\u9001\u5230\u5F53\u524D OpenClaw \u4F1A\u8BDD\uFF0C\u5E76\u9644\u4E0A\u539F\u6587\u4EF6\u4E0B\u8F7D\u94FE\u63A5\u3002",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        display_url: {
          type: "string",
          maxLength: 8192,
          description: "Quick Image \u4EFB\u52A1\u7ED3\u679C\u8FD4\u56DE\u7684 display_url\u3002"
        },
        download_url: {
          type: "string",
          maxLength: 8192,
          description: "\u540C\u4E00\u4EFB\u52A1\u7ED3\u679C\u8FD4\u56DE\u7684\u539F\u6587\u4EF6 url\u3002"
        },
        media_kind: {
          type: "string",
          enum: ["image", "video"],
          description: "\u7ED3\u679C\u5A92\u4F53\u7C7B\u578B\u3002"
        }
      },
      required: ["display_url", "download_url", "media_kind"]
    },
    async execute(_toolCallId, rawParameters) {
      const parameters = parsePreviewParameters(rawParameters);
      const route = context.deliveryContext;
      if (!route?.channel || !route.to) {
        throw new Error("\u5F53\u524D OpenClaw \u4F1A\u8BDD\u6CA1\u6709\u53EF\u7528\u7684\u6D88\u606F\u6295\u9012\u76EE\u6807\u3002");
      }
      const adapter = await api.runtime.channel.outbound.loadAdapter(route.channel);
      if (!adapter) throw new Error(`\u5F53\u524D\u6D88\u606F\u6E20\u9053\u4E0D\u652F\u6301\u539F\u751F\u5A92\u4F53\u6295\u9012\uFF1A${route.channel}`);
      const cfg = context.getRuntimeConfig?.() ?? context.runtimeConfig ?? context.config ?? api.config;
      const text = parameters.media_kind === "video" ? `Quick Image \u89C6\u9891\u751F\u6210\u5B8C\u6210
\u4E0B\u8F7D\u539F\u89C6\u9891\uFF1A${parameters.download_url}` : `Quick Image \u56FE\u7247\u751F\u6210\u5B8C\u6210
\u4E0B\u8F7D\u539F\u56FE\uFF1A${parameters.download_url}`;
      const outboundContext = {
        cfg,
        to: route.to,
        text,
        mediaUrl: parameters.display_url,
        ...route.accountId ? { accountId: route.accountId } : {},
        ...route.threadId !== void 0 ? { threadId: route.threadId } : {}
      };
      const result = adapter.sendMedia ? await adapter.sendMedia(outboundContext) : adapter.sendPayload ? await adapter.sendPayload({
        ...outboundContext,
        payload: { text, mediaUrl: parameters.display_url }
      }) : void 0;
      if (!result) throw new Error(`\u5F53\u524D\u6D88\u606F\u6E20\u9053\u4E0D\u652F\u6301\u539F\u751F\u5A92\u4F53\u6295\u9012\uFF1A${route.channel}`);
      return {
        content: [{
          type: "text",
          text: JSON.stringify({ sent: true, channel: result.channel, message_id: result.messageId })
        }]
      };
    }
  };
}
function createListAttachmentsTool(registry, pendingRegistrations, context) {
  return {
    name: LIST_ATTACHMENTS_TOOL_NAME,
    label: "\u5217\u51FA Quick Image \u9644\u4EF6",
    description: "\u5217\u51FA\u5F53\u524D OpenClaw \u4F1A\u8BDD\u6700\u8FD1\u7684\u9644\u4EF6\u5019\u9009\uFF0C\u9ED8\u8BA4\u8FD4\u56DE\u6700\u8FD1 10 \u4E2A\u5E76\u6309\u4E0A\u4F20\u65F6\u95F4\u4ECE\u65E7\u5230\u65B0\u6392\u5217\u3002",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        message_id: {
          type: "string",
          maxLength: 512,
          description: "\u53EF\u9009\uFF1B\u4EC5\u5728\u9700\u8981\u9650\u5B9A\u67D0\u6761\u5386\u53F2\u6D88\u606F\u65F6\u4F20\u5165\uFF0C\u4E0D\u7B5B\u9009\u65F6\u7701\u7565\u8BE5\u5B57\u6BB5\u3002"
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 20,
          description: "\u6700\u591A\u8FD4\u56DE\u7684\u9644\u4EF6\u6570\u91CF\uFF0C\u9ED8\u8BA4 10\u3002"
        }
      }
    },
    async execute(_toolCallId, rawParameters) {
      const parameters = parseListParameters(rawParameters);
      if (!context.sessionKey) throw new Error("\u5F53\u524D OpenClaw \u4F1A\u8BDD\u6CA1\u6709\u53EF\u7528\u7684\u9644\u4EF6\u4E0A\u4E0B\u6587\u3002");
      await pendingRegistrations.get(context.sessionKey);
      const result = await registry.listCandidates(context.sessionKey, {
        ...parameters.message_id ? { messageId: parameters.message_id } : {},
        ...parameters.limit ? { limit: parameters.limit } : {}
      });
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            attachments: result.attachments.map((attachment) => ({
              attachment_id: attachment.attachment_id,
              kind: attachment.kind,
              media_type: attachment.media_type ?? null,
              message_id: attachment.message_id ?? null,
              position: attachment.position,
              received_at: attachment.received_at,
              expires_at: attachment.expires_at
            })),
            has_more: result.has_more
          })
        }]
      };
    }
  };
}
function enqueuePendingRegistration(pendingRegistrations, sessionKey, register) {
  const previous = pendingRegistrations.get(sessionKey);
  const queued = (previous ?? Promise.resolve()).catch(() => void 0).then(register);
  pendingRegistrations.set(sessionKey, queued);
  const cleanup = () => {
    if (pendingRegistrations.get(sessionKey) === queued) pendingRegistrations.delete(sessionKey);
  };
  void queued.then(cleanup, cleanup);
  return queued;
}
function parsePreviewParameters(value) {
  if (!isObject2(value)) throw new Error("\u9884\u89C8\u53C2\u6570\u65E0\u6548\u3002");
  const displayUrl = parseHttpsUrl(value.display_url, "display_url");
  const downloadUrl = parseHttpsUrl(value.download_url, "download_url");
  if (value.media_kind !== "image" && value.media_kind !== "video") {
    throw new Error("media_kind \u5FC5\u987B\u662F image \u6216 video\u3002");
  }
  return { display_url: displayUrl, download_url: downloadUrl, media_kind: value.media_kind };
}
function parseListParameters(value) {
  if (value === void 0 || value === null) return {};
  if (!isObject2(value)) throw new Error("\u9644\u4EF6\u67E5\u8BE2\u53C2\u6570\u65E0\u6548\u3002");
  const result = {};
  if (value.message_id !== void 0) {
    if (typeof value.message_id !== "string" || value.message_id.length > 512) {
      throw new Error("message_id \u65E0\u6548\u3002");
    }
    if (value.message_id.trim() !== "") result.message_id = value.message_id;
  }
  if (value.limit !== void 0) {
    if (!Number.isInteger(value.limit) || value.limit < 1 || value.limit > 20) {
      throw new Error("limit \u5FC5\u987B\u662F 1 \u5230 20 \u7684\u6574\u6570\u3002");
    }
    result.limit = value.limit;
  }
  return result;
}
function extractInboundAttachments(metadata) {
  const paths = stringArray(metadata?.mediaPaths);
  if (paths.length === 0 && typeof metadata?.mediaPath === "string") paths.push(metadata.mediaPath);
  const types = stringArray(metadata?.mediaTypes);
  if (types.length === 0 && typeof metadata?.mediaType === "string") types.push(metadata.mediaType);
  return paths.map((sourceReference, index) => ({
    source_reference: sourceReference,
    kind: mediaKind(types[index]),
    ...types[index] ? { media_type: types[index] } : {},
    position: index + 1
  }));
}
function stringArray(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string" && item.length > 0) : [];
}
function mediaKind(mediaType) {
  const normalized = mediaType?.toLowerCase() ?? "";
  if (normalized.startsWith("image/")) return "image";
  if (normalized.startsWith("video/")) return "video";
  if (normalized.startsWith("audio/")) return "audio";
  return "unknown";
}
function parseHttpsUrl(value, field) {
  if (typeof value !== "string" || value.length === 0 || value.length > 8192) {
    throw new Error(`${field} \u5FC5\u987B\u662F\u6709\u6548\u7684 HTTPS URL\u3002`);
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${field} \u5FC5\u987B\u662F\u6709\u6548\u7684 HTTPS URL\u3002`);
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error(`${field} \u5FC5\u987B\u662F\u6709\u6548\u7684 HTTPS URL\u3002`);
  }
  return url.toString();
}
function isObject2(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
var plugin = {
  id: "quick-image",
  name: "Quick Image",
  description: "\u5B89\u5168\u5904\u7406\u5F53\u524D OpenClaw \u4F1A\u8BDD\u9644\u4EF6\uFF0C\u5E76\u5C06\u751F\u6210\u7ED3\u679C\u53D1\u9001\u5230\u53EF\u4FE1\u6D88\u606F\u8DEF\u7531\u3002",
  register(api) {
    registerOpenClawCli(api);
    const stateDirectory = resolveOpenClawAttachmentRegistryDirectory();
    const registry = new OpenClawAttachmentRegistry(stateDirectory);
    let pipelinePromise;
    const getPipeline = () => {
      pipelinePromise ??= Promise.resolve().then(async () => {
        assertSupportedRuntime();
        return AttachmentPipeline.create(path4.join(stateDirectory, "openclaw-attachment-pipeline"));
      });
      return pipelinePromise;
    };
    const pendingRegistrations = /* @__PURE__ */ new Map();
    api.on("message_received", (event, context) => {
      const sessionKey = event.sessionKey ?? context.sessionKey;
      const attachments = extractInboundAttachments(event.metadata);
      if (!sessionKey || attachments.length === 0) return;
      const runId = event.runId ?? context.runId;
      const messageId = event.messageId ?? context.messageId;
      const registration = enqueuePendingRegistration(pendingRegistrations, sessionKey, () => registry.register({
        sessionKey,
        ...runId ? { runId } : {},
        ...messageId ? { messageId } : {},
        attachments
      }));
      return registration;
    });
    api.registerTool((context) => createListAttachmentsTool(registry, pendingRegistrations, context), {
      name: LIST_ATTACHMENTS_TOOL_NAME
    });
    for (const [index, toolName] of OPENCLAW_LOCAL_TOOL_NAMES.entries()) {
      api.registerTool((context) => {
        const tool = createOpenClawLocalTools(registry, getPipeline, context)[index];
        if (!tool) throw new Error(`\u65E0\u6CD5\u6CE8\u518C Quick Image \u539F\u751F\u5DE5\u5177\uFF1A${toolName}`);
        return tool;
      }, { name: toolName });
    }
    api.registerTool((context) => createPreviewTool(api, context), { name: PREVIEW_TOOL_NAME });
    const cleanupTimer = setInterval(() => {
      const cleanupTasks = [registry.cleanupExpired()];
      if (pipelinePromise) cleanupTasks.push(pipelinePromise.then((pipeline) => pipeline.cleanupExpired()));
      void Promise.all(cleanupTasks).catch(() => {
        process.stderr.write(`${JSON.stringify({ code: "ATTACHMENT_CLEANUP_FAILED" })}
`);
      });
    }, HANDLE_CLEANUP_INTERVAL_MS);
    cleanupTimer.unref();
  }
};
var openclaw_adapter_default = plugin;
export {
  createListAttachmentsTool,
  createPreviewTool,
  openclaw_adapter_default as default,
  enqueuePendingRegistration
};
