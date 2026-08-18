import { z } from "zod";
import * as z4 from "zod/v4";
import {
  type AttachmentPipelinePort,
  directUploadSchema,
  estimateGenerationCredits,
  lookbookEstimateInputSchema,
  PluginError,
  poseEstimateInputSchema,
  toPluginError,
  upscaleEstimateInputSchema,
  videoEstimateInputSchema
} from "quick-image-agent-runtime";
import { OpenClawAttachmentRegistry } from "../openclaw/attachment-registry.js";
import type { OpenClawNativeTool, OpenClawToolContext, OpenClawToolParameters } from "./types.js";

export const OPENCLAW_LOCAL_TOOL_NAMES = [
  "quick_image_inspect_attachment",
  "quick_image_prepare_attachment",
  "quick_image_estimate_lookbook_credits",
  "quick_image_estimate_pose_credits",
  "quick_image_estimate_upscale_credits",
  "quick_image_estimate_video_credits",
  "quick_image_upload_staged_attachment"
] as const;

export type AttachmentPipelineProvider = () => Promise<AttachmentPipelinePort>;

const inspectInputSchema = z.object({
  attachment_id: z.string().regex(/^qio_[A-Za-z0-9_-]{43}$/)
}).strict();

const prepareInputSchema = z.object({
  attachment_handle: z.string().regex(/^qia_[A-Za-z0-9_-]{43}$/)
}).strict();

const uploadInputSchema = z.object({
  staged_handle: z.string().regex(/^qis_[A-Za-z0-9_-]{43}$/),
  direct_upload: directUploadSchema
}).strict();

const readOnlyAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false
} as const;

export function createOpenClawLocalTools(
  registry: OpenClawAttachmentRegistry,
  pipelineProvider: AttachmentPipelineProvider,
  context: OpenClawToolContext
): OpenClawNativeTool[] {
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

function createInspectTool(
  registry: OpenClawAttachmentRegistry,
  pipelineProvider: AttachmentPipelineProvider,
  context: OpenClawToolContext
): OpenClawNativeTool {
  return {
    name: "quick_image_inspect_attachment",
    label: "检查 Quick Image 附件",
    description: "检查当前 OpenClaw 会话中的附件并返回不包含本地路径或附件字节的一次性句柄。此步骤不处理、不暂存、不上传附件。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        attachment_id: {
          type: "string",
          pattern: "^qio_[A-Za-z0-9_-]{43}$",
          description: "quick_image_list_attachments 返回的当前会话附件 ID。"
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

function createPrepareTool(
  pipelineProvider: AttachmentPipelineProvider,
  context: OpenClawToolContext
): OpenClawNativeTool {
  return {
    name: "quick_image_prepare_attachment",
    label: "准备 Quick Image 附件",
    description: "用户确认报价后重新校验当前会话附件并处理媒体，返回一次性暂存句柄和可原样传给 create_direct_upload 的参数。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        attachment_handle: {
          type: "string",
          pattern: "^qia_[A-Za-z0-9_-]{43}$",
          description: "quick_image_inspect_attachment 返回的一次性检查句柄。"
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

function createUploadTool(
  pipelineProvider: AttachmentPipelineProvider,
  context: OpenClawToolContext
): OpenClawNativeTool {
  return {
    name: "quick_image_upload_staged_attachment",
    label: "上传 Quick Image 暂存附件",
    description: "使用远程 Quick Image MCP 签发的完整直传信息上传当前会话中完全相同的暂存文件，成功后消费句柄。",
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

function createLookbookEstimateTool(): OpenClawNativeTool {
  return estimateTool(
    "quick_image_estimate_lookbook_credits",
    "预估 Quick Image 搭配积分",
    "使用搭配模型价格、可选模板价格和输出数量确定性计算预计积分与额外确认原因。",
    lookbookEstimateInputSchema,
    (parameters) => estimateGenerationCredits({
      ...parameters,
      measurements: { output_count: parameters.output_count }
    })
  );
}

function createPoseEstimateTool(): OpenClawNativeTool {
  return estimateTool(
    "quick_image_estimate_pose_credits",
    "预估 Quick Image 换姿积分",
    "使用换姿模型价格、可选模板价格、人物数和单人输出数确定性计算预计积分与额外确认原因。",
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

function createUpscaleEstimateTool(): OpenClawNativeTool {
  return estimateTool(
    "quick_image_estimate_upscale_credits",
    "预估 Quick Image 高清积分",
    "使用高清价格和输入图片数量确定性计算预计积分与额外确认原因。",
    upscaleEstimateInputSchema,
    (parameters) => estimateGenerationCredits({
      ...parameters,
      measurements: { input_count: parameters.input_count }
    })
  );
}

function createVideoEstimateTool(): OpenClawNativeTool {
  return estimateTool(
    "quick_image_estimate_video_credits",
    "预估 Quick Image 视频积分",
    "使用视频价格、输出时长和可选输入视频时长确定性计算预计积分与额外确认原因。",
    videoEstimateInputSchema,
    (parameters) => estimateGenerationCredits({
      ...parameters,
      measurements: {
        output_duration_seconds: parameters.output_duration_seconds,
        ...(parameters.input_video_duration_seconds === null
          ? {}
          : { input_video_duration_seconds: parameters.input_video_duration_seconds })
      }
    })
  );
}

function estimateTool<T>(
  name: string,
  label: string,
  description: string,
  schema: z4.ZodType<T>,
  estimate: (parameters: T) => object
): OpenClawNativeTool {
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

function toOpenClawParameters(schema: z4.ZodType): OpenClawToolParameters {
  const jsonSchema = z4.toJSONSchema(schema) as Record<string, unknown>;
  const { $schema: _schema, ...parameters } = jsonSchema;
  return parameters as unknown as OpenClawToolParameters;
}

function requireSessionKey(context: OpenClawToolContext): string {
  if (!context.sessionKey) {
    throw new PluginError("OPENCLAW_SESSION_UNAVAILABLE", "当前 OpenClaw 会话没有可用的附件上下文。", {
      suggested_action: "请在原附件所在会话中重试。"
    });
  }
  return context.sessionKey;
}

async function executeLocalTool(action: () => Promise<object> | object) {
  try {
    const value = await action();
    return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
  } catch (error) {
    const publicError = toPluginError(error).toPublicObject();
    return {
      content: [{ type: "text" as const, text: JSON.stringify(publicError) }],
      isError: true
    };
  }
}
