const script = new URL("../scripts/public-check.ts", import.meta.url);
function assert(value: unknown, message: string): asserts value {
  if (!value) throw Error(message);
}
Deno.test("local candidate boundaries and exact readback", async () => {
  const directory = await Deno.makeTempDir({ prefix: "public-review-test-" });
  try {
    await Deno.copyFile(script, `${directory}/check.ts`);
    await Deno.writeTextFile(`${directory}/sample.txt`, "synthetic fixture\n");
    const policy = { files: ["sample.txt"], releaseBlockers: ["License review pending"] };
    const writePolicy = () =>
      Deno.writeTextFile(`${directory}/public-files.json`, JSON.stringify(policy));
    await writePolicy();
    const run = (...args: string[]) =>
      new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          "--allow-read",
          "--allow-write=Local",
          "--allow-sys=umask",
          "check.ts",
          ...args,
        ],
        cwd: directory,
        stdout: "piped",
        stderr: "piped",
      }).output();
    assert((await run()).success, "valid input must pass");
    assert(
      !(await run("--release", "--export")).success,
      "pending rights must block before export",
    );
    let created = false;
    try {
      await Deno.stat(`${directory}/Local`);
      created = true;
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    assert(!created, "blocked release must not create output");
    const result = await run("--export");
    assert(result.success, new TextDecoder().decode(result.stderr));
    const line = new TextDecoder().decode(result.stdout).split("\n")[0];
    const output = line.slice("Candidate: ".length);
    assert(
      await Deno.readTextFile(`${directory}/${output}/sample.txt`) === "synthetic fixture\n",
      "export bytes",
    );
    assert((await run("--export")).success, "identical candidate must be reusable");
    await Deno.writeTextFile(`${directory}/${output}/sample.txt`, "tampered");
    assert(!(await run("--export")).success, "tampered candidate must fail");
    assert(
      await Deno.readTextFile(`${directory}/${output}/sample.txt`) === "tampered",
      "tampered bytes must not be overwritten",
    );
    await Deno.writeTextFile(`${directory}/${output}/sample.txt`, "synthetic fixture\n");
    await Deno.chmod(`${directory}/${output}/sample.txt`, 0o755);
    assert(!(await run("--export")).success, "changed mode must fail");
    await Deno.chmod(`${directory}/${output}/sample.txt`, 0o644);
    await Deno.writeTextFile(`${directory}/${output}/extra.txt`, "extra");
    assert(!(await run("--export")).success, "unexpected candidate file must fail");
    await Deno.remove(`${directory}/${output}/extra.txt`);
    await Deno.writeTextFile(`${directory}/${output}/candidate-receipt.json`, "{}");
    assert(!(await run("--export")).success, "changed receipt must fail");
    await Deno.writeTextFile(
      `${directory}/sample.txt`,
      ["", "Users", "synthetic", "private"].join("/"),
    );
    assert(!(await run()).success, "home path must be rejected");
    policy.files = ["../sample.txt"];
    await writePolicy();
    assert(!(await run()).success, "traversal must be rejected");
    policy.files = ["link.txt"];
    await writePolicy();
    await Deno.symlink("sample.txt", `${directory}/link.txt`);
    assert(!(await run()).success, "input symlink must be rejected");
    policy.files = ["sample.txt"];
    await writePolicy();
    await Deno.writeTextFile(`${directory}/sample.txt`, "changed synthetic fixture\n");
    await Deno.remove(`${directory}/Local`, { recursive: true });
    await Deno.mkdir(`${directory}/outside`);
    await Deno.symlink("outside", `${directory}/Local`);
    assert(!(await run("--export")).success, "output symlink must be rejected");
    assert(!(await run("--unknown")).success, "unknown option must be rejected");
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("tools-only mapped starter excludes private artwork and image dependencies", async () => {
  const directory = await Deno.makeTempDir({ prefix: "dock-tools-review-" });
  try {
    await Deno.copyFile(script, `${directory}/check.ts`);
    await Deno.mkdir(`${directory}/reviewed`, { recursive: true });
    await Deno.writeTextFile(`${directory}/reviewed/catalog.json`, '{"version":1,"icons":[]}');
    await Deno.writeTextFile(`${directory}/reviewed/style.json`, '{"references":[]}');
    await Deno.writeTextFile(`${directory}/reviewed/README.md`, "Tools only\n");
    await Deno.writeTextFile(`${directory}/mark.svg`, '<svg xmlns="http://www.w3.org/2000/svg"/>');
    const policy = {
      packageKind: "tools-only",
      files: ["catalog.json", "styles/nothing/style.json", "README.md", "mark.svg"],
      sources: {
        "catalog.json": "reviewed/catalog.json",
        "styles/nothing/style.json": "reviewed/style.json",
        "README.md": "reviewed/README.md",
      } as Record<string, string>,
      releaseBlockers: ["No publication approval"],
    };
    const writePolicy = () =>
      Deno.writeTextFile(`${directory}/public-files.json`, JSON.stringify(policy));
    const run = (...args: string[]) =>
      new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          "--allow-read",
          "--allow-write=Local",
          "--allow-sys=umask",
          "check.ts",
          ...args,
        ],
        cwd: directory,
        stdout: "piped",
        stderr: "piped",
      }).output();
    await writePolicy();
    const result = await run("--export");
    assert(result.success, new TextDecoder().decode(result.stderr));
    const output = new TextDecoder().decode(result.stdout).split("\n")[0].slice(
      "Candidate: ".length,
    );
    assert(
      await Deno.readTextFile(`${directory}/${output}/README.md`) === "Tools only\n",
      "mapped README",
    );
    assert((await run("--export")).success, "mapped exact replay");
    assert(!(await run("--release")).success, "selection must not authorize publication");
    policy.files.push("icons/nothing/old.png");
    await writePolicy();
    assert(!(await run()).success, "old icon path must fail before reading the excluded input");
    policy.files.pop();
    await writePolicy();
    await Deno.writeTextFile(
      `${directory}/mark.svg`,
      '<svg><image href="data:image/png;base64,AA=="/></svg>',
    );
    assert(!(await run()).success, "SVG must not carry excluded raster content indirectly");
    await Deno.writeTextFile(`${directory}/mark.svg`, '<svg xmlns="http://www.w3.org/2000/svg"/>');
    await Deno.writeTextFile(`${directory}/reviewed/catalog.json`, '{"version":1,"icons":[{}]}');
    assert(!(await run()).success, "private collection manifest must not enter starter package");
    await Deno.writeTextFile(`${directory}/reviewed/catalog.json`, '{"version":1,"icons":[]}');
    await Deno.writeTextFile(
      `${directory}/reviewed/style.json`,
      '{"references":["icons/nothing/old.png"]}',
    );
    assert(!(await run()).success, "style must not depend on an excluded image");
    await Deno.writeTextFile(`${directory}/reviewed/style.json`, '{"references":[]}');
    policy.sources["README.md"] = "../private.txt";
    await writePolicy();
    assert(!(await run()).success, "mapped source traversal must be rejected");
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("export respects restrictive and standard umasks", async () => {
  for (const mask of ["022", "077"]) {
    const directory = await Deno.makeTempDir({ prefix: "dock-export-umask-" });
    try {
      await Deno.copyFile(script, `${directory}/check.ts`);
      await Deno.writeTextFile(`${directory}/sample.txt`, "synthetic fixture\n");
      await Deno.writeTextFile(`${directory}/tool.sh`, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      await Deno.chmod(`${directory}/tool.sh`, 0o755);
      await Deno.writeTextFile(
        `${directory}/public-files.json`,
        JSON.stringify({ files: ["sample.txt", "tool.sh"] }),
      );
      const run = async () =>
        await new Deno.Command("/bin/sh", {
          args: [
            "-c",
            'umask "$1"; exec "$2" run --allow-read --allow-write=Local --allow-sys=umask check.ts --export',
            "sh",
            mask,
            Deno.execPath(),
          ],
          cwd: directory,
          stdout: "piped",
          stderr: "piped",
        }).output();
      const first = await run();
      assert(first.success, new TextDecoder().decode(first.stderr));
      const output = new TextDecoder().decode(first.stdout).split("\n")[0].slice(
        "Candidate: ".length,
      );
      const mode = (await Deno.stat(`${directory}/${output}/sample.txt`)).mode! & 0o777;
      assert(mode === (mask === "077" ? 0o600 : 0o644), `unexpected mode ${mode.toString(8)}`);
      const exeMode = (await Deno.stat(`${directory}/${output}/tool.sh`)).mode! & 0o777;
      assert(
        exeMode === (mask === "077" ? 0o700 : 0o755),
        `unexpected executable mode ${exeMode.toString(8)}`,
      );
      assert((await run()).success, "restricted candidate must be reusable");
      await Deno.chmod(`${directory}/${output}/sample.txt`, 0o666);
      assert(!(await run()).success, "broadened write permissions must fail");
    } finally {
      await Deno.remove(directory, { recursive: true });
    }
  }
});

Deno.test("export rejects private instruction names even through nested aliases", async () => {
  const directory = await Deno.makeTempDir({ prefix: "dock-private-policy-" });
  try {
    await Deno.copyFile(script, `${directory}/check.ts`);
    await Deno.mkdir(`${directory}/nested`, { recursive: true });
    await Deno.writeTextFile(`${directory}/nested/safe.md`, "synthetic safe text\n");
    const run = async (policy: object) => {
      await Deno.writeTextFile(`${directory}/public-files.json`, JSON.stringify(policy));
      return await new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          "--allow-read",
          "--allow-write=Local",
          "--allow-sys=umask",
          "check.ts",
          "--export",
        ],
        cwd: directory,
        stdout: "piped",
        stderr: "piped",
      }).output();
    };
    const safe = await run({
      files: ["docs/result.md"],
      sources: { "docs/result.md": "nested/safe.md" },
    });
    assert(safe.success, new TextDecoder().decode(safe.stderr));
    const output = new TextDecoder().decode(safe.stdout).split("\n")[0].slice("Candidate: ".length);
    assert(
      await Deno.readTextFile(`${directory}/${output}/docs/result.md`) === "synthetic safe text\n",
      "safe alias export",
    );
    const nestedDestination = await run({ files: ["nested/AGENTS.md/safe.md"] });
    assert(
      !nestedDestination.success &&
        new TextDecoder().decode(nestedDestination.stderr).includes(
          "Private instruction payload path",
        ),
      "private directory component must fail",
    );
    const nestedSource = await run({
      files: ["docs/other.md"],
      sources: { "docs/other.md": "nested/CLAUDE.md/safe.md" },
    });
    assert(
      !nestedSource.success &&
        new TextDecoder().decode(nestedSource.stderr).includes("Private instruction source path"),
      "private directory source component must fail",
    );
    for (
      const name of [
        "AGENTS.md",
        "CLAUDE.md",
        "PLAN.md",
        "TASKS.md",
        "aGeNtS.Md",
        "ＡＧＥＮＴＳ.md",
      ]
    ) {
      await Deno.writeTextFile(`${directory}/nested/${name}`, "synthetic private instruction\n");
      const direct = await run({ files: [`nested/${name}`] });
      assert(
        !direct.success &&
          new TextDecoder().decode(direct.stderr).includes("Private instruction payload path"),
        `direct ${name} must fail`,
      );
      const alias = await run({
        files: ["docs/other.md"],
        sources: { "docs/other.md": `nested/${name}` },
      });
      assert(
        !alias.success &&
          new TextDecoder().decode(alias.stderr).includes("Private instruction source path"),
        `source alias ${name} must fail`,
      );
      const renamedDestination = await run({
        files: [`docs/${name}`],
        sources: { [`docs/${name}`]: "nested/safe.md" },
      });
      assert(
        !renamedDestination.success &&
          new TextDecoder().decode(renamedDestination.stderr).includes(
            "Private instruction payload path",
          ),
        `destination alias ${name} must fail`,
      );
    }
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test({
  name: "APFS long-s alias cannot export a private instruction",
  ignore: Deno.build.os !== "darwin",
  async fn() {
    const directory = await Deno.makeTempDir({ prefix: "dock-apfs-private-" });
    try {
      await Deno.copyFile(script, `${directory}/check.ts`);
      await Deno.mkdir(`${directory}/nested`);
      await Deno.writeTextFile(`${directory}/nested/AGENTS.md`, "synthetic private instruction\n");
      const original = await Deno.stat(`${directory}/nested/AGENTS.md`);
      let alias: Deno.FileInfo;
      try {
        alias = await Deno.stat(`${directory}/nested/AGENTſ.md`);
      } catch (error) {
        if (error instanceof Deno.errors.NotFound) return;
        throw error;
      }
      assert(
        original.dev === alias.dev && original.ino === alias.ino,
        "fixture requires the APFS long-s alias",
      );
      const run = async (policy: object) => {
        await Deno.writeTextFile(`${directory}/public-files.json`, JSON.stringify(policy));
        return await new Deno.Command(Deno.execPath(), {
          args: [
            "run",
            "--allow-read",
            "--allow-write=Local",
            "--allow-sys=umask",
            "check.ts",
            "--export",
          ],
          cwd: directory,
          stdout: "piped",
          stderr: "piped",
        }).output();
      };
      const direct = await run({ files: ["nested/AGENTſ.md"] });
      assert(
        !direct.success &&
          new TextDecoder().decode(direct.stderr).includes("Private instruction payload path"),
        "APFS alias destination must fail",
      );
      const mapped = await run({
        files: ["docs/public.md"],
        sources: { "docs/public.md": "nested/AGENTſ.md" },
      });
      assert(
        !mapped.success &&
          new TextDecoder().decode(mapped.stderr).includes("Private instruction source path"),
        "APFS alias source must fail",
      );
      try {
        await Deno.lstat(`${directory}/Local`);
        throw Error("rejected private data created an export directory");
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      }
    } finally {
      await Deno.remove(directory, { recursive: true });
    }
  },
});
