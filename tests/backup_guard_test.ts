// SPDX-License-Identifier: MPL-2.0
// An interrupted backup must never be replaced by the next App operation.
Deno.test({
  name: "apply preserves an orphaned backup and does not change the App",
  ignore: Deno.build.os !== "darwin",
  async fn() {
    const root = await Deno.makeTempDir({ prefix: "dock-backup-guard-" });
    try {
      await Deno.mkdir(`${root}/src`, { recursive: true });
      await Deno.mkdir(`${root}/.local`, { recursive: true });
      await Deno.mkdir(`${root}/icons/nothing`, { recursive: true });
      const app = `${root}/Fixture.app`, state = `${root}/state`;
      await Deno.mkdir(app);
      for (const name of ["cli.ts", "admin.ts", "safe_output.ts", "icon_tool.swift"]) {
        await Deno.copyFile(new URL(`../src/${name}`, import.meta.url), `${root}/src/${name}`);
      }
      const digest = async (data: Uint8Array<ArrayBuffer>) =>
        [...new Uint8Array(await crypto.subtle.digest("SHA-256", data))].map((b) =>
          b.toString(16).padStart(2, "0")
        ).join("");
      const stamp = await digest(await Deno.readFile(`${root}/src/icon_tool.swift`));
      await Deno.writeTextFile(`${root}/.local/icon_tool.source-sha256`, stamp + "\n");
      const stub = `${root}/stub.ts`;
      await Deno.writeTextFile(
        stub,
        `
const [command, ...args] = Deno.args;
if (command === "image-info") console.log(JSON.stringify({width:1024,height:1024,hasAlpha:true,transparentCorners:true}));
else if (command === "inspect") console.log(JSON.stringify({path:args[0],bundleId:"dev.example.guard",name:"Fixture",version:"1",runningPids:[]}));
else if (command === "export") { await Deno.writeTextFile(args[1], "replacement"); console.log(JSON.stringify({saved:args[1]})); }
else if (command === "compare") console.log(JSON.stringify({matches:false,normalizedMeanError:1}));
else if (command === "apply") { await Deno.writeTextFile(Deno.env.get("DOCK_FIXTURE_MARKER")!, "changed"); console.log(JSON.stringify({applied:true})); }
else Deno.exit(2);
`,
      );
      const shell = '#!/bin/sh\nexec "$DOCK_FIXTURE_DENO" run -A "$DOCK_FIXTURE_STUB" "$@"\n';
      await Deno.writeTextFile(`${root}/.local/icon_tool`, shell, { mode: 0o755 });
      await Deno.chmod(`${root}/.local/icon_tool`, 0o755);
      const png = new Uint8Array(33);
      png.set([137, 80, 78, 71, 13, 10, 26, 10]);
      new DataView(png.buffer).setUint32(16, 1024);
      new DataView(png.buffer).setUint32(20, 1024);
      png[25] = 6;
      const icns = new TextEncoder().encode("synthetic icon");
      await Deno.writeFile(`${root}/icons/nothing/fixture.png`, png);
      await Deno.writeFile(`${root}/icons/nothing/fixture.icns`, icns);
      await Deno.writeTextFile(
        `${root}/catalog.json`,
        JSON.stringify({
          version: 1,
          icons: [{
            id: "fixture",
            name: "Fixture",
            bundleId: "dev.example.guard",
            style: "nothing",
            png: "icons/nothing/fixture.png",
            icns: "icons/nothing/fixture.icns",
            sha256: { png: await digest(png), icns: await digest(icns) },
            protected: false,
            rights: { owner: "Synthetic", status: "fixture" },
            provenance: { provider: "Synthetic", generatedOn: "unknown" },
          }],
        }),
      );
      const appPath = await Deno.realPath(app);
      const appKey = (await digest(new TextEncoder().encode(appPath))).slice(0, 16);
      const backupDir = `${state}/dev.example.guard-${appKey}`;
      await Deno.mkdir(backupDir, { recursive: true });
      const original = `${backupDir}/original.png`, marker = `${root}/applied`;
      await Deno.writeTextFile(original, "orphaned baseline");
      const result = await new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          "-A",
          `${root}/src/cli.ts`,
          "--catalog",
          `${root}/catalog.json`,
          "--state-dir",
          state,
          "--app",
          appPath,
          "apply",
          "fixture",
        ],
        env: {
          DOCK_FIXTURE_DENO: Deno.execPath(),
          DOCK_FIXTURE_STUB: stub,
          DOCK_FIXTURE_MARKER: marker,
        },
        cwd: root,
        stdout: "piped",
        stderr: "piped",
      }).output();
      const error = new TextDecoder().decode(result.stderr);
      if (result.success || !error.includes("Unrecorded backup image exists")) {
        throw Error(`Expected a visible interrupted-backup refusal: ${error}`);
      }
      if (await Deno.readTextFile(original) !== "orphaned baseline") {
        throw Error("Interrupted backup was replaced");
      }
      for (const forbidden of [marker, `${backupDir}/backup.json`]) {
        try {
          await Deno.lstat(forbidden);
          throw Error(`Unexpected write: ${forbidden}`);
        } catch (error) {
          if (!(error instanceof Deno.errors.NotFound)) throw error;
        }
      }
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});
