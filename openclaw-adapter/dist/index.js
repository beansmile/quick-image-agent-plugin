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

// src/environment/codex.ts
import { lstat as lstat2, mkdir as mkdir2, readFile as readFile2, rename, unlink, writeFile } from "fs/promises";
import os2 from "os";
import path3 from "path";

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
var systemInteractiveCommandExecutor = {
  run(executable, args) {
    const result = spawnSync(executable, args, { stdio: "inherit" });
    if (result.error) throw new Error(`\u65E0\u6CD5\u8FD0\u884C ${executable}\uFF1A${result.error.message}`);
    if (result.status !== 0) {
      throw new Error(`${executable} ${args.join(" ")} \u6267\u884C\u5931\u8D25`);
    }
  }
};

// src/environment/config.ts
var QUICK_IMAGE_MCP_NAME = "quick-image";
var QUICK_IMAGE_PRODUCTION_SERVER_URL = "https://quickimage.ai/mcp";
var QUICK_IMAGE_PRODUCTION_FRONTEND_URL = "https://quickimage.ai";
var QUICK_IMAGE_FRONTEND_HEADER = "X-Quick-Image-Frontend-URL";
var QUICK_IMAGE_VERSION_HEADER = "X-Quick-Image-Plugin-Version";
var QUICK_IMAGE_OAUTH_SCOPE = "presets:read assets:write tasks:read tasks:write";
function normalizeEnvironmentUrls(serverUrl, frontendUrl) {
  return {
    serverUrl: validateServerUrl(serverUrl),
    frontendUrl: validateFrontendUrl(frontendUrl)
  };
}
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
function validateServerUrl(value) {
  if (typeof value !== "string" || value.trim() === "") throw new Error("--server-url \u7F3A\u5C11 URL");
  const url = parseUrl(value, "MCP URL");
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("MCP URL \u4E0D\u5F97\u5305\u542B\u51ED\u636E\u3001\u67E5\u8BE2\u53C2\u6570\u6216\u7247\u6BB5");
  }
  if (url.pathname !== "/mcp") throw new Error("MCP URL \u8DEF\u5F84\u5FC5\u987B\u662F /mcp");
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("MCP URL \u5FC5\u987B\u4F7F\u7528 HTTPS\uFF1B\u4EC5 loopback \u672C\u5730\u8C03\u8BD5\u5141\u8BB8 HTTP");
  }
  return url.toString().replace(/\/$/, "");
}
function validateFrontendUrl(value) {
  if (typeof value !== "string" || value.trim() === "") throw new Error("--frontend-url \u7F3A\u5C11 URL");
  const url = parseUrl(value, "\u524D\u7AEF URL");
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("\u524D\u7AEF URL \u4E0D\u5F97\u5305\u542B\u51ED\u636E\u3001\u67E5\u8BE2\u53C2\u6570\u6216\u7247\u6BB5");
  }
  if (url.pathname !== "/") throw new Error("\u524D\u7AEF URL \u53EA\u80FD\u914D\u7F6E origin\uFF0C\u4E0D\u5F97\u5305\u542B\u8DEF\u5F84");
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("\u524D\u7AEF URL \u5FC5\u987B\u4F7F\u7528 HTTPS\uFF1B\u4EC5 loopback \u672C\u5730\u8C03\u8BD5\u5141\u8BB8 HTTP");
  }
  return url.origin;
}
function parseUrl(value, label) {
  try {
    return new URL(value);
  } catch {
    throw new Error(`${label} \u65E0\u6548`);
  }
}

// src/environment/executables.ts
import { accessSync, constants } from "fs";
import os from "os";
import path2 from "path";
function resolveCodexExecutable(explicitPath) {
  const configured = explicitPath?.trim() || process.env.CODEX_CLI_PATH?.trim();
  if (configured) return requireExecutable(configured, "\u6307\u5B9A\u7684 Codex CLI");
  const pathMatch = findOnPath("codex");
  if (pathMatch) return pathMatch;
  if (process.platform === "darwin") {
    for (const applicationName of ["ChatGPT.app", "Codex.app"]) {
      for (const base of ["/Applications", path2.join(os.homedir(), "Applications")]) {
        const candidate = path2.join(base, applicationName, "Contents", "Resources", "codex");
        if (isExecutable(candidate)) return candidate;
      }
    }
  }
  throw new Error("\u627E\u4E0D\u5230 Codex CLI\uFF1B\u8BF7\u5C06 codex \u52A0\u5165 PATH\uFF0C\u6216\u4F7F\u7528 --codex-bin \u6307\u5B9A\u8DEF\u5F84");
}
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

// src/environment/codex.ts
var MANAGED_BLOCK_BEGIN = "# BEGIN quick-image managed MCP environment";
var MANAGED_BLOCK_END = "# END quick-image managed MCP environment";
var QUICK_IMAGE_TABLE_PATTERN = /^\s*\[\s*mcp_servers\s*\.\s*(?:quick-image|"quick-image"|'quick-image')\s*\]\s*(?:#.*)?$/m;
async function setCodexEnvironment(urls, options) {
  const runtime = codexRuntime(options);
  const source = await readCodexConfig(runtime.configPath);
  const updated = upsertCodexManagedBlock(source, urls, options.pluginVersion);
  await writeCodexConfigAndVerify(runtime, source, updated, urls);
  return readCodexEnvironmentStatus(options);
}
async function resetCodexEnvironment(options) {
  const runtime = codexRuntime(options);
  const source = await readCodexConfig(runtime.configPath);
  const updated = removeCodexManagedBlock(source);
  if (updated !== source) {
    await writeCodexConfigAndVerify(runtime, source, updated);
  }
  const status = await readCodexEnvironmentStatus(options);
  if (status.configured && (status.serverUrl !== QUICK_IMAGE_PRODUCTION_SERVER_URL || status.frontendUrl !== QUICK_IMAGE_PRODUCTION_FRONTEND_URL)) {
    throw new Error("Codex \u5F53\u524D\u4ECD\u7531\u5176\u4ED6\u914D\u7F6E\u63D0\u4F9B\u81EA\u5B9A\u4E49 Quick Image URL\uFF0Cenv reset \u65E0\u6CD5\u5B89\u5168\u8986\u76D6\u8BE5\u914D\u7F6E");
  }
  return status;
}
async function readCodexEnvironmentStatus(options) {
  const runtime = codexRuntime(options);
  const source = await readCodexConfig(runtime.configPath);
  let output;
  try {
    output = runtime.executor.run(runtime.codexBin, ["mcp", "get", QUICK_IMAGE_MCP_NAME, "--json"]).stdout;
  } catch {
    return {
      host: "codex",
      configured: false,
      source: "missing",
      configPath: runtime.configPath
    };
  }
  const raw = JSON.parse(output);
  const config = parseCodexMcpOutput(raw);
  return {
    host: "codex",
    configured: true,
    source: containsManagedBlock(source) ? "custom" : config.serverUrl === QUICK_IMAGE_PRODUCTION_SERVER_URL && config.frontendUrl === QUICK_IMAGE_PRODUCTION_FRONTEND_URL ? "plugin-default" : "external",
    serverUrl: config.serverUrl,
    frontendUrl: config.frontendUrl,
    configPath: runtime.configPath,
    authenticationCommand: "codex mcp login quick-image"
  };
}
function upsertCodexManagedBlock(source, urls, pluginVersion) {
  const range = managedBlockRange(source);
  if (!range && QUICK_IMAGE_TABLE_PATTERN.test(source)) {
    throw new Error("Codex config.toml \u5DF2\u5305\u542B\u975E Quick Image \u7BA1\u7406\u7684 mcp_servers.quick-image \u914D\u7F6E\uFF1B\u8BF7\u5148\u624B\u5DE5\u5904\u7406\u8BE5\u51B2\u7A81");
  }
  const block = renderManagedBlock(urls, pluginVersion);
  if (range) return `${source.slice(0, range.start)}${block}${source.slice(range.end)}`;
  const prefix = source.length === 0 ? "" : `${source.replace(/\s*$/, "")}

`;
  return `${prefix}${block}`;
}
function removeCodexManagedBlock(source) {
  const range = managedBlockRange(source);
  if (!range) return source;
  const separatorLength = source.slice(0, range.start).endsWith("\n\n") ? 1 : 0;
  const before = source.slice(0, range.start - separatorLength);
  const after = source.slice(range.end).replace(/^\n{2,}/, "\n");
  return `${before}${after}`;
}
function containsManagedBlock(source) {
  return managedBlockRange(source) !== void 0;
}
function renderManagedBlock(urls, pluginVersion) {
  return [
    MANAGED_BLOCK_BEGIN,
    `[mcp_servers.${QUICK_IMAGE_MCP_NAME}]`,
    `url = ${tomlString(urls.serverUrl)}`,
    `oauth_resource = ${tomlString(urls.serverUrl)}`,
    'auth = "oauth"',
    `http_headers = { ${tomlString(QUICK_IMAGE_VERSION_HEADER)} = ${tomlString(pluginVersion)}, ${tomlString(QUICK_IMAGE_FRONTEND_HEADER)} = ${tomlString(urls.frontendUrl)} }`,
    MANAGED_BLOCK_END,
    ""
  ].join("\n");
}
function managedBlockRange(source) {
  const begins = markerIndexes(source, MANAGED_BLOCK_BEGIN);
  const ends = markerIndexes(source, MANAGED_BLOCK_END);
  if (begins.length === 0 && ends.length === 0) return void 0;
  if (begins.length !== 1 || ends.length !== 1 || begins[0] === void 0 || ends[0] === void 0) {
    throw new Error("Codex config.toml \u4E2D\u7684 Quick Image \u7BA1\u7406\u533A\u5757\u6807\u8BB0\u4E0D\u5B8C\u6574\u6216\u91CD\u590D");
  }
  if (begins[0] >= ends[0]) throw new Error("Codex config.toml \u4E2D\u7684 Quick Image \u7BA1\u7406\u533A\u5757\u987A\u5E8F\u65E0\u6548");
  const start = lineStart(source, begins[0]);
  const endLine = source.indexOf("\n", ends[0]);
  return { start, end: endLine === -1 ? source.length : endLine + 1 };
}
function markerIndexes(source, marker) {
  const indexes = [];
  let offset = 0;
  while (offset < source.length) {
    const index = source.indexOf(marker, offset);
    if (index === -1) break;
    indexes.push(index);
    offset = index + marker.length;
  }
  return indexes;
}
function lineStart(source, index) {
  const previousNewline = source.lastIndexOf("\n", index - 1);
  return previousNewline === -1 ? 0 : previousNewline + 1;
}
function tomlString(value) {
  return JSON.stringify(value);
}
function codexRuntime(options) {
  return {
    codexBin: resolveCodexExecutable(options.codexBin),
    configPath: options.configPath ?? resolveCodexConfigPath(),
    executor: options.executor ?? systemCommandExecutor
  };
}
function resolveCodexConfigPath() {
  const codexHome = process.env.CODEX_HOME?.trim();
  return path3.join(codexHome ? path3.resolve(codexHome) : path3.join(os2.homedir(), ".codex"), "config.toml");
}
async function readCodexConfig(configPath) {
  try {
    const details = await lstat2(configPath);
    if (details.isSymbolicLink()) throw new Error(`\u62D2\u7EDD\u4FEE\u6539\u7B26\u53F7\u94FE\u63A5\u5F62\u5F0F\u7684 Codex \u914D\u7F6E\uFF1A${configPath}`);
    if (!details.isFile()) throw new Error(`Codex \u914D\u7F6E\u4E0D\u662F\u666E\u901A\u6587\u4EF6\uFF1A${configPath}`);
    return await readFile2(configPath, "utf8");
  } catch (error) {
    if (isFileSystemError(error, "ENOENT")) return "";
    throw error;
  }
}
async function writeCodexConfigAndVerify(runtime, original, updated, expected) {
  await writeAtomic(runtime.configPath, updated);
  try {
    runtime.executor.run(runtime.codexBin, ["mcp", "list", "--json"]);
    if (expected) {
      const output = runtime.executor.run(runtime.codexBin, ["mcp", "get", QUICK_IMAGE_MCP_NAME, "--json"]);
      const actual = parseCodexMcpOutput(JSON.parse(output.stdout));
      if (actual.serverUrl !== expected.serverUrl || actual.frontendUrl !== expected.frontendUrl) {
        throw new Error("Codex \u672A\u52A0\u8F7D\u521A\u5199\u5165\u7684 Quick Image MCP \u914D\u7F6E");
      }
    }
  } catch (error) {
    await restoreCodexConfig(runtime.configPath, original);
    throw error;
  }
}
async function writeAtomic(filePath, content) {
  await mkdir2(path3.dirname(filePath), { recursive: true, mode: 448 });
  const temporaryPath = `${filePath}.quick-image-${process.pid}.tmp`;
  await writeFile(temporaryPath, content, { mode: 384 });
  await rename(temporaryPath, filePath);
}
async function restoreCodexConfig(filePath, original) {
  if (original === "") {
    try {
      await unlink(filePath);
    } catch (error) {
      if (!isFileSystemError(error, "ENOENT")) throw error;
    }
    return;
  }
  await writeAtomic(filePath, original);
}
function parseCodexMcpOutput(value) {
  if (!isObject(value) || !isObject(value.transport)) throw new Error("Codex MCP \u72B6\u6001\u8F93\u51FA\u65E0\u6548");
  const headers = isObject(value.transport.http_headers) ? value.transport.http_headers : {};
  const serverUrl = value.transport.url;
  const frontendUrl = headers[QUICK_IMAGE_FRONTEND_HEADER];
  if (typeof serverUrl !== "string" || typeof frontendUrl !== "string") {
    throw new Error("Codex Quick Image MCP \u7F3A\u5C11 Server URL \u6216 Frontend URL");
  }
  return { serverUrl, frontendUrl };
}
function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isFileSystemError(error, code) {
  return error instanceof Error && "code" in error && error.code === code;
}

// src/environment/openclaw.ts
async function setOpenClawEnvironment(urls, options) {
  const runtime = openClawRuntime(options);
  const config = buildOpenClawMcpConfig(urls, options.pluginVersion);
  runtime.executor.run(runtime.openClawBin, ["mcp", "set", QUICK_IMAGE_MCP_NAME, JSON.stringify(config)]);
  runtime.executor.run(runtime.openClawBin, ["mcp", "reload"]);
  runtime.executor.run(runtime.openClawBin, ["gateway", "restart"]);
  return readOpenClawEnvironmentStatus(options);
}
async function resetOpenClawEnvironment(options) {
  return setOpenClawEnvironment({
    serverUrl: QUICK_IMAGE_PRODUCTION_SERVER_URL,
    frontendUrl: QUICK_IMAGE_PRODUCTION_FRONTEND_URL
  }, options);
}
async function readOpenClawEnvironmentStatus(options) {
  const runtime = openClawRuntime(options);
  let output;
  try {
    output = runtime.executor.run(
      runtime.openClawBin,
      ["config", "get", `mcp.servers.${QUICK_IMAGE_MCP_NAME}`, "--json"]
    ).stdout;
  } catch {
    return { host: "openclaw", configured: false, source: "missing" };
  }
  const raw = JSON.parse(output);
  const urls = parseOpenClawConfig(raw);
  const usesProduction = urls.serverUrl === QUICK_IMAGE_PRODUCTION_SERVER_URL && urls.frontendUrl === QUICK_IMAGE_PRODUCTION_FRONTEND_URL;
  return {
    host: "openclaw",
    configured: true,
    source: usesProduction ? "production-default" : "custom",
    ...urls,
    authenticationCommand: "openclaw mcp login quick-image"
  };
}
function openClawRuntime(options) {
  return {
    openClawBin: resolveOpenClawExecutable(options.openClawBin),
    executor: options.executor ?? systemCommandExecutor
  };
}
function parseOpenClawConfig(value) {
  if (!isObject2(value)) throw new Error("OpenClaw MCP \u72B6\u6001\u8F93\u51FA\u65E0\u6548");
  const headers = isObject2(value.headers) ? value.headers : {};
  const serverUrl = value.url;
  const frontendUrl = headers[QUICK_IMAGE_FRONTEND_HEADER];
  if (typeof serverUrl !== "string" || typeof frontendUrl !== "string") {
    throw new Error("OpenClaw Quick Image MCP \u7F3A\u5C11 Server URL \u6216 Frontend URL");
  }
  return { serverUrl, frontendUrl };
}
function isObject2(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// src/environment/service.ts
async function executeEnvironmentCommand(options) {
  const hosts = options.host === "all" ? ["codex", "openclaw"] : [options.host];
  const urls = options.action === "set" ? normalizeEnvironmentUrls(options.serverUrl, options.frontendUrl) : void 0;
  const results = [];
  for (const host of hosts) {
    if (host === "codex") {
      const codexOptions = {
        pluginVersion: options.pluginVersion,
        ...options.codexBin ? { codexBin: options.codexBin } : {},
        ...options.codexConfigPath ? { configPath: options.codexConfigPath } : {}
      };
      results.push(options.action === "set" ? await setCodexEnvironment(urls, codexOptions) : options.action === "reset" ? await resetCodexEnvironment(codexOptions) : await readCodexEnvironmentStatus(codexOptions));
      continue;
    }
    const openClawOptions = {
      pluginVersion: options.pluginVersion,
      ...options.openClawBin ? { openClawBin: options.openClawBin } : {}
    };
    results.push(options.action === "set" ? await setOpenClawEnvironment(urls, openClawOptions) : options.action === "reset" ? await resetOpenClawEnvironment(openClawOptions) : await readOpenClawEnvironmentStatus(openClawOptions));
  }
  return results;
}
function formatEnvironmentResult(action, statuses) {
  if (action === "status") return `${JSON.stringify({ hosts: statuses }, null, 2)}
`;
  const verb = action === "set" ? "\u5DF2\u66F4\u65B0" : "\u5DF2\u6062\u590D\u6B63\u5F0F\u9ED8\u8BA4\u914D\u7F6E";
  const lines = [`Quick Image \u73AF\u5883 URL ${verb}\u3002`];
  for (const status of statuses) {
    lines.push(
      `Host: ${status.host}`,
      `Server: ${status.serverUrl ?? "\u672A\u914D\u7F6E"}`,
      `Frontend: ${status.frontendUrl ?? "\u672A\u914D\u7F6E"}`
    );
    if (status.authenticationCommand) {
      lines.push(`\u91CD\u65B0\u6388\u6743\uFF1A${status.authenticationCommand}`);
    }
  }
  if (statuses.some((status) => status.host === "codex")) {
    lines.push("Codex \u8BF7\u65B0\u5EFA\u4EFB\u52A1\u4EE5\u52A0\u8F7D\u6700\u65B0 MCP \u914D\u7F6E\u3002");
  }
  return `${lines.join("\n")}
`;
}

// src/environment/openclaw-setup.ts
import { createInterface } from "readline/promises";
var OPENCLAW_PLUGIN_ID = "quick-image";
var MANUAL_LOGIN_COMMAND = "openclaw mcp login quick-image";
async function setupOpenClaw(options) {
  const openClawBin = resolveOpenClawExecutable(options.openClawBin);
  const executor = options.executor ?? systemCommandExecutor;
  const interactiveExecutor = options.interactiveExecutor ?? systemInteractiveCommandExecutor;
  const prompt = options.prompt ?? terminalConfirmationPrompt();
  const toolAccessChanged = ensureToolAccess(openClawBin, executor);
  const mcpAction = await configureProductionMcp({
    openClawBin,
    executor,
    prompt,
    pluginVersion: options.pluginVersion
  });
  let loginAction = "skipped";
  let loginError;
  if (prompt.interactive && await prompt.confirm("\u662F\u5426\u73B0\u5728\u767B\u5F55 Quick Image MCP\uFF1F", true)) {
    try {
      interactiveExecutor.run(openClawBin, ["mcp", "login", QUICK_IMAGE_MCP_NAME]);
      loginAction = "started";
    } catch (error) {
      loginAction = "failed";
      loginError = errorMessage(error);
    }
  }
  executor.run(openClawBin, ["mcp", "reload"]);
  executor.run(openClawBin, ["gateway", "restart"]);
  return {
    toolAccessChanged,
    mcpAction,
    loginAction,
    ...loginError ? { loginError } : {}
  };
}
function formatOpenClawSetupResult(result) {
  const toolAccess = result.toolAccessChanged ? "\u5DF2\u5C06 quick-image \u52A0\u5165 tools.alsoAllow\uFF0C\u5E76\u4FDD\u7559\u539F\u6709\u6761\u76EE\u3002" : "tools.alsoAllow \u5DF2\u5305\u542B quick-image\u3002";
  const mcp = result.mcpAction === "created" ? "\u5DF2\u767B\u8BB0 Quick Image \u6B63\u5F0F\u73AF\u5883 MCP\u3002" : result.mcpAction === "updated" ? "\u5DF2\u66F4\u65B0 Quick Image \u6B63\u5F0F\u73AF\u5883 MCP\u3002" : "\u5DF2\u4FDD\u7559\u73B0\u6709\u7684 Quick Image \u81EA\u5B9A\u4E49 MCP \u914D\u7F6E\u3002";
  const login = result.loginAction === "started" ? "\u5DF2\u542F\u52A8 MCP \u767B\u5F55\uFF1B\u8BF7\u6309\u7EC8\u7AEF\u4E2D\u7684\u6388\u6743\u63D0\u793A\u5B8C\u6210\u64CD\u4F5C\u3002" : result.loginAction === "failed" ? `MCP \u767B\u5F55\u672A\u5B8C\u6210\uFF1A${result.loginError ?? "\u672A\u77E5\u9519\u8BEF"}
\u7A0D\u540E\u53EF\u8FD0\u884C\uFF1A${MANUAL_LOGIN_COMMAND}` : `\u672A\u542F\u52A8 MCP \u767B\u5F55\u3002\u7A0D\u540E\u53EF\u8FD0\u884C\uFF1A${MANUAL_LOGIN_COMMAND}`;
  return [
    "Quick Image OpenClaw \u914D\u7F6E\u5B8C\u6210\u3002",
    toolAccess,
    mcp,
    login,
    "\u5DF2\u91CD\u65B0\u52A0\u8F7D MCP \u5E76\u91CD\u542F Gateway\u3002"
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
async function configureProductionMcp(options) {
  const servers = readOptionalConfigObject(options.openClawBin, options.executor, "mcp.servers") ?? {};
  const existing = servers[QUICK_IMAGE_MCP_NAME];
  let action = "created";
  if (existing !== void 0) {
    if (!isObject3(existing) || existing.url !== QUICK_IMAGE_PRODUCTION_SERVER_URL) {
      const replace = options.prompt.interactive && await options.prompt.confirm(
        "\u68C0\u6D4B\u5230\u81EA\u5B9A\u4E49 Quick Image MCP \u914D\u7F6E\uFF0C\u662F\u5426\u66FF\u6362\u4E3A\u6B63\u5F0F\u73AF\u5883\uFF1F",
        false
      );
      if (!replace) return "kept-custom";
    }
    action = "updated";
  }
  const config = buildOpenClawMcpConfig(productionEnvironmentUrls(), options.pluginVersion);
  options.executor.run(options.openClawBin, [
    "mcp",
    "set",
    QUICK_IMAGE_MCP_NAME,
    JSON.stringify(config)
  ]);
  return action;
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
  if (!isObject3(value)) throw new Error(`OpenClaw ${path5} \u914D\u7F6E\u5FC5\u987B\u662F\u5BF9\u8C61`);
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
function terminalConfirmationPrompt() {
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  return {
    interactive,
    async confirm(message, defaultValue) {
      if (!interactive) return defaultValue;
      const readline = createInterface({ input: process.stdin, output: process.stdout });
      try {
        const suffix = defaultValue ? " [Y/n] " : " [y/N] ";
        const answer = (await readline.question(message + suffix)).trim().toLowerCase();
        if (answer === "") return defaultValue;
        return answer === "y" || answer === "yes";
      } finally {
        readline.close();
      }
    }
  };
}
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
function isObject3(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// src/openclaw-adapter/environment-cli.ts
function registerOpenClawEnvironmentCli(api) {
  api.registerCli(({ program }) => {
    const root = program.command("quick-image").description("\u7BA1\u7406 Quick Image \u63D2\u4EF6\u914D\u7F6E");
    root.command("setup").description("\u914D\u7F6E\u5DE5\u5177\u6743\u9650\u3001\u6B63\u5F0F\u73AF\u5883 MCP \u548C\u53EF\u9009\u767B\u5F55").action(() => runOpenClawSetup(api));
    const environment = root.command("env").description("\u7BA1\u7406 Quick Image Server \u548C Frontend URL");
    environment.command("set").description("\u8BBE\u7F6E Quick Image Server \u548C Frontend URL").requiredOption("--server-url <url>", "Quick Image MCP URL").requiredOption("--frontend-url <url>", "Quick Image \u524D\u7AEF origin").action((options) => runOpenClawAction(api, "set", options));
    environment.command("status").description("\u663E\u793A\u5F53\u524D\u751F\u6548\u7684 Quick Image URL").action((options) => runOpenClawAction(api, "status", options));
    environment.command("reset").description("\u6062\u590D Quick Image \u6B63\u5F0F\u9ED8\u8BA4 URL").action((options) => runOpenClawAction(api, "reset", options));
  }, {
    descriptors: [{
      name: "quick-image",
      description: "\u7BA1\u7406 Quick Image \u63D2\u4EF6\u914D\u7F6E",
      hasSubcommands: true
    }]
  });
}
async function runOpenClawSetup(api) {
  if (!api.version) throw new Error("OpenClaw \u672A\u63D0\u4F9B Quick Image \u63D2\u4EF6\u7248\u672C");
  const result = await setupOpenClaw({ pluginVersion: api.version });
  process.stdout.write(formatOpenClawSetupResult(result));
}
async function runOpenClawAction(api, action, options) {
  if (!api.version) throw new Error("OpenClaw \u672A\u63D0\u4F9B Quick Image \u63D2\u4EF6\u7248\u672C");
  const statuses = await executeEnvironmentCommand({
    action,
    host: "openclaw",
    pluginVersion: api.version,
    ...options.serverUrl ? { serverUrl: options.serverUrl } : {},
    ...options.frontendUrl ? { frontendUrl: options.frontendUrl } : {}
  });
  process.stdout.write(formatEnvironmentResult(action, statuses));
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
function parsePreviewParameters(value) {
  if (!isObject4(value)) throw new Error("\u9884\u89C8\u53C2\u6570\u65E0\u6548\u3002");
  const displayUrl = parseHttpsUrl(value.display_url, "display_url");
  const downloadUrl = parseHttpsUrl(value.download_url, "download_url");
  if (value.media_kind !== "image" && value.media_kind !== "video") {
    throw new Error("media_kind \u5FC5\u987B\u662F image \u6216 video\u3002");
  }
  return { display_url: displayUrl, download_url: downloadUrl, media_kind: value.media_kind };
}
function parseListParameters(value) {
  if (value === void 0 || value === null) return {};
  if (!isObject4(value)) throw new Error("\u9644\u4EF6\u67E5\u8BE2\u53C2\u6570\u65E0\u6548\u3002");
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
function isObject4(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
var plugin = {
  id: "quick-image",
  name: "Quick Image",
  description: "\u5B89\u5168\u5904\u7406\u5F53\u524D OpenClaw \u4F1A\u8BDD\u9644\u4EF6\uFF0C\u5E76\u5C06\u751F\u6210\u7ED3\u679C\u53D1\u9001\u5230\u53EF\u4FE1\u6D88\u606F\u8DEF\u7531\u3002",
  register(api) {
    registerOpenClawEnvironmentCli(api);
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
      const registration = registry.register({
        sessionKey,
        ...runId ? { runId } : {},
        ...messageId ? { messageId } : {},
        attachments
      });
      pendingRegistrations.set(sessionKey, registration);
      const cleanup = () => {
        if (pendingRegistrations.get(sessionKey) === registration) pendingRegistrations.delete(sessionKey);
      };
      void registration.then(cleanup, cleanup);
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
      if (!pipelinePromise) return;
      void pipelinePromise.then((pipeline) => pipeline.cleanupExpired()).catch(() => {
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
  openclaw_adapter_default as default
};
