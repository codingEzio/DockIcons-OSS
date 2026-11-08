// SPDX-License-Identifier: MPL-2.0
// Machine-specific paths live outside the tracked source tree.
export async function loadConfig(root: string) {
  const explicit = Deno.env.get("X_DOCKICONS_CONFIG");
  const path = explicit ?? `${root}/Local/config.json`;
  if (!path.startsWith("/")) throw Error("X_DOCKICONS_CONFIG must be an absolute path");
  let text: string;
  try {
    text = await Deno.readTextFile(path);
  } catch (error) {
    if (!explicit && error instanceof Deno.errors.NotFound) return {};
    throw error;
  }
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw Error("Invalid DockIcons configuration");
  }
  const data = value as Record<string, unknown>;
  const allowed = ["catalog", "style", "adminHelper"];
  for (const [key, val] of Object.entries(data)) {
    if (!allowed.includes(key) || typeof val !== "string" || !val.trim()) {
      throw Error(`Invalid DockIcons configuration field: ${key}`);
    }
  }
  const resolve = (key: string): string | undefined => {
    const val = data[key] as string | undefined;
    if (!val) return undefined;
    return val.startsWith("/") ? val : `${path.slice(0, path.lastIndexOf("/"))}/${val}`;
  };
  return {
    catalog: resolve("catalog"),
    style: resolve("style"),
    adminHelper: resolve("adminHelper"),
  };
}
