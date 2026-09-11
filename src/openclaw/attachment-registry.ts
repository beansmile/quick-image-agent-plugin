import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { chmod, link, lstat, mkdir, open, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PluginError } from "quick-image-agent-runtime";

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
}

interface ListOptions {
  messageId?: string;
  limit?: number;
  cursor?: string;
}

export interface OpenClawAttachmentList {
  attachments: OpenClawAttachmentRecord[];
  has_more: boolean;
  next_cursor?: string;
}

interface OpenClawAttachmentRegistryOptions {
  isSourceAvailable?: (sourceReference: string) => Promise<boolean>;
  maxRecordsPerSession?: number;
}

const ATTACHMENT_ID_PATTERN = /^qio_[A-Za-z0-9_-]{43}$/;
const RECORD_FILENAME_PATTERN = /^[0-9a-f]{64}\.json$/;
const OPENCLAW_MEDIA_REFERENCE_PATTERN = /^media:\/\/inbound\/([A-Za-z0-9][A-Za-z0-9._-]{0,254})$/;
const DEFAULT_LIST_LIMIT = 10;
const DEFAULT_MAX_RECORDS_PER_SESSION = 500;
const STALE_TEMPORARY_RECORD_MS = 10 * 60 * 1000;

export class OpenClawAttachmentRegistry {
  private readonly recordsDirectory: string;
  private readonly isSourceAvailable: (sourceReference: string) => Promise<boolean>;
  private readonly maxRecordsPerSession: number;
  private initialized?: Promise<void>;
  private lastRegistrationTimeMs = 0;

  constructor(root: string, options: OpenClawAttachmentRegistryOptions = {}) {
    this.recordsDirectory = path.join(root, "openclaw-attachment-records");
    this.isSourceAvailable = options.isSourceAvailable ?? sourceReferenceIsAvailable;
    const maxRecordsPerSession = options.maxRecordsPerSession ?? DEFAULT_MAX_RECORDS_PER_SESSION;
    if (!Number.isInteger(maxRecordsPerSession) || maxRecordsPerSession < 1) {
      throw new Error("maxRecordsPerSession must be a positive integer");
    }
    this.maxRecordsPerSession = maxRecordsPerSession;
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
        received_at: now.toISOString()
      };
      await writePrivateJson(this.recordPath(attachmentId), record);
    }));
    await this.pruneExcessRecords(sessionDigest);
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
    const newestFirst = attachmentRecordsNewestFirst(selected);
    const startIndex = options.cursor === undefined
      ? 0
      : cursorStartIndex(newestFirst, options.cursor);
    const pageNewestFirst = newestFirst.slice(startIndex, startIndex + limit);
    const hasMore = startIndex + pageNewestFirst.length < newestFirst.length;
    const nextCursor = hasMore ? pageNewestFirst[pageNewestFirst.length - 1]!.attachment_id : undefined;
    return {
      attachments: [...pageNewestFirst].reverse(),
      has_more: hasMore,
      ...(nextCursor ? { next_cursor: nextCursor } : {})
    };
  }

  async cleanupUnavailable(): Promise<void> {
    await this.initialize();
    await this.readActiveRecords();
  }

  async resolve(attachmentId: string): Promise<OpenClawAttachmentRecord> {
    await this.initialize();
    assertAttachmentId(attachmentId);
    try {
      const record = parseRecord(await readFile(this.recordPath(attachmentId), "utf8"));
      if (!secureEqual(record.attachment_id, attachmentId)) throw new Error("attachment id mismatch");
      if (!await this.isSourceAvailable(record.source_reference)) throw new Error("attachment source unavailable");
      return record;
    } catch {
      throw new PluginError("OPENCLAW_ATTACHMENT_NOT_FOUND", "OpenClaw 附件引用不存在或源文件已不可用。", {
        field: "attachment_id",
        suggested_action: "请重新发送或重新引用附件。"
      });
    }
  }

  async resolveForSession(attachmentId: string, sessionKey: string): Promise<OpenClawAttachmentRecord> {
    const record = await this.resolve(attachmentId);
    if (!secureEqual(record.session_digest, digest(sessionKey))) {
      throw new PluginError("OPENCLAW_ATTACHMENT_NOT_FOUND", "OpenClaw 附件引用不存在、不可用于当前会话或源文件已不可用。", {
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
      if (!RECORD_FILENAME_PATTERN.test(entry.name)) {
        await removeStaleTemporaryRecord(entry.name, filePath);
        return;
      }
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
      if (!RECORD_FILENAME_PATTERN.test(entry.name)) {
        await removeStaleTemporaryRecord(entry.name, filePath);
        return;
      }
      try {
        const record = parseRecord(await readFile(filePath, "utf8"));
        // 发现索引跟随宿主管理的源文件存续，不复用短期处理句柄的 TTL。
        if (!await this.isSourceAvailable(record.source_reference)) {
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

  private async pruneExcessRecords(sessionDigest: string): Promise<void> {
    const sessionRecords = (await this.readActiveRecords())
      .filter((record) => secureEqual(record.session_digest, sessionDigest));
    const excessRecords = attachmentRecordsNewestFirst(sessionRecords)
      .slice(this.maxRecordsPerSession);
    await Promise.all(excessRecords.map((record) => rm(this.recordPath(record.attachment_id), { force: true })));
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
  return path.isAbsolute(value) || OPENCLAW_MEDIA_REFERENCE_PATTERN.test(value);
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
    Object.hasOwn(record, "expires_at")) {
    throw new Error("invalid OpenClaw attachment record");
  }
  return record as OpenClawAttachmentRecord;
}

function attachmentRecordsNewestFirst(records: OpenClawAttachmentRecord[]): OpenClawAttachmentRecord[] {
  return [...records]
    .sort((left, right) => right.received_at.localeCompare(left.received_at) || right.position - left.position);
}

function cursorStartIndex(records: OpenClawAttachmentRecord[], cursor: string): number {
  assertAttachmentId(cursor);
  // 使用当前页最旧记录的 opaque ID 定位下一页，新消息插入不会导致历史页漂移。
  const cursorIndex = records.findIndex((record) => secureEqual(record.attachment_id, cursor));
  if (cursorIndex === -1) {
    throw new PluginError("OPENCLAW_ATTACHMENT_CURSOR_NOT_FOUND", "OpenClaw 附件分页游标不存在或已失效。", {
      field: "cursor",
      suggested_action: "请重新列出当前会话附件。"
    });
  }
  return cursorIndex + 1;
}

async function sourceReferenceIsAvailable(sourceReference: string): Promise<boolean> {
  const sourcePath = await sourceReferencePath(sourceReference);
  if (!sourcePath) return false;
  try {
    const details = await lstat(sourcePath);
    return details.isFile() && !details.isSymbolicLink();
  } catch {
    return false;
  }
}

async function sourceReferencePath(sourceReference: string): Promise<string | undefined> {
  if (path.isAbsolute(sourceReference)) return sourceReference;
  const mediaMatch = OPENCLAW_MEDIA_REFERENCE_PATTERN.exec(sourceReference);
  if (!mediaMatch?.[1]) return undefined;
  const configuredStateDirectory = process.env.OPENCLAW_STATE_DIR?.trim();
  const stateDirectory = configuredStateDirectory
    ? path.resolve(configuredStateDirectory)
    : path.join(os.homedir(), ".openclaw");
  const inboundDirectory = path.join(stateDirectory, "media", "inbound");
  try {
    const details = await lstat(inboundDirectory);
    if (!details.isDirectory() || details.isSymbolicLink()) return undefined;
  } catch {
    return undefined;
  }
  return path.join(inboundDirectory, mediaMatch[1]);
}

async function writePrivateJson(filePath: string, value: unknown): Promise<void> {
  const temporaryPath = `${filePath}.tmp-${randomBytes(16).toString("hex")}`;
  try {
    const file = await open(temporaryPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
    try {
      await file.writeFile(`${JSON.stringify(value)}\n`, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    // hard link 只会在目标不存在时成功，确保扫描器永远看不到半写入的最终记录。
    await link(temporaryPath, filePath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

async function removeStaleTemporaryRecord(fileName: string, filePath: string): Promise<void> {
  if (!fileName.includes(".json.tmp-")) return;
  try {
    const details = await lstat(filePath);
    // 新鲜临时文件可能仍由并发注册写入；只回收明显由异常退出遗留的文件。
    if (Date.now() - details.mtimeMs >= STALE_TEMPORARY_RECORD_MS) {
      await rm(filePath, { force: true });
    }
  } catch {
    // 文件可能刚由写入方完成或删除，无需将竞争状态暴露给调用方。
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
