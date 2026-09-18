import path from "node:path";
import { randomBytes } from "node:crypto";
import {
  assertSupportedRuntime,
  AttachmentPipeline,
  HANDLE_CLEANUP_INTERVAL_MS,
  PluginError,
  PreviewDownloadService,
  resolveOpenClawAttachmentRegistryDirectory
} from "quick-image-agent-runtime";
import { OpenClawAttachmentRegistry, type OpenClawAttachmentKind } from "../openclaw/attachment-registry.js";
import { createOpenClawLocalTools, OPENCLAW_LOCAL_TOOL_NAMES } from "./local-tools.js";
import { registerOpenClawCli } from "./environment-cli.js";
import type { OpenClawNativeTool, OpenClawToolContext } from "./types.js";

const PREVIEW_TOOL_NAME = "quick_image_send_preview";
const LIST_ATTACHMENTS_TOOL_NAME = "quick_image_list_attachments";

interface MessageReceivedEvent {
  messageId?: string;
  runId?: string;
  sessionKey?: string;
  metadata?: Record<string, unknown>;
}

interface MessageHookContext {
  messageId?: string;
  runId?: string;
  sessionKey?: string;
}

interface DeliveryResult {
  channel: string;
  messageId: string;
}

interface OutboundContext {
  cfg: Record<string, unknown>;
  to: string;
  text: string;
  mediaUrl: string;
  fileName?: string;
  accountId?: string;
  threadId?: string | number;
}

interface OutboundAdapter {
  sendMedia?: (context: OutboundContext) => Promise<DeliveryResult>;
  sendPayload?: (context: OutboundContext & {
    payload: { text: string; mediaUrl: string };
  }) => Promise<DeliveryResult>;
}

interface OpenClawPluginApi {
  version?: string;
  config: Record<string, unknown>;
  runtime: {
    channel: {
      outbound: {
        loadAdapter: (channel: string) => Promise<OutboundAdapter | undefined>;
      };
    };
  };
  registerTool: (
    factory: (context: OpenClawToolContext) => OpenClawNativeTool,
    options: { name: string }
  ) => void;
  registerCli: Parameters<typeof registerOpenClawCli>[0]["registerCli"];
  on(
    hookName: "message_received",
    handler: (event: MessageReceivedEvent, context: MessageHookContext) => Promise<void> | void
  ): void;
}

interface PreviewParameters {
  display_url: string;
  download_url: string;
  media_kind: "image" | "video";
  preview_content_type?: string;
}

// 各聊天渠道的媒体投递普遍依赖文件扩展名或 Content-Type 区分“图片/视频消息”与“文件消息”。
// Quick Image 的结果 URL 是无扩展名的对象存储 key，部分渠道（如飞书）会因此把媒体降级为文件卡片，
// 因此图片预览经 Runtime 下载到本地后，用 magic bytes 检测出的 MIME 映射带扩展名的 fileName；
// 视频没有本地下载路径，继续用任务结果返回的 preview_content_type 映射。
const PREVIEW_MIME_EXTENSIONS: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "image/bmp": ".bmp",
  "video/mp4": ".mp4",
  "video/quicktime": ".mov",
  "video/webm": ".webm",
  "video/x-msvideo": ".avi"
};

function previewFileName(parameters: PreviewParameters, detectedContentType?: string): string | undefined {
  const contentType = parameters.media_kind === "image" && detectedContentType
    ? detectedContentType
    : parameters.preview_content_type;
  if (!contentType) return undefined;
  const extension = PREVIEW_MIME_EXTENSIONS[contentType];
  return extension
    ? `quick-image-${parameters.media_kind}-${randomBytes(6).toString("hex")}${extension}`
    : undefined;
}

export type PreviewDownloadPort = Pick<PreviewDownloadService, "withCachedPreview">;

export function createPreviewTool(
  api: OpenClawPluginApi,
  context: OpenClawToolContext,
  previewDownloads: PreviewDownloadPort
): OpenClawNativeTool {
  return {
    name: PREVIEW_TOOL_NAME,
    label: "发送 Quick Image 预览",
    description: "将 Quick Image 成功任务的预览媒体发送到当前 OpenClaw 会话，并附上原文件下载链接；图片预览由本地运行时受约束下载后以本地文件投递，视频预览直接使用结果地址投递。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        display_url: {
          type: "string",
          maxLength: 8192,
          description: "Quick Image 任务结果返回的 display_url。"
        },
        download_url: {
          type: "string",
          maxLength: 8192,
          description: "同一任务结果返回的原文件 url。"
        },
        media_kind: {
          type: "string",
          enum: ["image", "video"],
          description: "结果媒体类型。"
        },
        preview_content_type: {
          type: "string",
          maxLength: 100,
          pattern: "^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}$",
          description: "同一任务结果返回的 preview_content_type（预览投递内容的 MIME 类型）。视频预览用它映射带扩展名的文件名；图片预览以本地下载检测出的格式为准，该字段仅作参考。"
        }
      },
      required: ["display_url", "download_url", "media_kind"]
    },
    async execute(_toolCallId: string, rawParameters: unknown) {
      try {
        return await executePreview(api, context, previewDownloads, rawParameters);
      } catch (error) {
        if (error instanceof PluginError) {
          return {
            content: [{ type: "text" as const, text: JSON.stringify(error.toPublicObject()) }],
            isError: true
          };
        }
        throw error;
      }
    }
  };
}

async function executePreview(
  api: OpenClawPluginApi,
  context: OpenClawToolContext,
  previewDownloads: PreviewDownloadPort,
  rawParameters: unknown
) {
  const parameters = parsePreviewParameters(rawParameters);
  const route = context.deliveryContext;
  if (!route?.channel || !route.to) {
    throw new Error("当前 OpenClaw 会话没有可用的消息投递目标。");
  }

  const adapter = await api.runtime.channel.outbound.loadAdapter(route.channel);
  if (!adapter) throw new Error(`当前消息渠道不支持原生媒体投递：${route.channel}`);

  const cfg = context.getRuntimeConfig?.() ?? context.runtimeConfig ?? context.config ?? api.config;
  // 视频维持远程 URL 投递；图片先下载到本地缓存，再以本地绝对路径投递。
  if (parameters.media_kind === "video") {
    return sendPreviewMedia(
      parameters,
      route,
      adapter,
      cfg,
      parameters.display_url,
      previewFileName(parameters)
    );
  }

  try {
    return await previewDownloads.withCachedPreview(parameters.display_url, async (file) => {
      try {
        return await sendPreviewMedia(parameters, route, adapter, cfg, file.filePath, previewFileName(parameters, file.contentType));
      } catch (error) {
        throw previewFailure("PREVIEW_SEND_FAILED", "预览媒体本地投递失败", parameters.download_url, error);
      }
    });
  } catch (error) {
    // 投递阶段已收敛为 PREVIEW_SEND_FAILED；其余失败一律按下载失败处理。
    if (error instanceof PluginError && error.code === "PREVIEW_SEND_FAILED") throw error;
    throw previewFailure("PREVIEW_DOWNLOAD_FAILED", "预览媒体下载失败", parameters.download_url, error);
  }
}

async function sendPreviewMedia(
  parameters: PreviewParameters,
  route: NonNullable<OpenClawToolContext["deliveryContext"]>,
  adapter: OutboundAdapter,
  cfg: Record<string, unknown>,
  mediaUrl: string,
  fileName: string | undefined
) {
  const text = parameters.media_kind === "video"
    ? `Quick Image 视频生成完成\n下载原视频：${parameters.download_url}`
    : `Quick Image 图片生成完成\n下载原图：${parameters.download_url}`;
  const outboundContext: OutboundContext = {
    cfg,
    to: route.to!,
    text,
    mediaUrl,
    ...(fileName ? { fileName } : {}),
    ...(route.accountId ? { accountId: route.accountId } : {}),
    ...(route.threadId !== undefined ? { threadId: route.threadId } : {})
  };

  // 始终使用当前会话的可信路由，工具参数不能指定 channel、收件人、账号或 thread。
  const result = adapter.sendMedia
    ? await adapter.sendMedia(outboundContext)
    : adapter.sendPayload
      ? await adapter.sendPayload({
          ...outboundContext,
          payload: { text, mediaUrl }
        })
      : undefined;
  if (!result) throw new Error(`当前消息渠道不支持原生媒体投递：${route.channel}`);

  return {
    content: [{
      type: "text" as const,
      text: JSON.stringify({
        sent: true,
        channel: result.channel,
        message_id: result.messageId,
        ...(parameters.media_kind === "image" ? { delivered_via: "local_file" } : {})
      })
    }]
  };
}

function previewFailure(code: string, summary: string, downloadUrl: string, cause: unknown): PluginError {
  const detail = cause instanceof PluginError
    ? `${cause.code}：${cause.message}`
    : cause instanceof Error
      ? cause.message
      : String(cause);
  return new PluginError(code, `${summary}（${detail}）。`, {
    retryable: false,
    suggested_action: `不要重试预览发送，也不要退回 Markdown 图片；改为直接发送原图链接文本：${downloadUrl}`
  });
}

export function createListAttachmentsTool(
  registry: OpenClawAttachmentRegistry,
  pendingRegistrations: Map<string, Promise<void>>,
  context: OpenClawToolContext
): OpenClawNativeTool {
  return {
    name: LIST_ATTACHMENTS_TOOL_NAME,
    label: "列出 Quick Image 附件",
    description: "列出当前 OpenClaw 会话最近的附件候选，默认返回最近 10 个并按上传时间从旧到新排列。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        message_id: {
          type: "string",
          maxLength: 512,
          description: "可选；仅在需要限定某条历史消息时传入，不筛选时省略该字段。"
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 20,
          description: "最多返回的附件数量，默认 10。"
        },
        cursor: {
          type: "string",
          pattern: "^qio_[A-Za-z0-9_-]{43}$",
          description: "可选；上一页返回的 next_cursor，用于继续读取更早的附件。"
        }
      }
    },
    async execute(_toolCallId: string, rawParameters: unknown) {
      const parameters = parseListParameters(rawParameters);
      if (!context.sessionKey) throw new Error("当前 OpenClaw 会话没有可用的附件上下文。");
      await pendingRegistrations.get(context.sessionKey);
      const result = await registry.listCandidates(context.sessionKey, {
        ...(parameters.message_id ? { messageId: parameters.message_id } : {}),
        ...(parameters.limit ? { limit: parameters.limit } : {}),
        ...(parameters.cursor ? { cursor: parameters.cursor } : {})
      });
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            attachments: result.attachments.map((attachment) => ({
              attachment_id: attachment.attachment_id,
              kind: attachment.kind,
              media_type: attachment.media_type ?? null,
              message_id: attachment.message_id ?? null,
              position: attachment.position,
              received_at: attachment.received_at
            })),
            has_more: result.has_more,
            next_cursor: result.next_cursor ?? null
          })
        }]
      };
    }
  };
}

export function enqueuePendingRegistration(
  pendingRegistrations: Map<string, Promise<void>>,
  sessionKey: string,
  register: () => Promise<void>
): Promise<void> {
  const previous = pendingRegistrations.get(sessionKey);
  // 同一会话按消息顺序登记；单条失败只影响本条，不阻塞后续消息继续入队。
  const queued = (previous ?? Promise.resolve())
    .catch(() => undefined)
    .then(register);
  pendingRegistrations.set(sessionKey, queued);
  const cleanup = () => {
    if (pendingRegistrations.get(sessionKey) === queued) pendingRegistrations.delete(sessionKey);
  };
  void queued.then(cleanup, cleanup);
  return queued;
}

function parsePreviewParameters(value: unknown): PreviewParameters {
  if (!isObject(value)) throw new Error("预览参数无效。");
  const displayUrl = parseHttpsUrl(value.display_url, "display_url");
  const downloadUrl = parseHttpsUrl(value.download_url, "download_url");
  if (value.media_kind !== "image" && value.media_kind !== "video") {
    throw new Error("media_kind 必须是 image 或 video。");
  }
  const previewContentType = parseOptionalContentType(value.preview_content_type, "preview_content_type");
  return {
    display_url: displayUrl,
    download_url: downloadUrl,
    media_kind: value.media_kind,
    ...(previewContentType ? { preview_content_type: previewContentType } : {})
  };
}

function parseOptionalContentType(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || value.length > 100 || !/^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}$/.test(value)) {
    throw new Error(`${field} 必须是有效的 MIME 类型。`);
  }
  return value.toLowerCase();
}

function parseListParameters(value: unknown): { message_id?: string; limit?: number; cursor?: string } {
  if (value === undefined || value === null) return {};
  if (!isObject(value)) throw new Error("附件查询参数无效。");
  const result: { message_id?: string; limit?: number; cursor?: string } = {};
  if (value.message_id !== undefined) {
    if (typeof value.message_id !== "string" || value.message_id.length > 512) {
      throw new Error("message_id 无效。");
    }
    if (value.message_id.trim() !== "") result.message_id = value.message_id;
  }
  if (value.limit !== undefined) {
    if (!Number.isInteger(value.limit) || (value.limit as number) < 1 || (value.limit as number) > 20) {
      throw new Error("limit 必须是 1 到 20 的整数。");
    }
    result.limit = value.limit as number;
  }
  if (value.cursor !== undefined) {
    if (typeof value.cursor !== "string" || !/^qio_[A-Za-z0-9_-]{43}$/.test(value.cursor)) {
      throw new Error("cursor 必须是有效的附件分页游标。");
    }
    result.cursor = value.cursor;
  }
  return result;
}

function extractInboundAttachments(metadata: Record<string, unknown> | undefined) {
  const paths = stringArray(metadata?.mediaPaths);
  if (paths.length === 0 && typeof metadata?.mediaPath === "string") paths.push(metadata.mediaPath);
  const types = stringArray(metadata?.mediaTypes);
  if (types.length === 0 && typeof metadata?.mediaType === "string") types.push(metadata.mediaType);
  return paths.map((sourceReference, index) => ({
    source_reference: sourceReference,
    kind: mediaKind(types[index]),
    ...(types[index] ? { media_type: types[index] } : {}),
    position: index + 1
  }));
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0) : [];
}

function mediaKind(mediaType: string | undefined): OpenClawAttachmentKind {
  const normalized = mediaType?.toLowerCase() ?? "";
  if (normalized.startsWith("image/")) return "image";
  if (normalized.startsWith("video/")) return "video";
  if (normalized.startsWith("audio/")) return "audio";
  return "unknown";
}

function parseHttpsUrl(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 8192) {
    throw new Error(`${field} 必须是有效的 HTTPS URL。`);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${field} 必须是有效的 HTTPS URL。`);
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error(`${field} 必须是有效的 HTTPS URL。`);
  }
  return url.toString();
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const plugin = {
  id: "quick-image",
  name: "Quick Image",
  description: "安全处理当前 OpenClaw 会话附件，并将生成结果发送到可信消息路由。",
  register(api: OpenClawPluginApi) {
    registerOpenClawCli(api);
    const stateDirectory = resolveOpenClawAttachmentRegistryDirectory();
    const registry = new OpenClawAttachmentRegistry(stateDirectory);
    // 图片预览的本地缓存：目录私有化与启动清扫交给服务初始化；容量清理由服务在每次保存后自触发。
    const previewDownloads = new PreviewDownloadService(path.join(stateDirectory, "preview-cache"));
    void previewDownloads.initialize().catch(() => {
      process.stderr.write(`${JSON.stringify({ code: "PREVIEW_CACHE_INIT_FAILED" })}\n`);
    });
    let pipelinePromise: Promise<AttachmentPipeline> | undefined;
    const getPipeline = () => {
      pipelinePromise ??= Promise.resolve().then(async () => {
        assertSupportedRuntime();
        return AttachmentPipeline.create(path.join(stateDirectory, "openclaw-attachment-pipeline"));
      });
      return pipelinePromise;
    };
    const pendingRegistrations = new Map<string, Promise<void>>();
    api.on("message_received", (event, context) => {
      const sessionKey = event.sessionKey ?? context.sessionKey;
      const attachments = extractInboundAttachments(event.metadata);
      if (!sessionKey || attachments.length === 0) return;
      const runId = event.runId ?? context.runId;
      const messageId = event.messageId ?? context.messageId;
      const registration = enqueuePendingRegistration(pendingRegistrations, sessionKey, () => registry.register({
        sessionKey,
        ...(runId ? { runId } : {}),
        ...(messageId ? { messageId } : {}),
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
        if (!tool) throw new Error(`无法注册 Quick Image 原生工具：${toolName}`);
        return tool;
      }, { name: toolName });
    }
    api.registerTool((context) => createPreviewTool(api, context, previewDownloads), { name: PREVIEW_TOOL_NAME });

    const cleanupTimer = setInterval(() => {
      // 预览缓存没有 TTL 可清，只保留 registry/pipeline 的既有清理。
      const cleanupTasks = [registry.cleanupUnavailable()];
      if (pipelinePromise) cleanupTasks.push(pipelinePromise.then((pipeline) => pipeline.cleanupExpired()));
      void Promise.all(cleanupTasks).catch(() => {
        process.stderr.write(`${JSON.stringify({ code: "ATTACHMENT_CLEANUP_FAILED" })}\n`);
      });
    }, HANDLE_CLEANUP_INTERVAL_MS);
    cleanupTimer.unref();
  }
};

export default plugin;
