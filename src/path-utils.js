export function normalizePath(path) {
  return path.replaceAll("\\", "/").replace(/^\.?\//, "");
}
