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

export default defineConfig([
  {
    ...shared,
    entry: {
      "cli/doctor": "src/cli/doctor.ts",
      "cli/quick-image": "src/cli/quick-image.ts"
    },
    outDir: "dist",
    target: "node20",
    banner: { js: "#!/usr/bin/env node" }
  },
  {
    ...shared,
    entry: { index: "src/openclaw-adapter/index.ts" },
    outDir: "openclaw-adapter/dist",
    target: "node22"
  }
]);
