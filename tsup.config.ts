import { defineConfig } from "tsup";

const shared = {
  format: "esm" as const,
  platform: "node" as const,
  bundle: true,
  splitting: false,
  sourcemap: false,
  minify: false,
  clean: true,
  external: ["quick-image-agent-runtime"]
};

export default defineConfig({
  ...shared,
  entry: { index: "src/openclaw-adapter/index.ts" },
  outDir: "openclaw-adapter/dist",
  target: "node22"
});
