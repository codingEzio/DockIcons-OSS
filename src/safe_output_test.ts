// SPDX-License-Identifier: MPL-2.0
import { withCatalogLock, withExclusiveOutput } from "./safe_output.ts";

Deno.test("competing outputs never replace the winner", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const path = `${dir}/icon.png`;
    let ready = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => release = resolve);
    const run = (value: string) =>
      withExclusiveOutput(path, async (staged) => {
        await Deno.writeTextFile(staged, value, { createNew: true });
        if (++ready === 2) release();
        await gate;
      });
    const results = await Promise.allSettled([run("first"), run("second")]);
    if (results.filter((r) => r.status === "fulfilled").length !== 1) {
      throw Error("expected one winner");
    }
    if (!["first", "second"].includes(await Deno.readTextFile(path))) throw Error("winner lost");
    const names = [];
    for await (const item of Deno.readDir(dir)) names.push(item.name);
    if (names.join() !== "icon.png") throw Error("staging was not cleaned");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("catalog lock rejects a concurrent writer and releases after failure", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const path = `${dir}/catalog.json`;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => release = resolve);
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => entered = resolve);
    const first = withCatalogLock(path, async () => {
      entered();
      await gate;
    });
    await ready;
    let refused = false;
    try {
      await withCatalogLock(path, () => {
        throw Error("must not enter");
      });
    } catch {
      refused = true;
    }
    if (!refused) throw Error("concurrent lock accepted");
    release();
    await first;
    try {
      await withCatalogLock(path, () => {
        throw Error("fixture");
      });
    } catch { /* expected */ }
    await withCatalogLock(path, async () => {});
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("existing files and dangling symlinks are not replaced", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const existing = `${dir}/existing.png`, dangling = `${dir}/dangling.png`;
    await Deno.writeTextFile(existing, "sentinel", { createNew: true });
    await Deno.symlink(`${dir}/missing`, dangling);
    for (const path of [existing, dangling]) {
      let refused = false;
      try {
        await withExclusiveOutput(
          path,
          (staged) => Deno.writeTextFile(staged, "replacement", { createNew: true }),
        );
      } catch {
        refused = true;
      }
      if (!refused) throw Error("existing entry replaced");
    }
    if (await Deno.readTextFile(existing) !== "sentinel") throw Error("existing content changed");
    if (!(await Deno.lstat(dangling)).isSymlink) throw Error("symlink changed");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("actual add commands refuse a competing catalog writer without touching synthetic data", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const path = `${dir}/catalog.json`, input = `${dir}/sample.png`;
    const original = '{"version":1,"icons":[]}\n';
    await Deno.writeTextFile(path, original, { createNew: true });
    await Deno.writeTextFile(input, "synthetic", { createNew: true });
    let entered!: () => void, release!: () => void;
    const ready = new Promise<void>((resolve) => entered = resolve);
    const gate = new Promise<void>((resolve) => release = resolve);
    const holder = withCatalogLock(await Deno.realPath(path), async () => {
      entered();
      await gate;
    });
    await ready;
    const cli = new URL("./cli.ts", import.meta.url).pathname;
    const run = (id: string) =>
      new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          "-A",
          cli,
          "--catalog",
          path,
          "add",
          id,
          input,
          "--bundle-id",
          `org.example.${id}`,
          "--name",
          id,
          "--rights-owner",
          "fixture",
        ],
        stdout: "piped",
        stderr: "piped",
      }).output();
    const outputs = await Promise.all([run("same"), run("same"), run("different")]);
    if (
      outputs.some((o) =>
        o.success || !new TextDecoder().decode(o.stderr).includes("Catalog is locked")
      )
    ) throw Error("an add bypassed the lock");
    if (await Deno.readTextFile(path) !== original) throw Error("catalog changed");
    release();
    await holder;
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("actual add rejects a catalog symlink before packaging", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const path = `${dir}/catalog.json`, alias = `${dir}/alias.json`, input = `${dir}/sample.png`;
    const original = '{"version":1,"icons":[]}\n';
    await Deno.writeTextFile(path, original, { createNew: true });
    await Deno.symlink(path, alias);
    await Deno.writeTextFile(input, "synthetic", { createNew: true });
    const cli = new URL("./cli.ts", import.meta.url).pathname;
    const result = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "-A",
        cli,
        "--catalog",
        alias,
        "add",
        "fixture",
        input,
        "--bundle-id",
        "org.example.fixture",
        "--name",
        "fixture",
        "--rights-owner",
        "fixture",
      ],
      stdout: "piped",
      stderr: "piped",
    }).output();
    if (
      result.success ||
      !new TextDecoder().decode(result.stderr).includes("Catalog must be a regular file")
    ) throw Error("symlink was not refused");
    if (!(await Deno.lstat(alias)).isSymlink || await Deno.readTextFile(path) !== original) {
      throw Error("catalog or alias changed");
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("actual add rejects a multiply linked catalog", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const path = `${dir}/catalog.json`, alias = `${dir}/alias.json`, input = `${dir}/sample.png`;
    const original = '{"version":1,"icons":[]}\n';
    await Deno.writeTextFile(path, original, { createNew: true });
    await Deno.link(path, alias);
    await Deno.writeTextFile(input, "synthetic", { createNew: true });
    const cli = new URL("./cli.ts", import.meta.url).pathname;
    const result = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "-A",
        cli,
        "--catalog",
        alias,
        "add",
        "fixture",
        input,
        "--bundle-id",
        "org.example.fixture",
        "--name",
        "fixture",
        "--rights-owner",
        "fixture",
      ],
      stdout: "piped",
      stderr: "piped",
    }).output();
    if (
      result.success ||
      !new TextDecoder().decode(result.stderr).includes("Catalog must be a regular file")
    ) throw Error("hard link was not refused");
    if (await Deno.readTextFile(path) !== original || await Deno.readTextFile(alias) !== original) {
      throw Error("catalog changed");
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
