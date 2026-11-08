// SPDX-License-Identifier: MPL-2.0
import { adminMetadata } from "../src/admin.ts";

Deno.test("configured administrator helper is explicit and failure leaves no temporary script", async () => {
  const old = Deno.env.get("X_DOCKICONS_ADMIN_HELPER");
  const temp = await Deno.makeTempDir();
  const helper = `${temp}/custom helper`;
  await Deno.writeTextFile(helper, "synthetic helper");
  let calls: string[] = [];
  let script = "";
  let fail = false;
  const run = async (exe: string, args: string[]) => {
    calls.push(exe);
    if (exe === "/usr/bin/id") return { code: 0, stdout: "synthetic-user\n", stderr: "" };
    if (exe === "/bin/sh") {
      script = args[1];
      if (!(await Deno.readTextFile(script)).includes("synthetic-user")) throw Error("bad script");
      return { code: 0, stdout: "", stderr: "" };
    }
    if (exe !== helper || args[0] !== "/bin/sh" || args[1] !== script) {
      throw Error("bad helper call");
    }
    if (fail) throw Error("synthetic helper failure");
    return { code: 0, stdout: "synthetic success", stderr: "" };
  };
  try {
    Deno.env.delete("X_DOCKICONS_ADMIN_HELPER");
    try {
      await adminMetadata("/synthetic.app", "/synthetic-command", [], run);
      throw Error("missing helper unexpectedly succeeded");
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("Set X_DOCKICONS_ADMIN_HELPER")) {
        throw error;
      }
    }
    if (calls.length) throw Error("missing helper invoked a command");
    Deno.env.set("X_DOCKICONS_ADMIN_HELPER", `${temp}/missing`);
    try {
      await adminMetadata("/synthetic.app", "/synthetic-command", [], run);
      throw Error("missing file unexpectedly succeeded");
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("unavailable")) throw error;
    }
    Deno.env.delete("X_DOCKICONS_ADMIN_HELPER");
    const configured = await adminMetadata("/synthetic.app", "/synthetic-command", [], run, helper);
    if (configured.stdout !== "synthetic success") throw Error("configured helper not used");
    calls = [];
    Deno.env.set("X_DOCKICONS_ADMIN_HELPER", helper);
    const value = await adminMetadata("/synthetic.app", "/synthetic-command", [], run);
    if (
      value.stdout !== "synthetic success" || calls.join(",") !== `/usr/bin/id,/bin/sh,${helper}`
    ) {
      throw Error("configured helper not called as expected");
    }
    try {
      await Deno.stat(script);
      throw Error("script retained");
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    calls = [];
    fail = true;
    try {
      await adminMetadata("/synthetic.app", "/synthetic-command", [], run);
      throw Error("helper failure unexpectedly succeeded");
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "synthetic helper failure") throw error;
    }
    try {
      await Deno.stat(script);
      throw Error("failed script retained");
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  } finally {
    if (old === undefined) Deno.env.delete("X_DOCKICONS_ADMIN_HELPER");
    else Deno.env.set("X_DOCKICONS_ADMIN_HELPER", old);
    await Deno.remove(temp, { recursive: true });
  }
});
