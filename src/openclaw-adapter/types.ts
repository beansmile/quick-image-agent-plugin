export interface OpenClawToolParameters {
  type: string;
  properties: Record<string, Record<string, unknown>>;
  [key: string]: unknown;
}

export interface OpenClawToolContext {
  config?: Record<string, unknown>;
  runtimeConfig?: Record<string, unknown>;
  getRuntimeConfig?: () => Record<string, unknown> | undefined;
  deliveryContext?: {
    channel?: string;
    to?: string;
    accountId?: string;
    threadId?: string | number;
  };
  sessionKey?: string;
}

export interface OpenClawNativeTool {
  name: string;
  label: string;
  description: string;
  parameters: OpenClawToolParameters;
  annotations?: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: boolean;
  };
  execute(toolCallId: string, parameters: unknown): Promise<{
    content: Array<{ type: "text"; text: string }>;
    isError?: boolean;
  }>;
}
