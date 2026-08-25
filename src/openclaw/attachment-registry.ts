import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { HANDLE_TTL_MS, PluginError } from "quick-image-agent-runtime";

export type OpenClawAttachmentKind = "image" | "video" | "audio" | "unknown";

export interface OpenClawAttachmentRegistration {
  source_reference: string;
  kind: OpenClawAttachmentKind;
  media_type?: string;
  position: number;
}

export interface OpenClawAttachmentRecord extends OpenClawAttachmentRegistration {
  attachment_id: string;
  session_digest: string;
  run_id?: string;
  message_id?: string;
  received_at: string;
  expires_at: string;
}

interface ListOptions {
  messageId?: string;
  limit?: number;
}

export interface OpenClawAttachmentList {
  attachments: OpenClawAttachmentRecord[];
  has_more: boolean;
}

const ATTACHMENT_ID_PATTERN = /^qio_[A-Za-z0-9_-]{43}$/;
const DEFAULT_LIST_LIMIT = 10;

export class OpenClawAttachmentRegistry {
  private readonly recordsDirectory: string;
  private initialized?: Promise<void>;
  private lastRegistrationTimeMs = 0;

  constructor(root: string) {
    this.recordsDirectory = path.join(root, "openclaw-attachment-records");
  }

  initialize(): Promise<void> {
    this.initialized ??= this.initializeOnce();
    return this.initialized;
  }

  async register(params: {
    sessionKey: string;
    runId?: string;
    messageId?: string;
    attachments: OpenClawAttachmentRegistration[];
  }): Promise<void> {
    await this.initialize();
    const registrationTimeMs = Math.max(Date.now(), this.lastRegistrationTimeMs + 1);
    this.lastRegistrationTimeMs = registrationTimeMs;
    const now = new Date(registrationTimeMs);
    const sessionDigest = digest(params.sessionKey);
    await Promise.all(params.attachments.map(async (attachment) => {
      if (!isSupportedSourceReference(attachment.source_reference)) return;
      const attachmentId = createAttachmentId();
      const record: OpenClawAttachmentRecord = {
        ...attachment,
        attachment_id: attachmentId,
        session_digest: sessionDigest,
        ...(params.runId ? { run_id: params.runId } : {}),
        ...(params.messageId ? { message_id: params.messageId } : {}),
        received_at: now.toISOString(),
        expires_at: new Date(now.getTime() + HANDLE_TTL_MS).toISOString()
      };
      await writePrivateJson(this.recordPath(attachmentId), record);
    }));
  }

  async list(sessionKey: string, options: ListOptions = {}): Promise<OpenClawAttachmentRecord[]> {
    return (await this.listCandidates(sessionKey, options)).attachments;
  }

  async listCandidates(sessionKey: string, options: ListOptions = {}): Promise<OpenClawAttachmentList> {
    await this.initialize();
    const records = await this.readActiveRecords();
    const sessionDigest = digest(sessionKey);
    const limit = Math.min(20, Math.max(1, options.limit ?? DEFAULT_LIST_LIMIT));
    const sessionRecords = records.filter((record) => secureEqual(record.session_digest, sessionDigest));
    const selected = options.messageId
      ? sessionRecords.filter((record) => record.message_id === options.messageId)
      : sessionRecords;
    return {
      attachments: recentAttachmentsInChronologicalOrder(selected, limit),
      has_more: selected.length > limit
    };
  }

  async cleanupExpired(): Promise<void> {
    await this.initialize();
    await this.readActiveRecords();
  }

  async resolve(attachmentId: string): Promise<OpenClawAttachmentRecord> {
    await this.initialize();
    assertAttachmentId(attachmentId);
    try {
      const record = parseRecord(await readFile(this.recordPath(attachmentId), "utf8"));
      if (!secureEqual(record.attachment_id, attachmentId)) throw new Error("attachment id mismatch");
      if (Date.parse(record.expires_at) <= Date.now()) throw new Error("attachment reference expired");
      return record;
    } catch {
      throw new PluginError("OPENCLAW_ATTACHMENT_NOT_FOUND", "OpenClaw 附件引用不存在或已过期。", {
        field: "attachment_id",
        suggested_action: "请重新发送或重新引用附件。"
      });
    }
  }

  async resolveForSession(attachmentId: string, sessionKey: string): Promise<OpenClawAttachmentRecord> {
    const record = await this.resolve(attachmentId);
    if (!secureEqual(record.session_digest, digest(sessionKey))) {
      throw new PluginError("OPENCLAW_ATTACHMENT_NOT_FOUND", "OpenClaw 附件引用不存在或已过期。", {
        field: "attachment_id",
        suggested_action: "请重新发送或重新引用附件。"
      });
    }
    return record;
  }

  async deleteSession(sessionKey: string): Promise<void> {
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

  private async initializeOnce(): Promise<void> {
    await ensurePrivateDirectory(this.recordsDirectory);
    const records = await this.readActiveRecords();
    this.lastRegistrationTimeMs = records.reduce(
      (latest, record) => Math.max(latest, Date.parse(record.received_at)),
      0
    );
  }

  private async readActiveRecords(): Promise<OpenClawAttachmentRecord[]> {
    const entries = await readdir(this.recordsDirectory, { withFileTypes: true });
    const records: OpenClawAttachmentRecord[] = [];
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

  private recordPath(attachmentId: string): string {
    return path.join(this.recordsDirectory, `${digest(attachmentId)}.json`);
  }
}

function createAttachmentId(): string {
  return `qio_${randomBytes(32).toString("base64url")}`;
}

function assertAttachmentId(value: string): void {
  if (!ATTACHMENT_ID_PATTERN.test(value)) {
    throw new PluginError("INVALID_OPENCLAW_ATTACHMENT_ID", "OpenClaw 附件引用格式无效。", {
      field: "attachment_id"
    });
  }
}

function isSupportedSourceReference(value: string): boolean {
  return path.isAbsolute(value) || /^media:\/\/inbound\/[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/.test(value);
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function secureEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function parseRecord(value: string): OpenClawAttachmentRecord {
  const record = JSON.parse(value) as Partial<OpenClawAttachmentRecord>;
  if (typeof record.attachment_id !== "string" || !ATTACHMENT_ID_PATTERN.test(record.attachment_id) ||
    typeof record.session_digest !== "string" || !/^[0-9a-f]{64}$/.test(record.session_digest) ||
    typeof record.source_reference !== "string" || !isSupportedSourceReference(record.source_reference) ||
    !Number.isInteger(record.position) || (record.position ?? 0) < 1 ||
    !["image", "video", "audio", "unknown"].includes(record.kind ?? "") ||
    typeof record.received_at !== "string" || !Number.isFinite(Date.parse(record.received_at)) ||
    typeof record.expires_at !== "string" || !Number.isFinite(Date.parse(record.expires_at))) {
    throw new Error("invalid OpenClaw attachment record");
  }
  return record as OpenClawAttachmentRecord;
}

function recentAttachmentsInChronologicalOrder(
  records: OpenClawAttachmentRecord[],
  limit: number
): OpenClawAttachmentRecord[] {
  return records
    .sort((left, right) => right.received_at.localeCompare(left.received_at) || right.position - left.position)
    .slice(0, limit)
    .sort((left, right) => left.received_at.localeCompare(right.received_at) || left.position - right.position);
}

async function writePrivateJson(filePath: string, value: unknown): Promise<void> {
  const file = await open(filePath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
  try {
    await file.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await file.sync();
  } finally {
    await file.close();
  }
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const details = await lstat(directory);
  if (!details.isDirectory() || details.isSymbolicLink()) {
    throw new PluginError("INSECURE_STATE_DIRECTORY", "本地附件处理状态目录不安全。", {
      suggested_action: "将 QUICK_IMAGE_DATA_DIR 指向仅当前用户可访问的真实目录。"
    });
  }
  if ((details.mode & 0o077) !== 0) await chmod(directory, 0o700);
}
