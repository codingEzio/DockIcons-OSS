// Inspect an explicit local review payload. This is not permission to publish.
type Policy = {
  files: string[];
  releaseBlockers: string[];
  packageKind?: string;
  sources?: Record<string, string>;
};
if (Deno.args.some((arg) => !["--export", "--release"].includes(arg))) {
  throw Error("Unknown option");
}
const policy: Policy = JSON.parse(await Deno.readTextFile("public-files.json"));
const hash = async (bytes: Uint8Array) =>
  Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes).buffer)))
    .map((n) => n.toString(16).padStart(2, "0")).join("");
const files = [...policy.files].sort();
if (!files.length || new Set(files).size !== files.length) throw Error("Invalid file list");
const records: {
  path: string;
  sourcePath: string;
  sha256: string;
  bytes: number;
  executable: boolean;
}[] = [];
const source = new Map<string, Uint8Array>();
for (const path of files) {
  if (
    path.startsWith("/") || path.includes("\\") ||
    path.split("/").some((p) =>
      !p || p === "." || p === ".." || p === ".git" || p === "Local" || p === ".local" ||
      p.startsWith(".env")
    )
  ) throw Error(`Unsafe payload path: ${path}`);
  const sourcePath = policy.sources?.[path] ?? path;
  if (
    sourcePath.startsWith("/") || sourcePath.includes("\\") ||
    sourcePath.split("/").some((p) =>
      !p || p === "." || p === ".." || p === ".git" || p === "Local" || p === ".local" ||
      p.startsWith(".env")
    )
  ) throw Error(`Unsafe source path: ${sourcePath}`);
  if (
    policy.packageKind === "tools-only" && (
      path.startsWith("icons/") || path.startsWith("docs/previews/") ||
      sourcePath.startsWith("icons/") || sourcePath.startsWith("docs/previews/") ||
      path === "docs/CATALOG.md" || /\.(png|icns|jpe?g|webp|gif|woff2?|ttf|otf)$/i.test(path)
    )
  ) throw Error(`Excluded artwork in tools-only payload: ${path}`);
  const parts = sourcePath.split("/");
  for (let i = 1; i <= parts.length; i++) {
    if ((await Deno.lstat(parts.slice(0, i).join("/"))).isSymlink) {
      throw Error(`Symlink in payload: ${path}`);
    }
  }
  const stat = await Deno.stat(sourcePath);
  if (!stat.isFile) throw Error(`Not a regular file: ${path}`);
  const bytes = await Deno.readFile(sourcePath);
  // Binary assets are verified by their normal owner checks and hashed here.
  if (!/\.(png|icns|woff2|ttf)$/i.test(path)) {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (
      policy.packageKind === "tools-only" && /\.svg$/i.test(path) &&
      /<image\b|<foreignObject\b|(?:xlink:)?href\s*=|data:/i.test(text)
    ) {
      throw Error(`Embedded or referenced image in tools-only SVG: ${path}`);
    }
    if (/\/(?:Users|home)\/[^\s/]+|[A-Z]:\\Users\\[^\s\\]+/.test(text)) {
      throw Error(`Personal absolute home path: ${path}`);
    }
    if (
      /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bgh[pousr]_[A-Za-z0-9]{30,}\b/.test(text)
    ) {
      throw Error(`Credential-shaped text: ${path}`);
    }
  }
  source.set(path, bytes);
  records.push({
    path,
    sourcePath,
    sha256: await hash(bytes),
    bytes: bytes.length,
    executable: !!((stat.mode ?? 0) & 0o111),
  });
}
if (policy.packageKind === "tools-only") {
  const decode = (path: string) => {
    const bytes = source.get(path);
    if (!bytes) throw Error(`Missing tools-only input: ${path}`);
    return JSON.parse(new TextDecoder().decode(bytes));
  };
  const catalog = decode("catalog.json"), style = decode("styles/nothing/style.json");
  if (catalog.version !== 1 || !Array.isArray(catalog.icons) || catalog.icons.length !== 0) {
    throw Error("Tools-only candidate must use an empty starter catalog");
  }
  if (!Array.isArray(style.references) || style.references.length !== 0) {
    throw Error("Tools-only style must not depend on excluded reference images");
  }
}
const seal = await hash(new TextEncoder().encode(JSON.stringify(records)));
const receipt = {
  schemaVersion: 1,
  scope: policy.packageKind === "tools-only"
    ? "tools-only-local-candidate; no-original-icon-artwork"
    : "local-review-only",
  seal,
  files: records,
  releaseBlockers: policy.releaseBlockers,
  limitations: [
    "Working files only; Git index/history and remote state require separate review.",
    "Pattern checks are not a complete secret or rights audit.",
  ],
};
if (Deno.args.includes("--release") && policy.releaseBlockers.length) {
  console.error("Release blocked: " + policy.releaseBlockers.join("; "));
  Deno.exit(1);
}
if (Deno.args.includes("--export")) {
  for (const directory of ["Local", "Local/public-candidates"]) {
    try {
      const stat = await Deno.lstat(directory);
      if (!stat.isDirectory || stat.isSymlink) throw Error(`Unsafe output directory: ${directory}`);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  }
  const output = `Local/public-candidates/${seal}`;
  const receiptText = JSON.stringify(receipt, null, 2) + "\n";
  let exists = false;
  try {
    const stat = await Deno.lstat(output);
    if (stat.isSymlink || !stat.isDirectory) throw Error("Unsafe candidate directory");
    exists = true;
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  if (!exists) {
    await Deno.mkdir(output, { recursive: true });
    for (const record of records) {
      const target = `${output}/${record.path}`;
      await Deno.mkdir(target.slice(0, target.lastIndexOf("/")), { recursive: true });
      await Deno.writeFile(target, source.get(record.path)!, {
        mode: (record.executable ? 0o755 : 0o644) & ~Deno.umask(),
        createNew: true,
      });
    }
    await Deno.writeTextFile(`${output}/candidate-receipt.json`, receiptText, { createNew: true });
  }
  const actual: string[] = [];
  const directories: string[] = [];
  const walk = async (base = "") => {
    for await (const entry of Deno.readDir(`${output}/${base}`)) {
      const path = base ? `${base}/${entry.name}` : entry.name;
      if (entry.isSymlink) throw Error(`Candidate symlink: ${path}`);
      if (entry.isDirectory) {
        directories.push(path);
        await walk(path);
      } else if (entry.isFile) actual.push(path);
      else throw Error(`Unexpected candidate entry: ${path}`);
    }
  };
  await walk();
  const expectedDirectories = new Set<string>();
  for (const path of files) {
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i++) expectedDirectories.add(parts.slice(0, i).join("/"));
  }
  if (
    JSON.stringify(actual.sort()) !== JSON.stringify([...files, "candidate-receipt.json"].sort()) ||
    JSON.stringify(directories.sort()) !== JSON.stringify([...expectedDirectories].sort())
  ) {
    throw Error("Candidate contains missing or unexpected entries; no files overwritten");
  }
  // Git tracks executability, not group/other read bits. Accept stricter umasks, never broader modes.
  const safeMode = (mode: number | null, executable: boolean) => {
    if (mode === null) return true;
    const bits = mode & 0o7777;
    const maximum = executable ? 0o755 : 0o644;
    const required = executable ? 0o500 : 0o400;
    return (bits & ~maximum) === 0 && (bits & required) === required;
  };
  for (const record of records) {
    const target = `${output}/${record.path}`;
    const stat = await Deno.stat(target);
    if (
      await hash(await Deno.readFile(target)) !== record.sha256 ||
      !safeMode(stat.mode, record.executable)
    ) {
      throw Error(`Candidate bytes/mode mismatch: ${record.path}; no files overwritten`);
    }
  }
  const receiptMode = (await Deno.stat(`${output}/candidate-receipt.json`)).mode;
  if (
    await Deno.readTextFile(`${output}/candidate-receipt.json`) !== receiptText ||
    !safeMode(receiptMode, false)
  ) {
    throw Error("Candidate receipt mismatch; no files overwritten");
  }
  console.log(`Candidate: ${output}`);
}
console.log(JSON.stringify(receipt, null, 2));
