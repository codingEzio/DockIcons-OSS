import { withCatalogLock, withExclusiveOutput } from "./safe_output.ts";
import { adminMetadata } from "./admin.ts";
import { loadConfig } from "./config.ts";
// SPDX-License-Identifier: MPL-2.0
// Local-only CLI. Generation is performed by the companion agent skill.
type Icon = {
  id: string;
  name: string;
  bundleId: string;
  style: string;
  png: string;
  icns: string;
  sha256: { png: string; icns: string };
  protected: boolean;
  rights: { owner: string; status: string };
  provenance: { provider: string; generatedOn: string };
};
type Catalog = { version: number; icons: Icon[] };
type App = { path: string; bundleId: string; name: string; version: string; runningPids: number[] };
type Backup = {
  version: 1;
  app: App;
  finderInfo: string | null;
  hadCustomIcon: boolean;
  originalPng: string;
  originalSha256: string;
  capturedAt: string;
};
const sourceRoot = decodeURIComponent(new URL("../", import.meta.url).pathname).replace(/\/$/, "");
const config = await loadConfig(sourceRoot);
const args = [...Deno.args];
function option(name: string, fallback?: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return fallback;
  if (!args[i + 1] || args[i + 1].startsWith("--")) throw Error(`${name} needs a value`);
  return args.splice(i, 2)[1];
}
const catalogPath = option("--catalog", config.catalog ?? `${sourceRoot}/catalog.json`)!;
const assetsRoot = catalogPath.slice(0, catalogPath.lastIndexOf("/"));
const explicitApp = option("--app");
const stateRoot = option(
  "--state-dir",
  `${Deno.env.get("HOME")}/Library/Application Support/X-DockIcons`,
)!;
const addBundleId = option("--bundle-id"),
  addName = option("--name"),
  addOwner = option("--rights-owner");
const command = args.shift() ?? "help";
const id = args.shift();
const json = (value: unknown) => console.log(JSON.stringify(value, null, 2));
async function hash(path: string): Promise<string> {
  const bytes = await Deno.readFile(path);
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((n) =>
    n.toString(16).padStart(2, "0")
  ).join("");
}
async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return false;
    throw e;
  }
}
async function atomic(path: string, value: unknown) {
  const temp = `${path}.${crypto.randomUUID()}.tmp`;
  try {
    await Deno.writeTextFile(temp, JSON.stringify(value, null, 2) + "\n", {
      createNew: true,
      mode: 0o600,
    });
    await Deno.rename(temp, path);
  } finally {
    try {
      if (await exists(temp)) await Deno.remove(temp);
    } catch (error) {
      console.error(`Could not clean catalog temporary file ${temp}: ${String(error)}`);
    }
  }
}
async function processOutput(exe: string, argv: string[], allowFailure = false) {
  const child = new Deno.Command(exe, { args: argv, stdout: "piped", stderr: "piped" }).spawn();
  const timer = setTimeout(() => {
    try {
      child.kill("SIGKILL");
    } catch { /* Process may have exited. */ }
  }, 60000);
  try {
    const output = await child.output(),
      stdout = new TextDecoder().decode(output.stdout),
      stderr = new TextDecoder().decode(output.stderr);
    if (!output.success && !allowFailure) {
      throw Error(`${exe} failed (${output.code}): ${stderr.trim() || stdout.trim()}`);
    }
    return { code: output.code, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
}
async function helper(...argv: string[]): Promise<Record<string, unknown>> {
  if (Deno.build.os !== "darwin") {
    throw Error(
      "App discovery and custom icons require macOS. Catalog/check/prompt remain available offline.",
    );
  }
  const directory = `${sourceRoot}/.local`,
    binary = `${directory}/icon_tool`,
    source = `${sourceRoot}/src/icon_tool.swift`;
  await Deno.mkdir(directory, { recursive: true });
  const stamp = `${directory}/icon_tool.source-sha256`, digest = await hash(source);
  if (
    !await exists(binary) || !await exists(stamp) ||
    (await Deno.readTextFile(stamp)).trim() !== digest
  ) {
    const temp = `${binary}.${crypto.randomUUID()}`;
    try {
      await processOutput("/usr/bin/xcrun", ["swiftc", source, "-o", temp]);
      await Deno.rename(temp, binary);
      await Deno.writeTextFile(stamp, digest + "\n");
    } finally {
      if (await exists(temp)) await Deno.remove(temp);
    }
  }
  const mutation = argv[0] === "apply" || argv[0] === "clear";
  const result = mutation && (await processOutput("/bin/test", ["-w", argv[1]], true)).code !== 0
    ? await adminMetadata(argv[1], binary, argv, processOutput, config.adminHelper)
    : await processOutput(binary, argv);
  if (result.stderr.includes("sandbox_extension_issue_file failed")) {
    throw Error(
      "macOS icon service access denied by the execution sandbox; no icon readback can be trusted. Run this authorized operation with normal local permissions.",
    );
  }
  return JSON.parse(result.stdout);
}
async function catalog(): Promise<Catalog> {
  const value = JSON.parse(await Deno.readTextFile(catalogPath)) as Catalog;
  if (value.version !== 1 || !Array.isArray(value.icons)) throw Error("Unsupported catalog");
  const ids = new Set<string>();
  for (const item of value.icons) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(item.id) || ids.has(item.id)) {
      throw Error("Invalid/duplicate icon ID");
    }
    ids.add(item.id);
    if (!/^[A-Za-z0-9_.-]+$/.test(item.bundleId) || !item.name || item.style !== "nothing") {
      throw Error(`Invalid identity/style: ${item.id}`);
    }
    for (const kind of ["png", "icns"] as const) {
      if (
        item[kind] !== `icons/nothing/${item.id}.${kind}` ||
        !/^[a-f0-9]{64}$/.test(item.sha256[kind])
      ) throw Error(`Invalid asset path/hash: ${item.id}`);
    }
  }
  return value;
}
function select(value: Catalog): Icon {
  const item = value.icons.find((i) => i.id === id);
  if (!item) throw Error(`Unknown icon ${id ?? "(missing)"}; use ./dock-icons list`);
  return item;
}
async function validate(item: Icon) {
  for (const kind of ["png", "icns"] as const) {
    if (await hash(`${assetsRoot}/${item[kind]}`) !== item.sha256[kind]) {
      throw Error(`Checksum mismatch: ${item.id}.${kind}`);
    }
  }
  const bytes = await Deno.readFile(`${assetsRoot}/${item.png}`);
  if (bytes.length < 33 || [...bytes.slice(0, 8)].join() !== "137,80,78,71,13,10,26,10") {
    throw Error(`Invalid PNG: ${item.id}`);
  }
  const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    width = header.getUint32(16),
    height = header.getUint32(20);
  if (width !== height || width < 1024 || width > 4096 || ![4, 6].includes(bytes[25])) {
    throw Error(`Expected square 1024-4096px alpha PNG: ${item.id}`);
  }
}
async function appFor(item: Icon): Promise<App> {
  const resolved = explicitApp ?? (await helper("resolve", item.bundleId)).path as string;
  const app = await helper("inspect", resolved) as unknown as App;
  if (app.bundleId !== item.bundleId) {
    throw Error(`App identity mismatch: expected ${item.bundleId}, got ${app.bundleId}`);
  }
  return app;
}
async function finderInfo(path: string): Promise<string | null> {
  const result = await processOutput("/usr/bin/xattr", ["-px", "com.apple.FinderInfo", path], true);
  if (result.code === 0) {
    const value = result.stdout.replace(/\s/g, "").toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(value)) throw Error("Invalid FinderInfo readback");
    return value;
  }
  if (result.stderr.includes("No such xattr")) return null;
  throw Error(`Cannot read Finder metadata: ${result.stderr.trim()}`);
}
function hasCustom(info: string | null): boolean {
  return info !== null && (parseInt(info.slice(16, 20), 16) & 0x0400) !== 0;
}
async function location(app: App) {
  const digest = [
    ...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(app.path))),
  ].slice(0, 8).map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${stateRoot}/${app.bundleId}-${digest}`;
}
async function withStateLock(fn: () => Promise<void>) {
  await Deno.mkdir(stateRoot, { recursive: true, mode: 0o700 });
  const lock = `${stateRoot}/operation.lock`;
  try {
    await Deno.mkdir(lock);
  } catch (e) {
    if (e instanceof Deno.errors.AlreadyExists) {
      throw Error(
        "Another icon operation owns the state lock. Inspect it before recovery; do not delete an active lock.",
      );
    }
    throw e;
  }
  try {
    await fn();
  } finally {
    await Deno.remove(lock);
  }
}
function writable(item: Icon, app: App) {
  if (
    item.protected ||
    ["/System/", "/usr/", "/Library/Apple/System/"].some((p) => app.path.startsWith(p))
  ) {
    throw Error(
      "Protected Apple system app: preview/export only; system protection will not be bypassed.",
    );
  }
}
async function receipt(dir: string, value: unknown) {
  await Deno.writeTextFile(`${dir}/operations.jsonl`, JSON.stringify(value) + "\n", {
    append: true,
    mode: 0o600,
  });
}
async function signature(app: App) {
  return await processOutput("/usr/bin/codesign", ["--verify", "--deep", app.path], true);
}
function manualRefresh(app: App) {
  return {
    dockRestart: "manual",
    appRelaunch: "user-only-if-stale",
    runningApps: app.runningPids.length
      ? [{ name: app.name, appPath: app.path, pids: app.runningPids }]
      : [],
    displayVerified: false,
    instruction:
      "Restart Dock yourself. If an icon is still stale, save your work and reopen the listed App yourself. Commands never quit Apps or restart Dock.",
  };
}
async function mutate(item: Icon, app: App, action: "apply" | "restore" | "default") {
  writable(item, app);
  await withStateLock(async () => {
    const dir = await location(app), backupPath = `${dir}/backup.json`;
    await Deno.mkdir(dir, { recursive: true, mode: 0o700 });
    let backup: Backup;
    if (await exists(backupPath)) {
      backup = JSON.parse(await Deno.readTextFile(backupPath));
      if (
        backup.version !== 1 || backup.app.path !== app.path ||
        backup.app.bundleId !== app.bundleId || backup.originalPng !== `${dir}/original.png` ||
        await hash(backup.originalPng) !== backup.originalSha256
      ) throw Error("Backup identity/checksum mismatch");
      await helper("image-info", backup.originalPng);
    } else {
      if (action === "restore") {
        throw Error("No captured backup for this App path; nothing changed");
      }
      const info = await finderInfo(app.path), originalPng = `${dir}/original.png`;
      if (await exists(originalPng)) {
        throw Error(
          "Unrecorded backup image exists; inspect it before retry. App icon was not changed.",
        );
      }
      // Preserve an interrupted backup, including one created after the check.
      await withExclusiveOutput(originalPng, async (staged) => {
        await helper("export", app.path, staged);
      });
      backup = {
        version: 1,
        app,
        finderInfo: info,
        hadCustomIcon: hasCustom(info),
        originalPng,
        originalSha256: await hash(originalPng),
        capturedAt: new Date().toISOString(),
      };
      await atomic(backupPath, backup);
      // Read the durable backup before acknowledging it or changing the App.
      const persisted = JSON.parse(await Deno.readTextFile(backupPath)) as Backup;
      if (persisted.originalSha256 !== await hash(originalPng)) {
        throw Error("Backup persistence verification failed");
      }
    }
    const operationId = crypto.randomUUID(),
      beforeSignature = await signature(app),
      startedAt = new Date().toISOString();
    await receipt(dir, { operationId, action, iconId: item.id, app, phase: "prepared", startedAt });
    try {
      const beforeInfo = await finderInfo(app.path);
      const unchanged = action === "apply"
        ? (await helper("compare", app.path, `${assetsRoot}/${item.png}`)).matches === true
        : action === "restore" && backup.hadCustomIcon
        ? hasCustom(beforeInfo) &&
          (await helper("compare", app.path, backup.originalPng)).matches === true
        : !hasCustom(beforeInfo);
      if (action === "apply" && !unchanged) {
        try {
          await helper("apply", app.path, `${assetsRoot}/${item.png}`);
        } catch (error) {
          if (
            String(error).includes("setIcon returned false") &&
            (await processOutput("/bin/test", ["-w", app.path], true)).code !== 0
          ) {
            throw Error(
              "App icon metadata is not writable by the current user; local administrator authentication is required. Original backup is retained. " +
                String(error),
            );
          }
          throw error;
        }
      } else if (action === "restore" && backup.hadCustomIcon) {
        if (!unchanged) await helper("apply", app.path, backup.originalPng);
      } else if (action === "restore" || action === "default") {
        if (!unchanged) await helper("clear", app.path);
        const current = await finderInfo(app.path);
        // Remove only metadata created by us that is now entirely empty.
        if (backup.finderInfo === null && current === "0".repeat(64)) {
          const remove = ["-d", "com.apple.FinderInfo", app.path];
          if ((await processOutput("/bin/test", ["-w", app.path], true)).code !== 0) {
            await adminMetadata(
              app.path,
              "/usr/bin/xattr",
              remove,
              processOutput,
              config.adminHelper,
            );
          } else await processOutput("/usr/bin/xattr", remove);
        }
      }
      const info = await finderInfo(app.path),
        expectedCustom = unchanged
          ? hasCustom(beforeInfo)
          : action === "apply" || (action === "restore" && backup.hadCustomIcon);
      if (hasCustom(info) !== expectedCustom) throw Error("Custom-icon flag readback disagrees");
      const readback = `${dir}/${operationId}.png`;
      await helper("export", app.path, readback);
      const updatedDefault =
        (action === "restore" && !backup.hadCustomIcon || action === "default") &&
        (app.version !== backup.app.version || backup.hadCustomIcon);
      const comparison = updatedDefault
        ? {
          matches: null,
          reason:
            "Current built-in default; captured baseline is a different version or custom icon",
        }
        : await helper(
          "compare",
          app.path,
          action === "apply" ? `${assetsRoot}/${item.png}` : backup.originalPng,
        );
      if (!updatedDefault && comparison.matches !== true) {
        throw Error(`Installed icon readback mismatch: ${comparison.normalizedMeanError}`);
      }
      const afterSignature = await signature(app);
      if (beforeSignature.code === 0 && afterSignature.code !== 0) {
        throw Error(`Normal signature verification regressed: ${afterSignature.stderr}`);
      }
      const result = {
        operationId,
        action,
        unchanged,
        iconId: item.id,
        app,
        phase: "completed",
        verificationScope: "stored-icon-only",
        completedAt: new Date().toISOString(),
        finderInfo: info,
        readback,
        readbackSha256: await hash(readback),
        comparison,
        signatureBefore: beforeSignature.code,
        signatureAfter: afterSignature.code,
        dockVerified: false,
        refresh: manualRefresh(await helper("inspect", app.path) as unknown as App),
      };
      await receipt(dir, result);
      await atomic(`${dir}/last-operation.json`, result);
      json(result);
    } catch (error) {
      await receipt(dir, {
        operationId,
        action,
        iconId: item.id,
        app,
        phase: "failed",
        failedAt: new Date().toISOString(),
        error: String(error),
        refresh: manualRefresh(app),
      });
      throw error;
    }
  });
}
async function pack(png: string, output: string) {
  const info = await helper("image-info", png);
  if (Number(info.width) < 1024 || info.hasAlpha !== true || info.transparentCorners !== true) {
    throw Error("Expected a square >=1024px PNG with real transparent corners");
  }
  const temp = await Deno.makeTempDir({ prefix: "dock-icons-" }), iconset = `${temp}/asset.iconset`;
  try {
    await Deno.mkdir(iconset);
    for (const size of [16, 32, 128, 256, 512]) {
      for (const scale of [1, 2]) {
        const pixels = `${size * scale}`, suffix = scale === 2 ? "@2x" : "";
        await processOutput("/usr/bin/sips", [
          "-z",
          pixels,
          pixels,
          png,
          "--out",
          `${iconset}/icon_${size}x${size}${suffix}.png`,
        ]);
      }
    }
    await processOutput("/usr/bin/iconutil", ["-c", "icns", iconset, "-o", output]);
    const decoded = `${temp}/decoded.iconset`;
    await processOutput("/usr/bin/iconutil", ["-c", "iconset", output, "-o", decoded]);
    let count = 0;
    for await (const file of Deno.readDir(decoded)) if (file.name.endsWith(".png")) count++;
    if (count !== 10) throw Error("ICNS readback did not contain ten sizes");
  } finally {
    await Deno.remove(temp, { recursive: true });
  }
}
async function addIcon(value: Catalog): Promise<Icon> {
  if (
    !id || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id) || value.icons.some((x) => x.id === id) ||
    !/^[A-Za-z0-9_.-]+$/.test(addBundleId ?? "") || !addName || !addOwner || args.length !== 1
  ) throw Error("add needs a new ID, one PNG, --bundle-id, --name and --rights-owner");
  const source = await Deno.realPath(args[0]);
  if ((await Deno.stat(source)).size > 15 * 1024 * 1024) throw Error("PNG exceeds 15 MiB");
  const png = `icons/nothing/${id}.png`, icns = `icons/nothing/${id}.icns`;
  if (await exists(`${assetsRoot}/${png}`) || await exists(`${assetsRoot}/${icns}`)) {
    throw Error("Asset already exists; choose a new ID");
  }
  await Deno.mkdir(`${assetsRoot}/icons/nothing`, { recursive: true });
  const icnsPath = `${assetsRoot}/${icns}`, pngPath = `${assetsRoot}/${png}`;
  let pngCreated = false, icnsCreated = false;
  try {
    await withExclusiveOutput(icnsPath, (temp) => pack(source, temp));
    icnsCreated = true;
    await withExclusiveOutput(pngPath, (temp) => Deno.copyFile(source, temp));
    pngCreated = true;
    const item: Icon = {
      id,
      name: addName,
      bundleId: addBundleId!,
      style: "nothing",
      png,
      icns,
      sha256: {
        png: await hash(`${assetsRoot}/${png}`),
        icns: await hash(`${assetsRoot}/${icns}`),
      },
      protected: addBundleId!.startsWith("com.apple."),
      rights: { owner: addOwner, status: "third-party-rights-not-granted" },
      provenance: { provider: "Owner-supplied image", generatedOn: "unknown" },
    };
    value.icons.push(item);
    await atomic(catalogPath, value);
    return item;
  } catch (error) {
    if (pngCreated || icnsCreated) {
      throw Error(
        `Add incomplete; created assets may remain at ${pngPath} and ${icnsPath}. Inspect before retry. Cause: ${
          String(error)
        }`,
      );
    }
    throw error;
  }
}
async function main() {
  if (command === "help") {
    console.log(
      "X-DockIcons 0.1.0\n./dock-icons list | check | prompt [ID]\n./dock-icons status|export|apply|restore|default ID [--app /path/Name.app] [--state-dir /path]\n./dock-icons default ID clears to the current built-in icon; restore returns the captured baseline.\n./dock-icons export ID OUTPUT.png\n./dock-icons add ID IMAGE.png --bundle-id ID --name NAME --rights-owner OWNER\n--catalog /absolute/catalog.json selects a separate collection. App actions require macOS + Xcode Command Line Tools. No App is quit or relaunched.",
    );
    return;
  }
  if (command === "add") {
    const catalogInfo = await Deno.lstat(catalogPath);
    if (!catalogInfo.isFile || (catalogInfo.nlink !== null && catalogInfo.nlink > 1)) {
      throw Error("Catalog must be a regular file without hard-link aliases for add");
    }
    let added: Icon | undefined;
    await withCatalogLock(await Deno.realPath(catalogPath), async () => {
      const value = await catalog();
      added = await addIcon(value);
    });
    json(added);
    return;
  }
  const value = await catalog();
  if (command === "list") {
    if (id || args.length) throw Error("list takes no arguments");
    json(
      value.icons.map(({ id, name, bundleId, protected: previewOnly, rights }) => ({
        id,
        name,
        bundleId,
        previewOnly,
        rights,
      })),
    );
    return;
  }
  if (command === "check") {
    if (id || args.length) throw Error("check takes no arguments");
    for (const item of value.icons) await validate(item);
    json({ verified: value.icons.length, files: value.icons.length * 2, version: "0.1.0" });
    return;
  }
  if (command === "prompt") {
    const style = JSON.parse(
      await Deno.readTextFile(config.style ?? `${sourceRoot}/styles/nothing/style.json`),
    );
    json({ style, app: id ? select(value) : null });
    return;
  }
  const item = select(value);
  if (!["status", "export", "apply", "restore", "default"].includes(command)) {
    throw Error(`Unknown command ${command}`);
  }
  if (args.length !== (command === "export" ? 1 : 0)) throw Error("Unexpected arguments");
  if (command === "apply") {
    await validate(item);
    await helper("image-info", `${assetsRoot}/${item.png}`);
  }
  const app = await appFor(item);
  if (command === "status") {
    const info = await finderInfo(app.path), dir = await location(app);
    json({
      iconId: item.id,
      app,
      customIcon: hasCustom(info),
      backupAvailable: await exists(`${dir}/backup.json`),
      dockVerified: false,
      refresh: manualRefresh(app),
    });
    return;
  }
  if (command === "export") {
    await withExclusiveOutput(args[0], async (temp) => {
      await helper("export", app.path, temp);
    });
    json({ app, saved: args[0], sha256: await hash(args[0]) });
    return;
  }
  await mutate(item, app, command as "apply" | "restore" | "default");
}
if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(String(error));
    Deno.exit(1);
  }
}
