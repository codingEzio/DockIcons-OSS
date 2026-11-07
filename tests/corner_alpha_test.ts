// SPDX-License-Identifier: MPL-2.0
// Exercise the native image validator with synthetic alpha data; no App icon writes.
Deno.test({
  name: "native image validation requires every corner to be transparent",
  ignore: Deno.build.os !== "darwin",
  async fn() {
    const root = await Deno.makeTempDir({ prefix: "dock-corner-alpha-" });
    try {
      const binary = `${root}/icon-tool`;
      const source = new URL("../src/icon_tool.swift", import.meta.url).pathname;
      const build = await new Deno.Command("/usr/bin/xcrun", {
        args: ["swiftc", source, "-o", binary],
        stdout: "piped",
        stderr: "piped",
      }).output();
      if (!build.success) throw Error(new TextDecoder().decode(build.stderr));
      const images = [
        [
          "all",
          "iVBORw0KGgoAAAANSUhEUgAAAAMAAAADCAYAAABWKLW/AAAAIUlEQVR4nGNgAIIotxP/QTSDRt6J/1FA3JMHFYiaBmEAAO5HDMzUydt5" +
          "AAAAAElFTkSuQmCC",
          true,
        ],
        [
          "one",
          "iVBORw0KGgoAAAANSUhEUgAAAAMAAAADCAYAAABWKLW/AAAAJElEQVR4nGNgAIIotxP/e4CYQSPvxP8oIO7JA3GmATlA3APEAFcLFNMt8cvoAAAAAElFTkSuQmCC",
          false,
        ],
      ] as const;
      for (const [name, encoded, expected] of images) {
        const path = `${root}/${name}.png`;
        await Deno.writeFile(path, Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0)));
        const result = await new Deno.Command(binary, {
          args: ["image-info", path],
          stdout: "piped",
          stderr: "piped",
        }).output();
        if (!result.success) throw Error(new TextDecoder().decode(result.stderr));
        const info = JSON.parse(new TextDecoder().decode(result.stdout));
        if (info.transparentCorners !== expected) {
          throw Error(`Wrong corner validation for ${name}`);
        }
      }
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});
