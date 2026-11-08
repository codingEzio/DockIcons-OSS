// SPDX-License-Identifier: MPL-2.0
Deno.test("configuration selects a private collection without changing the public defaults", async () => {
  const dir = await Deno.makeTempDir();
  const root = decodeURIComponent(new URL("../", import.meta.url).pathname).replace(/\/$/, "");
  const config = `${dir}/config.json`;
  const catalog = {
    version: 1,
    icons: [{
      id: "fixture",
      name: "Fixture",
      bundleId: "test.fixture",
      style: "nothing",
      png: "icons/nothing/fixture.png",
      icns: "icons/nothing/fixture.icns",
      sha256: { png: "0".repeat(64), icns: "0".repeat(64) },
      protected: false,
      rights: { owner: "fixture", status: "owned" },
    }],
  };
  await Deno.writeTextFile(`${dir}/catalog.json`, JSON.stringify(catalog));
  await Deno.writeTextFile(`${dir}/style.json`, JSON.stringify({ marker: "fixture-style" }));
  await Deno.writeTextFile(
    config,
    JSON.stringify({ catalog: "catalog.json", style: "style.json", adminHelper: "helper" }),
  );
  const run = async (entry: string, args: string[], cfg = config) => {
    const result = await new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", `${root}/src/${entry}.ts`, ...args],
      env: { X_DOCKICONS_CONFIG: cfg },
      stdout: "piped",
      stderr: "piped",
    }).output();
    return {
      ...result,
      out: new TextDecoder().decode(result.stdout),
      err: new TextDecoder().decode(result.stderr),
    };
  };
  try {
    const list = await run("cli", ["list"]);
    if (!list.success || !list.out.includes("fixture")) throw Error(list.err);
    const prompt = await run("cli", ["prompt"]);
    if (!prompt.success || !prompt.out.includes("fixture-style")) throw Error(prompt.err);
    const complete = await run("kit", ["--complete", "styles"]);
    if (!complete.success || complete.out.trim() !== "nothing") throw Error(complete.err);
    const override = await run("cli", ["--catalog", `${root}/catalog.json`, "list"]);
    if (!override.success || override.out.includes("fixture")) {
      throw Error("catalog override failed");
    }
    if ((await run("cli", ["list"], `${dir}/missing`)).success) {
      throw Error("missing explicit configuration succeeded");
    }
    await Deno.writeTextFile(config, JSON.stringify({ catalog: 3 }));
    if ((await run("kit", ["--complete", "styles"])).success) {
      throw Error("invalid configuration succeeded");
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
