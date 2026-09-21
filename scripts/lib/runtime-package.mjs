const numericIdentifier = "(?:0|[1-9]\\d*)";
const runtimeVersion = `${numericIdentifier}\\.${numericIdentifier}\\.${numericIdentifier}`;

export const runtimePackageName = "quick-image-agent-runtime";
export const runtimePackageSpecSource = `${runtimePackageName}@${runtimeVersion}`;
export const runtimePackagePattern = new RegExp(`^${runtimePackageSpecSource}$`);
export const runtimePackageLatestSpec = `${runtimePackageName}@latest`;
export const runtimeVersionPattern = new RegExp(`^${runtimeVersion}$`);

export function runtimePackageForVersion(version) {
  if (!runtimeVersionPattern.test(version ?? "")) {
    throw new Error("用法：pnpm runtime:set <major>.<minor>.<patch>");
  }
  return `${runtimePackageName}@${version}`;
}
