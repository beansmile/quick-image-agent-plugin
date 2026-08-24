const numericIdentifier = "(?:0|[1-9]\\d*)";
const prereleaseIdentifier = `(?:${numericIdentifier}|\\d*[A-Za-z-][0-9A-Za-z-]*)`;
const runtimeVersion =
  `${numericIdentifier}\\.${numericIdentifier}\\.${numericIdentifier}` +
  `(?:-${prereleaseIdentifier}(?:\\.${prereleaseIdentifier})*)?`;

export const runtimeTagPattern = new RegExp(`^v${runtimeVersion}$`);
export const runtimePackagePattern = new RegExp(
  "^https://github\\.com/beansmile/quick-image-agent-runtime/releases/download/" +
  `v(${runtimeVersion})/quick-image-agent-runtime-\\1\\.tgz$`
);

export function runtimePackageForTag(tag) {
  if (!runtimeTagPattern.test(tag ?? "")) {
    throw new Error("用法：pnpm runtime:set v<major>.<minor>.<patch>[-<prerelease>]");
  }
  const version = tag.slice(1);
  return (
    `https://github.com/beansmile/quick-image-agent-runtime/releases/download/${tag}/` +
    `quick-image-agent-runtime-${version}.tgz`
  );
}
