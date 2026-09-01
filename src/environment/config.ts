export const QUICK_IMAGE_MCP_NAME = "quick-image";
export const QUICK_IMAGE_PRODUCTION_SERVER_URL = "https://quickimage.ai/mcp";
export const QUICK_IMAGE_PRODUCTION_FRONTEND_URL = "https://quickimage.ai";
export const QUICK_IMAGE_FRONTEND_HEADER = "X-Quick-Image-Frontend-URL";
export const QUICK_IMAGE_VERSION_HEADER = "X-Quick-Image-Plugin-Version";
export const QUICK_IMAGE_OAUTH_SCOPE = "presets:read assets:write tasks:read tasks:write";

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
