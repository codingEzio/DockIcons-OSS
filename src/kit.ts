// SPDX-License-Identifier: MPL-2.0
import { loadConfig } from "./config.ts";
// Kit adapter: the existing CLI remains the authority for backup, identity and mutation.
export type IconTarget = {
  id: string;
  name: string;
  bundleId: string;
  style: string;
  protected: boolean;
  preferred?: boolean;
  aliases?: string[];
};
const root = decodeURIComponent(new URL("../", import.meta.url).pathname).replace(/\/$/, "");
const normalize = (value: string) =>
  value.normalize("NFKC").toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
export function preferredTargets(icons: IconTarget[]): IconTarget[] {
  const groups = new Map<string, IconTarget[]>();
  for (const icon of icons) {
    if (icon.preferred !== undefined && typeof icon.preferred !== "boolean") {
      throw Error(`Invalid preferred value: ${icon.id}`);
    }
    const key = JSON.stringify([icon.style, icon.bundleId]);
    groups.set(key, [...(groups.get(key) ?? []), icon]);
  }
  return [...groups.values()].map((group) => {
    if (group.length === 1) return group[0];
    const preferred = group.filter((icon) => icon.preferred === true);
    if (preferred.length !== 1) {
      throw Error(
        `Choose exactly one preferred variant for ${group[0].bundleId}; nothing changed.`,
      );
    }
    return preferred[0];
  });
}
export function resolveTargets(icons: IconTarget[], query: string): IconTarget[] {
  const needle = normalize(query);
  if (!needle) return [];
  const explicit = icons.filter((icon) => normalize(icon.id) === needle);
  if (explicit.length) return explicit;
  const keys = (icon: IconTarget) =>
    [icon.id, icon.name, icon.bundleId, ...(icon.aliases ?? [])].map(normalize);
  const exact = icons.filter((icon) => keys(icon).includes(needle));
  const matches = exact.length
    ? exact
    : icons.filter((icon) => keys(icon).some((key) => key.includes(needle)));
  return preferredTargets(
    icons.filter((icon) =>
      matches.some((match) => match.bundleId === icon.bundleId && match.style === icon.style)
    ),
  );
}
const actions = ["on", "off", "list", "status", "apply", "restore"];
const usage = `kit dock-icon [nothing] [on|off|list|status|apply|restore] [App words] [--plan]
  kit dock-icon on                        All on: preferred Nothing icons for installed Apps
  kit dock-icon off                       All off: current built-in App defaults
  kit dock-icon nothing apply             Apply to every installed, nonprotected catalog App
  kit dock-icon nothing apply local send  Match names, IDs, bundle IDs or aliases
  kit dock-icon nothing apply --plan      Inspect targets without changing icons
  kit dock-icon nothing restore cursor   Restore the captured original
  No arguments: select style, action and target with fzf in a terminal.
  Ambiguous matches stop before changes. Protected system Apps are preview/export only.
  --state-dir PATH forwards the existing CLI backup location; default remains unchanged.
  --catalog PATH uses an isolated collection; --app PATH requires one selected App identity.`;
async function cli(args: string[]) {
  const child = new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", `${root}/src/cli.ts`, ...args],
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const timer = setTimeout(() => {
    try {
      child.kill("SIGKILL");
    } catch { /* Already exited. */ }
  }, 120000);
  try {
    const result = await child.output();
    return {
      code: result.code,
      stdout: new TextDecoder().decode(result.stdout),
      stderr: new TextDecoder().decode(result.stderr),
    };
  } finally {
    clearTimeout(timer);
  }
}
async function choose(prompt: string, choices: string[]): Promise<string> {
  const child = new Deno.Command("fzf", {
    args: ["--prompt", prompt, "--height=40%", "--layout=reverse", "--no-multi"],
    stdin: "piped",
    stdout: "piped",
    stderr: "inherit",
  }).spawn();
  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode(choices.join("\n") + "\n"));
  await writer.close();
  const result = await child.output();
  if (result.code === 1 || result.code === 130) throw Error("Selection cancelled; nothing changed");
  if (!result.success) {
    throw Error("fzf selection failed; use the explicit command shown by --help");
  }
  return new TextDecoder().decode(result.stdout).trim();
}
async function main() {
  const args = [...Deno.args];
  if (args.includes("--help") || args.includes("-h")) {
    console.log(usage);
    return;
  }
  function option(name: string) {
    const index = args.indexOf(name);
    if (index < 0) return undefined;
    if (!args[index + 1] || args[index + 1].startsWith("--")) {
      throw Error(`${name} needs a path`);
    }
    return args.splice(index, 2)[1];
  }
  const config = await loadConfig(root);
  const catalogPath = option("--catalog") ?? config.catalog ?? `${root}/catalog.json`;
  const explicitApp = option("--app");
  const value = JSON.parse(await Deno.readTextFile(catalogPath));
  if (value.version !== 1 || !Array.isArray(value.icons)) throw Error("Unsupported catalog");
  const icons = value.icons as IconTarget[];
  const styles = [...new Set(icons.map((icon) => icon.style))];
  if (args[0] === "--complete") {
    const mode = args[1];
    console.log(
      (mode === "entry"
        ? [...styles, ...actions]
        : mode === "styles"
        ? styles
        : mode === "actions"
        ? actions
        : icons.filter((icon) => icon.style === (args[2] ?? "nothing")).map((icon) => icon.id))
        .join("\n"),
    );
    return;
  }
  const planIndex = args.indexOf("--plan");
  const plan = planIndex >= 0;
  if (plan) args.splice(planIndex, 1);
  const forwarded: string[] = ["--catalog", catalogPath];
  const stateIndex = args.indexOf("--state-dir");
  if (stateIndex >= 0) {
    if (!args[stateIndex + 1] || args[stateIndex + 1].startsWith("--")) {
      throw Error("--state-dir needs a path");
    }
    forwarded.push(...args.splice(stateIndex, 2));
  }
  if (args.some((arg) => arg.startsWith("--"))) throw Error("Unknown option; see --help");
  const interactive = args.length === 0 && Deno.stdin.isTerminal() && Deno.stdout.isTerminal();
  if (args.length === 0 && !interactive) {
    console.log(usage);
    return;
  }
  const style = interactive
    ? await choose("Style > ", styles)
    : actions.includes(args[0]?.toLowerCase())
    ? "nothing"
    : args.shift()?.toLowerCase();
  if (!styles.includes(style!)) {
    throw Error(`Unknown style: ${style}. Available: ${styles.join(", ")}`);
  }
  const action = interactive || (!args.length && Deno.stdin.isTerminal())
    ? await choose("Action > ", actions)
    : args.shift()?.toLowerCase();
  if (!action) {
    console.log(usage);
    return;
  }
  if (!actions.includes(action)) {
    throw Error(`Unknown action: ${action}`);
  }
  const collection = icons.filter((icon) => icon.style === style);
  let query = args.join(" ").trim();
  if (interactive && action !== "list") {
    const picked = await choose("App > ", [
      "ALL installed nonprotected Apps",
      ...collection.map((icon) =>
        `${icon.id}\t${icon.name}${icon.protected ? " [preview only]" : ""}`
      ),
    ]);
    query = picked.startsWith("ALL ") ? "" : picked.split("\t")[0];
  }
  const targets = query ? resolveTargets(collection, query) : preferredTargets(collection);
  if (query && targets.length !== 1) {
    const candidates = targets.map((icon) => `${icon.id}\t${icon.name}\t${icon.bundleId}`).join(
      "\n",
    );
    throw Error(
      targets.length
        ? `Ambiguous App: ${query}\n${candidates}\nChoose an exact ID; nothing changed.`
        : `No catalog App matches: ${query}; nothing changed.`,
    );
  }
  if (action === "list") {
    console.log(JSON.stringify(targets, null, 2));
    return;
  }
  if (explicitApp && targets.length !== 1) {
    throw Error("--app requires one selected App identity; use an exact ID or isolated catalog.");
  }
  const operation = action === "on" ? "apply" : action === "off" ? "default" : action;
  // Complete discovery before any mutation; per-App CLI receipts own readback and recovery.
  let succeeded = 0;
  const ready: { icon: IconTarget; appPath: string }[] = [];
  const skipped: { id: string; reason: string }[] = [];
  const failed: { id: string; reason: string }[] = [];
  const runningApps = new Map<string, { name: string; appPath: string; pids: number[] }>();
  let refreshInstruction: string | undefined;
  for (const icon of targets) {
    if (icon.protected && action !== "status") {
      if (query) {
        throw Error(`${icon.name}: protected system App; preview/export only; nothing changed.`);
      }
      skipped.push({ id: icon.id, reason: "protected-preview-only" });
      continue;
    }
    const result = await cli([
      "status",
      icon.id,
      ...forwarded,
      ...(explicitApp ? ["--app", explicitApp] : []),
    ]);
    if (result.code !== 0) {
      const reason = result.stderr.trim() || result.stdout.trim();
      if (!query && reason.includes("App not found; specify --app")) {
        skipped.push({ id: icon.id, reason: "not-installed" });
      } else failed.push({ id: icon.id, reason });
      continue;
    }
    const status = JSON.parse(result.stdout);
    for (const running of status.refresh.runningApps) runningApps.set(running.appPath, running);
    refreshInstruction = status.refresh.instruction;
    if (action === "status") console.log(JSON.stringify(status));
    else if (
      ["/System/", "/usr/", "/Library/Apple/System/"].some((prefix) =>
        status.app.path.startsWith(prefix)
      )
    ) {
      if (query) throw Error(`${icon.name}: protected system App path; nothing changed.`);
      skipped.push({ id: icon.id, reason: "protected-preview-only" });
    } else if (operation === "default" && status.customIcon === false) {
      skipped.push({ id: icon.id, reason: "already-default" });
    } else ready.push({ icon, appPath: status.app.path });
  }
  // A discovery error is not absence; stop before writing any otherwise-ready App.
  if (failed.length && !plan && action !== "status") {
    console.log(
      JSON.stringify({ style, action, attempted: 0, succeeded: 0, skipped, failed }, null, 2),
    );
    Deno.exitCode = 1;
    return;
  }
  if (plan) {
    console.log(
      JSON.stringify(
        {
          style,
          action,
          plan: true,
          targets: ready.map(({ icon, appPath }) => ({ id: icon.id, name: icon.name, appPath })),
          skipped,
          failed,
        },
        null,
        2,
      ),
    );
  } else if (action !== "status") {
    for (const { icon, appPath } of ready) {
      const result = await cli([operation, icon.id, "--app", appPath, ...forwarded]);
      if (result.stdout.trim()) console.log(result.stdout.trim());
      if (result.code === 0) succeeded++;
      else {
        failed.push({ id: icon.id, reason: result.stderr.trim() || `CLI exit ${result.code}` });
      }
    }
    console.log(
      JSON.stringify(
        {
          style,
          action,
          attempted: ready.length,
          succeeded,
          verificationScope: "stored-icon-only",
          skipped,
          failed,
          dockVerified: false,
          refresh: {
            dockRestart: "manual",
            appRelaunch: "user-only-if-stale",
            runningApps: [...runningApps.values()],
            displayVerified: false,
            instruction: refreshInstruction,
          },
        },
        null,
        2,
      ),
    );
  } else console.log(JSON.stringify({ style, action, skipped, failed }, null, 2));
  if (failed.length || (query && skipped.some((item) => item.reason !== "already-default"))) {
    Deno.exitCode = 1;
  }
}
if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(String(error));
    Deno.exitCode = 1;
  }
}
