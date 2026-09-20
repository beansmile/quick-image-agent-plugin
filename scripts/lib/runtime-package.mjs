const numericIdentifier = "(?:0|[1-9]\\d*)";
const runtimeVersion = `${numericIdentifier}\\.${numericIdentifier}\\.${numericIdentifier}`;

export const runtimeTagPattern = new RegExp(`^v${runtimeVersion}$`);
export const runtimePackageUrlSource =
  "https://github\\.com/beansmile/quick-image-agent-runtime/releases/download/" +
  `v(${runtimeVersion})/quick-image-agent-runtime(?:-\\1)?\\.tgz`;
export const runtimePackagePattern = new RegExp(`^${runtimePackageUrlSource}$`);

export function runtimePackageForTag(tag) {
  if (!runtimeTagPattern.test(tag ?? "")) {
    throw new Error("用法：pnpm runtime:set v<major>.<minor>.<patch>");
  }
  return (
    `https://github.com/beansmile/quick-image-agent-runtime/releases/download/${tag}/` +
    "quick-image-agent-runtime.tgz"
  );
}
