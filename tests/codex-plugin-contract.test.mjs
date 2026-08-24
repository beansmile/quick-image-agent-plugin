import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildCodexPluginOverlay } from "../scripts/lib/codex-plugin-overlay.mjs";
import { runtimePackagePattern } from "../scripts/lib/runtime-package.mjs";

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("Codex plugin contract", () => {
  it("exposes the bundled skill as quick-image", async () => {
    const skill = await readFile(path.resolve("skills/quick-image/SKILL.md"), "utf8");
    const agentConfig = await readFile(path.resolve("skills/quick-image/agents/openai.yaml"), "utf8");

    expect(skill).toMatch(/^---\nname: quick-image\n/);
    expect(agentConfig).toContain('display_name: "Quick Image"');
    expect(agentConfig).toContain('default_prompt: "使用 $quick-image 根据我的附件生成图片或视频。"');
  });

  it("installs the repository-root plugin from the GitHub marketplace source", async () => {
    const readme = await readFile(path.resolve("README.md"), "utf8");
    const marketplace = await readJson(path.resolve(".agents/plugins/marketplace.json"));
    const installSection = readme.slice(readme.indexOf("### Codex"), readme.indexOf("### OpenClaw"));

    expect(installSection).toContain("Quick Image 暂未上架 Codex 官方 Plugin Marketplace");
    expect(installSection).toContain(
      "codex plugin marketplace add https://github.com/beansmile/quick-image-agent-plugin"
    );
    expect(installSection).toContain("codex plugin add quick-image@quick-image");
    expect(installSection).not.toContain("在 Codex 的 Plugin Marketplace 中找到");
    expect(marketplace).toMatchObject({
      name: "quick-image",
      plugins: [{
        name: "quick-image",
        source: { source: "local", path: "./" },
        policy: { installation: "AVAILABLE", authentication: "ON_USE" },
        category: "Creativity"
      }]
    });
  });

  it("loads bundled MCP servers through the companion config", async () => {
    const manifest = await readJson(path.resolve(".codex-plugin/plugin.json"));
    const mcpConfig = await readJson(path.resolve(".mcp.json"));
    const portableMcpConfig = await readJson(path.resolve("mcp.json"));
    const packageJson = await readJson(path.resolve("package.json"));

    expect(manifest.mcpServers).toBe("./.mcp.json");
    expect(Object.keys(mcpConfig.mcpServers).sort()).toEqual(["quick-image", "quick-image-local"]);
    expect(mcpConfig.mcpServers["quick-image"].http_headers?.["X-Quick-Image-Plugin-Version"])
      .toBe(packageJson.version);
    expect(mcpConfig.mcpServers["quick-image"].http_headers?.["X-Quick-Image-Frontend-URL"])
      .toBe("https://quickimage.ai");
    expect(mcpConfig.mcpServers["quick-image-local"].tools.inspect_attachment.approval_mode).toBe("prompt");
    const runtimeArgs = mcpConfig.mcpServers["quick-image-local"].args;
    expect(runtimeArgs.slice(0, 2)).toEqual(["--yes", "--package"]);
    expect(runtimeArgs[2]).toMatch(runtimePackagePattern);
    expect(runtimeArgs[3]).toBe("quick-image-local-mcp");
    expect(portableMcpConfig.mcpServers["quick-image-local"].args).toEqual(runtimeArgs);
    expect(packageJson.dependencies["quick-image-agent-runtime"]).toBe(runtimeArgs[2]);
    expect(packageJson.bin["quick-image"]).toBe("./dist/cli/quick-image.js");
    expect(packageJson.bin).not.toHaveProperty("quick-image-upload-bridge");
    expect(packageJson.bin).not.toHaveProperty("quick-image-local-mcp");
  });

  it("inspects an explicitly provided attachment without caching its bytes", async () => {
    const skill = await readFile(path.resolve("skills/quick-image/SKILL.md"), "utf8");
    const packageJson = await readJson(path.resolve("package.json"));

    expect(skill).toContain("工具发现");
    expect(skill).toContain("禁止扫描");
    expect(skill).toContain("绝对路径");
    expect(skill).toContain("立即停止");
    expect(skill).toContain("不复制附件字节、不压缩、不暂存、不上传");
    expect(skill).toContain("当前对话附件明确提供的绝对路径传给 `inspect_attachment`");
    expect(skill).toContain("保留每个检查结果的 `attachment_handle`");
    expect(skill).not.toContain("capture_attachment");
    expect(packageJson.bin).not.toHaveProperty("quick-image-attachment");
  });

  it("previews generated images with display_url and preserves the original download URL", async () => {
    const skill = await readFile(path.resolve("skills/quick-image/SKILL.md"), "utf8");

    expect(skill).toContain("Codex 使用 `display_url`");
    expect(skill).toContain("通过 Markdown 图片语法嵌入预览");
    expect(skill).toContain("使用 `url` 的“下载原图”链接");
    expect(skill).toContain("`display_url` 为空时不要调用 `quick_image_send_preview`");
    expect(skill).toContain("不得用 `url` 代替 `display_url` 预览");
  });

  it("shows only the public AI model display name in user-facing messages", async () => {
    const skill = await readFile(path.resolve("skills/quick-image/SKILL.md"), "utf8");
    const tools = await readFile(path.resolve("skills/quick-image/references/tools.md"), "utf8");

    expect(skill).toContain("用户可见内容只展示 `model.display_name`");
    expect(skill).toContain("不要展示 `model.id` 或 `model.version`");
    expect(skill).toContain("不得展示或推测内部供应商路由");
    expect(tools).toContain("`model.id`、`model.display_name`、`model.version`");
  });

  it("keeps quote confirmations concise and invites parameter changes", async () => {
    const skill = await readFile(path.resolve("skills/quick-image/SKILL.md"), "utf8");

    expect(skill).toContain("`person_count` 仅用于本地计价");
    expect(skill).toContain("不要以“识别人物”");
    expect(skill).toContain("如需调整参数，直接告诉我你的要求；确认无误请回复“确认生成”");
  });

  it("sends explicit task creation and result timeout notifications", async () => {
    const skill = await readFile(path.resolve("skills/quick-image/SKILL.md"), "utf8");

    expect(skill).toContain("第一次调用 `get_generation_tasks` 前");
    expect(skill).toContain("任务创建成功");
    expect(skill).toContain("正在等待生成结果");
    expect(skill).toContain("任务创建失败");
    expect(skill).toContain("任务创建状态待确认");
    expect(skill).toContain("等待结果超时");
    expect(skill).toContain("不代表生成失败");
    expect(skill).toContain("不要只在最终结果中汇总");
  });

  it("uses one bounded batch tool for task status and results", async () => {
    const skill = await readFile(path.resolve("skills/quick-image/SKILL.md"), "utf8");
    const tools = await readFile(path.resolve("skills/quick-image/references/tools.md"), "utf8");

    expect(skill).toContain("`get_generation_tasks`");
    expect(skill).toContain("单次至少 1 个、最多 20 个");
    expect(skill).toContain("不要再调用单独的结果工具");
    expect(tools).toContain("按 1～20 个已知 `task_id` 批量返回完整任务");
    expect(skill).not.toContain("`get_generation_task`");
    expect(skill).not.toContain("`get_generation_result`");
    expect(tools).not.toContain("`get_generation_task`");
    expect(tools).not.toContain("`get_generation_result`");
  });

  it("uses generation config as the only preset source", async () => {
    const skill = await readFile(path.resolve("skills/quick-image/SKILL.md"), "utf8");
    const parameters = await readFile(path.resolve("skills/quick-image/references/parameters.md"), "utf8");

    expect(skill).not.toContain("list_generation_presets");
    expect(parameters).not.toContain("list_generation_presets");
    expect(skill).toContain("搭配未指定模板且没有文字要求时");
    expect(skill).toContain("换姿未指定模板、没有文字姿势要求且没有姿势参考图时");
  });

  it("numbers preset names and accepts index, name, or a custom effect", async () => {
    const skill = await readFile(path.resolve("skills/quick-image/SKILL.md"), "utf8");
    const parameters = await readFile(path.resolve("skills/quick-image/references/parameters.md"), "utf8");

    expect(skill).toContain("格式为 `1. <模板名称>`");
    expect(skill).toContain("回复序号或模板名称选择，也可以直接描述自定义效果");
    expect(skill).toContain("序号只对应最近一次展示的当前能力模板列表");
    expect(parameters).toContain("用户回复纯序号、`第 N 个` 或 `N 号`时");
    expect(parameters).toContain("否则将文字视为自定义效果");
    expect(parameters).toContain("序号越界、模板名称匹配多个选项");
  });

  it("documents deterministic video mode selection and attachment roles", async () => {
    const skill = await readFile(path.resolve("skills/quick-image/SKILL.md"), "utf8");
    const parameters = await readFile(path.resolve("skills/quick-image/references/parameters.md"), "utf8");

    expect(skill).toContain("先按 [parameters.md](references/parameters.md) 的模式决策规则");
    expect(parameters).toContain("全能参考 `omni_reference`");
    expect(parameters).toContain("首尾帧 `first_last_frame`");
    expect(parameters).toContain("分镜 `storyboard`");
    expect(parameters).toContain("`reference_asset_ids[0]` 是必填首帧");
    expect(parameters).toContain("`duration_seconds` 必须等于所有镜头 `duration` 之和");
    expect(parameters).toContain("不根据附件顺序或画面内容猜测");
  });

  it("uses capability-specific local estimators instead of model arithmetic", async () => {
    const skill = await readFile(path.resolve("skills/quick-image/SKILL.md"), "utf8");
    const tools = await readFile(path.resolve("skills/quick-image/references/tools.md"), "utf8");
    const estimateTools = [
      ["estimate_lookbook_credits", "quick_image_estimate_lookbook_credits"],
      ["estimate_pose_credits", "quick_image_estimate_pose_credits"],
      ["estimate_upscale_credits", "quick_image_estimate_upscale_credits"],
      ["estimate_video_credits", "quick_image_estimate_video_credits"]
    ];

    for (const [codexTool, openClawTool] of estimateTools) {
      expect(skill).toContain(`\`${codexTool}\``);
      expect(skill).toContain(`\`${openClawTool}\``);
      expect(tools).toContain(`\`${codexTool}\` / \`${openClawTool}({`);
    }
    expect(skill).toContain("不得由模型重新计算或修正报价");
    expect(skill).not.toContain("`estimate_generation_credits`");
    expect(tools).not.toContain("`estimate_generation_credits`");
    expect(skill).not.toContain("`measurements`");
  });

  it("delegates preset price selection to the deterministic estimator", async () => {
    const skill = await readFile(path.resolve("skills/quick-image/SKILL.md"), "utf8");
    const tools = await readFile(path.resolve("skills/quick-image/references/tools.md"), "utf8");

    expect(skill).toContain("所选预设完整对象");
    expect(skill).toContain("`preset_price_behavior`");
    expect(skill).toContain("不得自行选择价格来源");
    expect(tools).toContain("预设 `unit_credits` 必须存在");
  });

  it("uses capability-specific submission tools without cross-capability count fields", async () => {
    const skill = await readFile(path.resolve("skills/quick-image/SKILL.md"), "utf8");
    const tools = await readFile(path.resolve("skills/quick-image/references/tools.md"), "utf8");
    const submitTools = [
      "submit_lookbook_task",
      "submit_pose_task",
      "submit_upscale_task",
      "submit_video_task"
    ];

    for (const tool of submitTools) {
      expect(skill).toContain(`\`${tool}\``);
      expect(tools).toContain(`\`${tool}\``);
    }
    expect(skill).toContain("arguments 中不得再传 `capability`");
    expect(skill).toContain("换姿只使用 `output_count_per_person`，不得传 `output_count`");
    expect(skill).toContain("`estimated_output_count` 是只读派生结果");
    expect(skill).not.toContain("submit_generation_task");
    expect(tools).not.toContain("submit_generation_task");
  });

  it("instructs the agent to limit OpenClaw execution to owner requests without claiming runtime enforcement", async () => {
    const skill = await readFile(path.resolve("skills/quick-image/SKILL.md"), "utf8");

    expect(skill).toContain("仅执行 owner 发出的 Quick Image 指令");
    expect(skill).toContain("根据宿主提供的当前会话上下文自行判断");
    expect(skill).toContain("不是原生运行时安全边界");
    expect(skill).not.toContain("senderIsOwner");
  });

  it("writes a self-contained development overlay with a cache-busted MCP config", async () => {
    const fixtureRoot = await createPluginFixture();
    const pluginRoot = path.join(fixtureRoot, "overlay");

    await buildCodexPluginOverlay({
      repositoryRoot: fixtureRoot,
      pluginRoot,
      cachebuster: "local-test",
      markerName: ".quick-image-dev-overlay"
    });

    const manifest = await readJson(path.join(pluginRoot, ".codex-plugin", "plugin.json"));
    const mcpConfig = await readJson(path.join(pluginRoot, ".mcp.json"));
    expect(manifest.version).toBe("0.1.0+codex.local-test");
    expect(manifest.mcpServers).toBe("./.mcp.json");
    expect(mcpConfig.mcpServers["quick-image"].url).toBe("https://quickimage.ai/mcp");
    expect(mcpConfig.mcpServers["quick-image"].http_headers).toEqual({
      "X-Quick-Image-Plugin-Version": "0.1.0",
      "X-Quick-Image-Frontend-URL": "https://quickimage.ai"
    });
    expect(mcpConfig.mcpServers["quick-image"].headers).toEqual({
      "X-Quick-Image-Plugin-Version": "0.1.0",
      "X-Quick-Image-Frontend-URL": "https://quickimage.ai"
    });
    expect(mcpConfig.mcpServers["quick-image-local"]).toEqual({
      command: "npx",
      args: ["--yes", "--package", "https://github.com/beansmile/quick-image-agent-runtime/releases/download/v0.1.0/quick-image-agent-runtime-0.1.0.tgz", "quick-image-local-mcp"],
      tools: { inspect_attachment: { approval_mode: "prompt" } }
    });
    await expect(readFile(path.join(pluginRoot, "skills", "quick-image", "SKILL.md"), "utf8"))
      .resolves.toContain("fixture skill");
  });
});

async function createPluginFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "quick-image-codex-overlay-"));
  temporaryDirectories.push(root);
  await mkdir(path.join(root, ".codex-plugin"), { recursive: true });
  await mkdir(path.join(root, "skills", "quick-image"), { recursive: true });
  await writeFile(path.join(root, ".codex-plugin", "plugin.json"), JSON.stringify({
    name: "quick-image",
    version: "0.1.0",
    description: "fixture",
    mcpServers: "./.mcp.json"
  }));
  await writeFile(path.join(root, ".mcp.json"), JSON.stringify({
    mcpServers: {
      "quick-image": {
        type: "http",
        url: "https://quickimage.ai/mcp",
        headers: {
          "X-Quick-Image-Plugin-Version": "0.1.0",
          "X-Quick-Image-Frontend-URL": "https://quickimage.ai"
        },
        http_headers: {
          "X-Quick-Image-Plugin-Version": "0.1.0",
          "X-Quick-Image-Frontend-URL": "https://quickimage.ai"
        }
      },
      "quick-image-local": {
        command: "npx",
        args: ["--yes", "--package", "https://github.com/beansmile/quick-image-agent-runtime/releases/download/v0.1.0/quick-image-agent-runtime-0.1.0.tgz", "quick-image-local-mcp"],
        tools: { inspect_attachment: { approval_mode: "prompt" } }
      }
    }
  }));
  await writeFile(path.join(root, "skills", "quick-image", "SKILL.md"), "fixture skill\n");
  return root;
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}
