import path from "node:path";
import {
  assertSupportedRuntime,
  AttachmentPipeline,
  HANDLE_CLEANUP_INTERVAL_MS,
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
}

export function createPreviewTool(api: OpenClawPluginApi, context: OpenClawToolContext): OpenClawNativeTool {
  return {
    name: PREVIEW_TOOL_NAME,
    label: "发送 Quick Image 预览",
    description: "将 Quick Image 成功任务的预览媒体发送到当前 OpenClaw 会话，并附上原文件下载链接。",
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
        }
      },
      required: ["display_url", "download_url", "media_kind"]
    },
    async execute(_toolCallId: string, rawParameters: unknown) {
      const parameters = parsePreviewParameters(rawParameters);
      const route = context.deliveryContext;
      if (!route?.channel || !route.to) {
        throw new Error("当前 OpenClaw 会话没有可用的消息投递目标。");
      }

      const adapter = await api.runtime.channel.outbound.loadAdapter(route.channel);
      if (!adapter) throw new Error(`当前消息渠道不支持原生媒体投递：${route.channel}`);

      const cfg = context.getRuntimeConfig?.() ?? context.runtimeConfig ?? context.config ?? api.config;
      const text = parameters.media_kind === "video"
        ? `Quick Image 视频生成完成\n下载原视频：${parameters.download_url}`
        : `Quick Image 图片生成完成\n下载原图：${parameters.download_url}`;
      const outboundContext: OutboundContext = {
        cfg,
        to: route.to,
        text,
        mediaUrl: parameters.display_url,
        ...(route.accountId ? { accountId: route.accountId } : {}),
        ...(route.threadId !== undefined ? { threadId: route.threadId } : {})
      };

      // 始终使用当前会话的可信路由，工具参数不能指定 channel、收件人、账号或 thread。
      const result = adapter.sendMedia
        ? await adapter.sendMedia(outboundContext)
        : adapter.sendPayload
          ? await adapter.sendPayload({
              ...outboundContext,
              payload: { text, mediaUrl: parameters.display_url }
            })
          : undefined;
      if (!result) throw new Error(`当前消息渠道不支持原生媒体投递：${route.channel}`);

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ sent: true, channel: result.channel, message_id: result.messageId })
        }]
      };
    }
  };
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
        }
      }
    },
    async execute(_toolCallId: string, rawParameters: unknown) {
      const parameters = parseListParameters(rawParameters);
      if (!context.sessionKey) throw new Error("当前 OpenClaw 会话没有可用的附件上下文。");
      await pendingRegistrations.get(context.sessionKey);
      const result = await registry.listCandidates(context.sessionKey, {
        ...(parameters.message_id ? { messageId: parameters.message_id } : {}),
        ...(parameters.limit ? { limit: parameters.limit } : {})
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
  return { display_url: displayUrl, download_url: downloadUrl, media_kind: value.media_kind };
}

function parseListParameters(value: unknown): { message_id?: string; limit?: number } {
  if (value === undefined || value === null) return {};
  if (!isObject(value)) throw new Error("附件查询参数无效。");
  const result: { message_id?: string; limit?: number } = {};
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
    api.registerTool((context) => createPreviewTool(api, context), { name: PREVIEW_TOOL_NAME });

    const cleanupTimer = setInterval(() => {
      const cleanupTasks = [registry.cleanupExpired()];
      if (pipelinePromise) cleanupTasks.push(pipelinePromise.then((pipeline) => pipeline.cleanupExpired()));
      void Promise.all(cleanupTasks).catch(() => {
        process.stderr.write(`${JSON.stringify({ code: "ATTACHMENT_CLEANUP_FAILED" })}\n`);
      });
    }, HANDLE_CLEANUP_INTERVAL_MS);
    cleanupTimer.unref();
  }
};

export default plugin;
