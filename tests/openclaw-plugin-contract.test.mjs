import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("OpenClaw plugin contract", () => {
  it("uses native media delivery for common messaging channels", async () => {
    const skill = await readFile(path.resolve("skills/quick-image-generate/SKILL.md"), "utf8");
    const manifest = await readJson(path.resolve("openclaw.plugin.json"));
    const pluginPackage = await readJson(path.resolve("package.json"));

    expect(skill).toContain("OpenClaw 消息渠道");
    expect(skill).toContain("Telegram、WhatsApp、Discord、Slack、Signal、iMessage、Google Chat、Matrix、Mattermost 和 Microsoft Teams");
    expect(skill).toContain("`quick_image_send_preview`");
    expect(skill).toContain("`quick_image_list_attachments`");
    expect(skill).toContain("`quick_image_inspect_attachment`");
    expect(skill).toContain("`quick_image_prepare_attachment`");
    expect(skill).toContain("`quick_image_upload_staged_attachment`");
    expect(skill).toContain("不需要第二个本地 MCP");
    expect(skill).toContain("不要要求或传递绝对路径、`media://` 引用");
    expect(skill).toContain("不接收也不得另行指定 `channel`、`to`、`target`、账号或 thread");
    expect(skill).toContain("不要改用通用 `message`");
    expect(skill).toContain("最终回复使用 `NO_REPLY`");
    expect(skill).toContain("不要退回 Markdown 图片");
    expect(manifest.id).toBe("quick-image");
    expect(manifest).not.toHaveProperty("requiresPlugins");
    expect(manifest).not.toHaveProperty("mcpServers");
    expect(manifest.skills).toEqual(["./skills"]);
    expect(manifest.contracts.tools).toEqual([
      "quick_image_list_attachments",
      "quick_image_inspect_attachment",
      "quick_image_prepare_attachment",
      "quick_image_estimate_lookbook_credits",
      "quick_image_estimate_pose_credits",
      "quick_image_estimate_upscale_credits",
      "quick_image_estimate_video_credits",
      "quick_image_upload_staged_attachment",
      "quick_image_send_preview"
    ]);
    expect(manifest.contracts).not.toHaveProperty("trustedToolPolicies");
    expect(pluginPackage.openclaw.extensions).toEqual(["./openclaw-adapter/dist/index.js"]);
    expect(skill).toContain("显式加入 `tools.alsoAllow`");
    expect(skill).toContain("不得要求用户反复重发附件");
    expect(skill).toContain("不需要通用 `message` 工具");
  });

  it("guides users through the Quick Image manual OAuth completion page", async () => {
    const skill = await readFile(path.resolve("skills/quick-image-generate/SKILL.md"), "utf8");
    const readme = await readFile(path.resolve("README.md"), "utf8");

    expect(readme).toContain("该链接会直接进入 Quick Image 前台登录和授权页");
    expect(skill).toContain("授权完成页会显示一次性授权码");
    expect(skill).toContain("复制完整命令并在自己的终端执行");
    expect(skill).not.toContain("旧版服务");
  });

  it("uses the plugin setup command for the OpenClaw installation flow", async () => {
    const readme = await readFile(path.resolve("README.md"), "utf8");
    const installSection = readme.slice(readme.indexOf("### OpenClaw"), readme.indexOf("#### 安装验证与故障排查"));

    expect(installSection).toContain("openclaw quick-image setup");
    expect(installSection).toContain("openclaw plugins install git:https://github.com/beansmile/quick-image-agent-plugin.git");
    expect(installSection).not.toMatch(/quick-image-agent-plugin\.git[@#]v\d/);
    expect(installSection).not.toContain("openclaw config set tools.alsoAllow");
    expect(installSection).not.toContain("openclaw mcp set quick-image");
    expect(installSection).toContain("#### 登录或重新登录 MCP");
    expect(installSection).toContain("openclaw mcp login quick-image --code '<授权码>'");
    expect(installSection).toContain("openclaw mcp probe quick-image");
  });

  it("uses a self-cleaning isolated cron for OpenClaw polling", async () => {
    const skill = await readFile(path.resolve("skills/quick-image-generate/SKILL.md"), "utf8");

    expect(skill).toContain("轮询间隔统一为 30 秒");
    expect(skill).toContain('`sessionTarget="isolated"`、`payload.kind="agentTurn"`');
    expect(skill).toContain('"schedule": { "kind": "every", "everyMs": 30000 }');
    expect(skill).toContain('"toolsAllow": ["quick-image__get_generation_tasks", "quick_image_send_preview", "cron"]');
    expect(skill).toContain('`cron(action="remove", jobId="<自身任务 ID>")` 删除自身');
    expect(skill).toContain("不得创建 `main + systemEvent` 或一次性任务");
    expect(skill).toContain("用 `exec` 仅执行 `sleep 30` 后再次调用 `get_generation_tasks`");
  });

  it("keeps the local installer focused on official install, enable, and environment commands", async () => {
    const packageJson = await readJson(path.resolve("package.json"));
    const installer = packageJson.scripts["dev:install:openclaw"];

    expect(installer).toContain("openclaw plugins install --link .");
    expect(installer).toContain("openclaw plugins enable quick-image");
    expect(installer).toContain("openclaw quick-image env set");
    expect(installer).not.toContain("plugins doctor");
    expect(installer).not.toContain("mcp login");
    expect(installer).not.toContain("install-local-openclaw.mjs");
  });

  it("keeps the Quick Image doctor optional in the OpenClaw user guide", async () => {
    const readme = await readFile(path.resolve("README.md"), "utf8");
    const installSection = readme.slice(readme.indexOf("### OpenClaw"), readme.indexOf("#### 安装验证与故障排查"));

    expect(installSection).not.toContain("quick-image-doctor");
    expect(readme).toContain("Doctor 不是安装或启用插件的必要步骤");
    expect(readme).toContain("quick-image-doctor --host openclaw");
    expect(readme).toContain("命令只执行诊断，不修改 OpenClaw 配置");
  });
});

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}
