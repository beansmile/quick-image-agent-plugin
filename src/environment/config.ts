import { createRequire } from "node:module";

export const QUICK_IMAGE_MCP_NAME = "quick-image";
export const QUICK_IMAGE_LOCAL_MCP_NAME = "quick-image-local";
export const QUICK_IMAGE_PRODUCTION_SERVER_URL = "https://quickimage.ai/mcp";
export const QUICK_IMAGE_PRODUCTION_FRONTEND_URL = "https://quickimage.ai";
export const QUICK_IMAGE_FRONTEND_HEADER = "X-Quick-Image-Frontend-URL";
export const QUICK_IMAGE_VERSION_HEADER = "X-Quick-Image-Plugin-Version";
export const QUICK_IMAGE_OAUTH_SCOPE = "presets:read assets:write tasks:read tasks:write";
const RUNTIME_PACKAGE_NAME = "quick-image-agent-runtime";

export interface EnvironmentUrls {
  serverUrl: string;
  frontendUrl: string;
}

export interface OpenClawMcpConfig {
  transport: "streamable-http";
  url: string;
  auth: "oauth";
  oauth: { scope: string };
  headers: Record<string, string>;
}

export interface OpenClawLocalMcpConfig {
  command: string;
  args: string[];
}

export function productionEnvironmentUrls(): EnvironmentUrls {
  return {
    serverUrl: QUICK_IMAGE_PRODUCTION_SERVER_URL,
    frontendUrl: QUICK_IMAGE_PRODUCTION_FRONTEND_URL
  };
}

export function buildOpenClawMcpConfig(
  urls: EnvironmentUrls,
  pluginVersion: string
): OpenClawMcpConfig {
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

// runtime 版本以插件自身依赖为唯一来源；validate-package 会强制它与 mcp.json 的 stdio 条目一致。
export function runtimePackageSpec(): string {
  const pluginPackage = createRequire(import.meta.url)("../../package.json") as {
    dependencies: Record<string, string>;
  };
  const version = pluginPackage.dependencies[RUNTIME_PACKAGE_NAME];
  if (!version) throw new Error(`package.json 缺少 ${RUNTIME_PACKAGE_NAME} 依赖`);
  return `${RUNTIME_PACKAGE_NAME}@${version}`;
}

export function buildOpenClawLocalMcpConfig(): OpenClawLocalMcpConfig {
  return {
    command: "npx",
    args: ["--yes", "--package", runtimePackageSpec(), "quick-image-local-mcp"]
  };
}
