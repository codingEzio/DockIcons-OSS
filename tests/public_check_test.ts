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
        args: ["run", "--allow-read", "--allow-write=Local", "check.ts", ...args],
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
        args: ["run", "--allow-read", "--allow-write=Local", "check.ts", ...args],
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
