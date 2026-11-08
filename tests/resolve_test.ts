// SPDX-License-Identifier: MPL-2.0
Deno.test({
  name: "discovery combines registered and direct installs and refuses ambiguity",
  ignore: Deno.build.os !== "darwin",
  async fn() {
    const root = await Deno.makeTempDir({ prefix: "dock-resolve-" });
    try {
      const binary = `${root}/helper`;
      const source = new URL("../src/icon_tool.swift", import.meta.url).pathname;
      const build = await new Deno.Command("/usr/bin/xcrun", {
        args: ["swiftc", source, "-o", binary],
        stdout: "piped",
        stderr: "piped",
      }).output();
      if (!build.success) throw Error(new TextDecoder().decode(build.stderr));
      const a = `${root}/apps`, b = `${root}/user`, outside = `${root}/outside`;
      for (const dir of [a, b, outside]) await Deno.mkdir(dir);
      const bundle = async (path: string, id: string) => {
        await Deno.mkdir(`${path}/Contents`, { recursive: true });
        await Deno.writeTextFile(
          `${path}/Contents/Info.plist`,
          `<?xml version="1.0"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${id}</string></dict></plist>`,
        );
      };
      const first = `${a}/One.app`,
        second = `${b}/Two.app`,
        nested = `${b}/Nested/Three.app`,
        other = `${outside}/Outside.app`;
      await bundle(first, "example.fixture");
      await bundle(other, "example.fixture");
      const run = async (...registered: string[]) => {
        const result = await new Deno.Command(binary, {
          args: ["resolve-fixture", "example.fixture", a, b, "--", ...registered],
          stdout: "piped",
          stderr: "piped",
        }).output();
        return {
          ok: result.success,
          out: new TextDecoder().decode(result.stdout),
          err: new TextDecoder().decode(result.stderr),
        };
      };
      const absent = await new Deno.Command(binary, {
        args: ["resolve-fixture", "example.missing", a, b, "--"],
        stdout: "piped",
        stderr: "piped",
      }).output();
      if (absent.success || !new TextDecoder().decode(absent.stderr).includes("App not found")) {
        throw Error("missing App did not fail");
      }
      const one = await run(first, other);
      if (!one.ok || JSON.parse(one.out).path !== first) {
        throw Error("single registered/direct identity failed");
      }
      await Deno.symlink(first, `${b}/Alias.app`);
      if (!(await run(first)).ok) throw Error("same canonical App was counted twice");
      await bundle(second, "example.fixture");
      const duplicate = await run(first);
      if (duplicate.ok || !duplicate.err.includes("specify --app")) {
        throw Error("duplicate direct install did not fail");
      }
      await Deno.remove(second, { recursive: true });
      await bundle(nested, "example.fixture");
      const registered = await run(first, nested);
      if (registered.ok || !registered.err.includes("specify --app")) {
        throw Error("registered nested install did not fail");
      }
      const wrong = `${b}/Wrong.app`;
      await bundle(wrong, "example.other");
      if (!(await run(first, wrong)).ok) throw Error("wrong bundle identity counted");
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});
