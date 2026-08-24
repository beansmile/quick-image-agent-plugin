import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import plugin, { createListAttachmentsTool, createPreviewTool } from "../src/openclaw-adapter/index.js";
import { createOpenClawLocalTools } from "../src/openclaw-adapter/local-tools.js";
import { OpenClawAttachmentRegistry } from "../src/openclaw/attachment-registry.js";
import type { AttachmentPipelinePort } from "quick-image-agent-runtime";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("OpenClaw native preview adapter", () => {
  it("uses the merged Quick Image plugin identity", () => {
    expect(plugin.id).toBe("quick-image");
  });

  it("registers the OpenClaw setup command", () => {
    const commands: string[] = [];
    const command = {
      command: vi.fn((name: string) => {
        commands.push(name);
        return command;
      }),
      description: vi.fn(() => command),
      requiredOption: vi.fn(() => command),
      action: vi.fn(() => command)
    };
    const registerCli = vi.fn((registrar) => registrar({ program: command }));

    plugin.register(createApi({ registerCli }));

    expect(commands).toContain("quick-image");
    expect(commands).toContain("setup");
  });

  it("registers the scoped attachment and preview tools as required plugin tools", () => {
    const registerTool = vi.fn();
    const registerCli = vi.fn();
    plugin.register(createApi({ registerTool, registerCli }));

    expect(registerTool).toHaveBeenCalledTimes(9);
    expect(registerCli).toHaveBeenCalledWith(expect.any(Function), {
      descriptors: [{
        name: "quick-image",
        description: "管理 Quick Image 插件配置",
        hasSubcommands: true
      }]
    });
    expect(registerTool.mock.calls.map((call) => call[1])).toEqual([
      { name: "quick_image_list_attachments" },
      { name: "quick_image_inspect_attachment" },
      { name: "quick_image_prepare_attachment" },
      { name: "quick_image_estimate_lookbook_credits" },
      { name: "quick_image_estimate_pose_credits" },
      { name: "quick_image_estimate_upscale_credits" },
      { name: "quick_image_estimate_video_credits" },
      { name: "quick_image_upload_staged_attachment" },
      { name: "quick_image_send_preview" }
    ]);
    expect(registerTool.mock.calls[0]?.[1]).not.toHaveProperty("optional");
  });

  it("lists only opaque attachment ids for the current attachment message", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "quick-image-openclaw-native-test-"));
    temporaryDirectories.push(root);
    const registry = new OpenClawAttachmentRegistry(root);
    const registration = registry.register({
      sessionKey: "session-1",
      runId: "run-1",
      messageId: "message-1",
      attachments: [{
        source_reference: "/private/openclaw/media/inbound/reference.jpg",
        kind: "image",
        media_type: "image/jpeg",
        position: 1
      }]
    });
    const tool = createListAttachmentsTool(registry, new Map([["session-1", registration]]), {
      sessionKey: "session-1"
    });

    const result = await tool.execute("call-1", {});
    const output = result.content[0]?.text ?? "";
    expect(output).toMatch(/qio_[A-Za-z0-9_-]{43}/);
    expect(output).toContain('"message_id":"message-1"');
    expect(output).toContain('"has_more":false');
    expect(output).not.toContain("/private/openclaw");
  });

  it("treats an empty optional message id as omitted", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "quick-image-openclaw-native-test-"));
    temporaryDirectories.push(root);
    const registry = new OpenClawAttachmentRegistry(root);
    await registry.register({
      sessionKey: "session-1",
      messageId: "message-1",
      attachments: [{
        source_reference: "/private/openclaw/media/inbound/reference.jpg",
        kind: "image",
        media_type: "image/jpeg",
        position: 1
      }]
    });
    const tool = createListAttachmentsTool(registry, new Map(), { sessionKey: "session-1" });

    const result = await tool.execute("call-1", { limit: 10, message_id: "" });
    const output = result.content[0]?.text ?? "";

    expect(output).toContain('"message_id":"message-1"');
    expect(tool.parameters.properties.message_id?.description).toContain("不筛选时省略");
    expect(tool.parameters).not.toHaveProperty("required");
  });

  it("returns the latest ten attachments across messages in chronological order", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "quick-image-openclaw-native-test-"));
    temporaryDirectories.push(root);
    const registry = new OpenClawAttachmentRegistry(root);
    await registry.register({
      sessionKey: "session-1",
      messageId: "message-old",
      attachments: Array.from({ length: 5 }, (_, index) => ({
        source_reference: `/private/openclaw/media/inbound/old-${index + 1}.jpg`,
        kind: "image" as const,
        position: index + 1
      }))
    });
    await registry.register({
      sessionKey: "session-1",
      messageId: "message-latest",
      attachments: Array.from({ length: 6 }, (_, index) => ({
        source_reference: `/private/openclaw/media/inbound/latest-${index + 1}.jpg`,
        kind: "image" as const,
        position: index + 1
      }))
    });

    const defaults = await registry.list("session-1");
    expect(defaults.map(({ message_id, position }) => ({ message_id, position }))).toEqual([
      { message_id: "message-old", position: 2 },
      { message_id: "message-old", position: 3 },
      { message_id: "message-old", position: 4 },
      { message_id: "message-old", position: 5 },
      { message_id: "message-latest", position: 1 },
      { message_id: "message-latest", position: 2 },
      { message_id: "message-latest", position: 3 },
      { message_id: "message-latest", position: 4 },
      { message_id: "message-latest", position: 5 },
      { message_id: "message-latest", position: 6 }
    ]);
    const defaultCandidates = await registry.listCandidates("session-1");
    expect(defaultCandidates.has_more).toBe(true);
    expect(defaultCandidates.attachments).toHaveLength(10);
    expect(defaultCandidates.attachments[0]).toMatchObject({ message_id: "message-old", position: 2 });
    await expect(registry.listCandidates("session-1", { limit: 20 })).resolves.toMatchObject({
      has_more: false
    });
    await expect(registry.list("session-1", { limit: 3 })).resolves.toMatchObject([
      { message_id: "message-latest", position: 4 },
      { message_id: "message-latest", position: 5 },
      { message_id: "message-latest", position: 6 }
    ]);
    await expect(registry.list("session-1", { messageId: "message-old", limit: 20 })).resolves.toMatchObject([
      { message_id: "message-old", position: 1 },
      { message_id: "message-old", position: 2 },
      { message_id: "message-old", position: 3 },
      { message_id: "message-old", position: 4 },
      { message_id: "message-old", position: 5 }
    ]);
    await expect(registry.list("session-1", { messageId: "message-missing" })).resolves.toEqual([]);
    await expect(registry.list("another-session")).resolves.toEqual([]);
  });

  it("sends media through the current trusted delivery route", async () => {
    const sendMedia = vi.fn().mockResolvedValue({ channel: "telegram", messageId: "message-1" });
    const loadAdapter = vi.fn().mockResolvedValue({ sendMedia });
    const api = createApi({ loadAdapter });
    const tool = createPreviewTool(api, {
      deliveryContext: {
        channel: "telegram",
        to: "chat-1",
        accountId: "account-1",
        threadId: 7
      }
    });

    const result = await tool.execute("call-1", {
      display_url: "https://media.example.com/preview.jpg?token=test",
      download_url: "https://download.example.com/original.jpg?token=test",
      media_kind: "image"
    });

    expect(loadAdapter).toHaveBeenCalledWith("telegram");
    expect(sendMedia).toHaveBeenCalledWith({
      cfg: {},
      to: "chat-1",
      text: "Quick Image 图片生成完成\n下载原图：https://download.example.com/original.jpg?token=test",
      mediaUrl: "https://media.example.com/preview.jpg?token=test",
      accountId: "account-1",
      threadId: 7
    });
    expect(result.content[0]?.text).toContain('"sent":true');
  });

  it("falls back to the channel payload sender", async () => {
    const sendPayload = vi.fn().mockResolvedValue({ channel: "slack", messageId: "message-2" });
    const api = createApi({ loadAdapter: vi.fn().mockResolvedValue({ sendPayload }) });
    const tool = createPreviewTool(api, {
      deliveryContext: { channel: "slack", to: "channel-1" }
    });

    await tool.execute("call-1", {
      display_url: "https://media.example.com/preview.mp4",
      download_url: "https://download.example.com/original.mp4",
      media_kind: "video"
    });

    expect(sendPayload).toHaveBeenCalledWith(expect.objectContaining({
      to: "channel-1",
      mediaUrl: "https://media.example.com/preview.mp4",
      payload: {
        text: "Quick Image 视频生成完成\n下载原视频：https://download.example.com/original.mp4",
        mediaUrl: "https://media.example.com/preview.mp4"
      }
    }));
  });

  it("rejects non-HTTPS media and missing trusted routes", async () => {
    const api = createApi();
    const routedTool = createPreviewTool(api, {
      deliveryContext: { channel: "telegram", to: "chat-1" }
    });
    await expect(routedTool.execute("call-1", {
      display_url: "http://media.example.com/preview.jpg",
      download_url: "https://download.example.com/original.jpg",
      media_kind: "image"
    })).rejects.toThrow("display_url 必须是有效的 HTTPS URL");

    const unroutedTool = createPreviewTool(api, {});
    await expect(unroutedTool.execute("call-2", {
      display_url: "https://media.example.com/preview.jpg",
      download_url: "https://download.example.com/original.jpg",
      media_kind: "image"
    })).rejects.toThrow("没有可用的消息投递目标");
  });

  it("uses the shared attachment pipeline without exposing a local path", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "quick-image-openclaw-native-test-"));
    temporaryDirectories.push(root);
    const registry = new OpenClawAttachmentRegistry(root);
    await registry.register({
      sessionKey: "session-1",
      attachments: [{
        source_reference: "/private/openclaw/media/inbound/reference.jpg",
        kind: "image",
        position: 1
      }]
    });
    const [attachment] = await registry.list("session-1");
    const pipeline = createPipelineFixture();
    const tools = createOpenClawLocalTools(registry, async () => pipeline, { sessionKey: "session-1" });
    const inspect = tools.find((tool) => tool.name === "quick_image_inspect_attachment");

    const result = await inspect?.execute("call-1", { attachment_id: attachment?.attachment_id });

    expect(pipeline.inspect).toHaveBeenCalledWith(
      "/private/openclaw/media/inbound/reference.jpg",
      "session-1"
    );
    expect(result?.content[0]?.text).toContain('"attachment_handle":"qia_');
    expect(result?.content[0]?.text).not.toContain("/private/openclaw");
  });

  it("rejects an attachment id from another OpenClaw session", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "quick-image-openclaw-native-test-"));
    temporaryDirectories.push(root);
    const registry = new OpenClawAttachmentRegistry(root);
    await registry.register({
      sessionKey: "session-1",
      attachments: [{ source_reference: "/private/openclaw/media/inbound/reference.jpg", kind: "image", position: 1 }]
    });
    const [attachment] = await registry.list("session-1");
    const pipeline = createPipelineFixture();
    const tools = createOpenClawLocalTools(registry, async () => pipeline, { sessionKey: "session-2" });
    const inspect = tools.find((tool) => tool.name === "quick_image_inspect_attachment");

    const result = await inspect?.execute("call-1", { attachment_id: attachment?.attachment_id });

    expect(result?.isError).toBe(true);
    expect(result?.content[0]?.text).toContain('"code":"OPENCLAW_ATTACHMENT_NOT_FOUND"');
    expect(pipeline.inspect).not.toHaveBeenCalled();
  });

  it("keeps prepare and upload handles scoped to the current session", async () => {
    const pipeline = createPipelineFixture();
    const tools = createOpenClawLocalTools(
      new OpenClawAttachmentRegistry("/unused"),
      async () => pipeline,
      { sessionKey: "session-1" }
    );
    const prepare = tools.find((tool) => tool.name === "quick_image_prepare_attachment");
    const upload = tools.find((tool) => tool.name === "quick_image_upload_staged_attachment");
    const attachmentHandle = `qia_${"a".repeat(43)}`;
    const stagedHandle = `qis_${"b".repeat(43)}`;
    const directUpload = {
      asset_id: "asset-test",
      upload_url: "https://upload.example.com/object",
      headers: { "content-type": "image/png" },
      expires_at: new Date(Date.now() + 60_000).toISOString()
    };

    await prepare?.execute("call-1", { attachment_handle: attachmentHandle });
    await upload?.execute("call-2", { staged_handle: stagedHandle, direct_upload: directUpload });

    expect(pipeline.prepare).toHaveBeenCalledWith(attachmentHandle, "session-1");
    expect(pipeline.upload).toHaveBeenCalledWith(stagedHandle, directUpload, "session-1");
  });

  it("exposes the shared deterministic estimator as an OpenClaw native tool", async () => {
    const tools = createOpenClawLocalTools(
      new OpenClawAttachmentRegistry("/unused"),
      async () => createPipelineFixture(),
      { sessionKey: "session-1" }
    );
    const estimate = tools.find((tool) => tool.name === "quick_image_estimate_lookbook_credits");
    const result = await estimate?.execute("call-1", {
      estimation_contract_version: 1,
      pricing: { billing_strategy: "output_count", unit_credits: 10 },
      preset: null,
      preset_price_behavior: "use_model",
      output_count: 2,
      confirmation_thresholds: { output_count: 5, image_credits: 100, video_credits: 200 }
    });

    expect(result?.content[0]?.text).toContain('"estimated_credits":20');
  });
});

function createApi(overrides: {
  loadAdapter?: (channel: string) => Promise<unknown>;
  registerTool?: ReturnType<typeof vi.fn>;
  registerCli?: ReturnType<typeof vi.fn>;
  on?: ReturnType<typeof vi.fn>;
} = {}) {
  return {
    config: {},
    runtime: {
      channel: {
        outbound: {
          loadAdapter: overrides.loadAdapter ?? vi.fn().mockResolvedValue(undefined)
        }
      }
    },
    registerTool: overrides.registerTool ?? vi.fn(),
    registerCli: overrides.registerCli ?? vi.fn(),
    on: overrides.on ?? vi.fn()
  } as unknown as Parameters<typeof createPreviewTool>[0];
}

function createPipelineFixture() {
  return {
    inspect: vi.fn().mockResolvedValue({
      attachment_handle: `qia_${"a".repeat(43)}`,
      kind: "image",
      content_type: "image/jpeg",
      byte_size: 100,
      metadata: { width: 10, height: 10 },
      expires_at: new Date(Date.now() + 60_000).toISOString()
    }),
    prepare: vi.fn().mockResolvedValue({
      staged_handle: `qis_${"b".repeat(43)}`,
      create_direct_upload_args: {},
      expires_at: new Date(Date.now() + 60_000).toISOString()
    }),
    upload: vi.fn().mockResolvedValue({ asset_id: "asset-test" }),
    cleanupExpired: vi.fn().mockResolvedValue(undefined)
  } as unknown as AttachmentPipelinePort & {
    inspect: ReturnType<typeof vi.fn>;
    prepare: ReturnType<typeof vi.fn>;
    upload: ReturnType<typeof vi.fn>;
  };
}
