// SPDX-License-Identifier: MPL-2.0
// Lease only one App directory for a metadata operation, in the original login session.
export async function adminMetadata(
  app: string,
  executable: string,
  args: string[],
  run: (exe: string, args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>,
) {
  const helper = Deno.env.get("X_DOCKICONS_ADMIN_HELPER");
  if (!helper || !helper.trim()) {
    throw Error(
      "App metadata needs administrator access. Set X_DOCKICONS_ADMIN_HELPER to a compatible administrator helper executable. Original backup is retained.",
    );
  }
  let info: Deno.FileInfo;
  try {
    info = await Deno.stat(helper);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
    throw Error(
      "Administrator helper is unavailable. Check X_DOCKICONS_ADMIN_HELPER. Original backup is retained.",
    );
  }
  if (!info.isFile) throw Error("Administrator helper is not a file. Original backup is retained.");
  const user = (await run("/usr/bin/id", ["-un"])).stdout.trim();
  const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
  const acl = `user:${user} allow add_file,delete_child,writeattr,writeextattr`;
  const lease = `#!/bin/sh
set -eu
active=0
child=""
guard=""
cleanup() {
  trap - EXIT TERM HUP INT
  if [ -n "$guard" ]; then kill "$guard" 2>/dev/null || :; fi
  if [ -n "$child" ]; then kill -TERM "$child" 2>/dev/null || :; fi
  if [ "$active" = 1 ]; then /bin/chmod -a ${quote(acl)} ${quote(app)}; fi
}
trap cleanup EXIT
trap 'exit 124' TERM HUP INT
/bin/chmod +a ${quote(acl)} ${quote(app)}
active=1
/usr/bin/sudo -u ${quote(user)} ${[executable, ...args].map(quote).join(" ")} &
child=$!
(sleep 45; kill -TERM $$) &
guard=$!
wait "$child"
child=""
`;
  const directory = await Deno.makeTempDir({ prefix: "delete_after_use_dockicons_admin_" });
  const script = `${directory}/lease.sh`;
  try {
    await Deno.writeTextFile(script, lease, { mode: 0o600 });
    await run("/bin/sh", ["-n", script]);
    console.error(
      "App icon metadata requires local administrator authentication; original backup retained.",
    );
    return await run(helper, ["/bin/sh", script]);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
}
