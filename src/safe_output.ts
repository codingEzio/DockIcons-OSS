// SPDX-License-Identifier: MPL-2.0
// Serialize cooperating catalog writers and publish completed output without replacement.
export async function withCatalogLock(path: string, work: () => Promise<void>): Promise<void> {
  const lock = `${path}.lock`;
  try {
    await Deno.mkdir(lock, { mode: 0o700 });
  } catch (error) {
    if (error instanceof Deno.errors.AlreadyExists) {
      throw Error(
        "Catalog is locked by another add or an interrupted operation; inspect before recovery.",
      );
    }
    throw error;
  }
  try {
    await work();
  } finally {
    try {
      await Deno.remove(lock);
    } catch (error) {
      console.error(
        `Could not remove owned catalog lock ${lock}; inspect before retry: ${String(error)}`,
      );
    }
  }
}

export async function withExclusiveOutput(
  path: string,
  create: (staged: string) => Promise<void>,
): Promise<void> {
  const slash = path.lastIndexOf("/");
  const dir = slash < 0 ? "." : slash === 0 ? "/" : path.slice(0, slash);
  const name = path.slice(slash + 1);
  if (!name || name === "." || name === "..") throw Error("Output must name a file");
  const temp = await Deno.makeTempDir({ dir, prefix: ".dock-icons-stage-" });
  const staged = `${temp}/${name}`;
  try {
    await create(staged);
    // A same-filesystem hard link atomically fails if any output already exists.
    await Deno.link(staged, path);
  } catch (error) {
    if (error instanceof Deno.errors.AlreadyExists) throw Error("Output exists; choose a new file");
    throw error;
  } finally {
    try {
      await Deno.remove(temp, { recursive: true });
    } catch (error) {
      console.error(`Could not clean owned staging directory ${temp}: ${String(error)}`);
    }
  }
}
