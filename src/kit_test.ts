// SPDX-License-Identifier: MPL-2.0
import { type IconTarget, preferredTargets, resolveTargets } from "./kit.ts";
const icons: IconTarget[] = [
  {
    id: "local-send",
    name: "LocalSend",
    bundleId: "org.localsend",
    style: "nothing",
    protected: false,
  },
  {
    id: "seed-marks",
    name: "SeedMarks",
    bundleId: "dev.seedmarks",
    style: "nothing",
    protected: false,
    aliases: ["Seed Marks"],
  },
  { id: "seedmux", name: "Seedmux", bundleId: "dev.seedmux", style: "nothing", protected: false },
];
function equal(actual: string[], expected: string[]) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw Error(JSON.stringify({ actual, expected }));
  }
}
Deno.test("name punctuation spaces case and bundle IDs resolve identically", () => {
  for (const query of ["LOCAL SEND", "local-send", "org.localsend"]) {
    equal(resolveTargets(icons, query).map((x) => x.id), ["local-send"]);
  }
  equal(resolveTargets(icons, "Seed Marks").map((x) => x.id), ["seed-marks"]);
});
Deno.test("partial query preserves ambiguity rather than choosing the first App", () => {
  equal(resolveTargets(icons, "seed").map((x) => x.id), ["seed-marks", "seedmux"]);
  equal(resolveTargets(icons, "unknown").map((x) => x.id), []);
});

Deno.test("Chrome name selects its preferred variant while exact old ID remains selectable", () => {
  const variants = [
    {
      id: "chrome",
      name: "Google Chrome",
      bundleId: "com.google.Chrome",
      style: "nothing",
      protected: false,
      preferred: false,
    },
    {
      id: "chrome-20261014",
      name: "Google Chrome (2026-10-14)",
      bundleId: "com.google.Chrome",
      style: "nothing",
      protected: false,
      preferred: true,
    },
  ];
  equal(resolveTargets(variants, "Google Chrome").map((x) => x.id), ["chrome-20261014"]);
  equal(resolveTargets(variants, "chrome").map((x) => x.id), ["chrome"]);
  equal(preferredTargets(variants).map((x) => x.id), ["chrome-20261014"]);
  for (
    const invalid of [
      variants.map((x) => ({ ...x, preferred: false })),
      variants.map((x) => ({ ...x, preferred: true })),
    ]
  ) {
    let rejected = false;
    try {
      preferredTargets(invalid);
    } catch {
      rejected = true;
    }
    if (!rejected) throw Error("Ambiguous preferred variants must fail before discovery/mutation");
  }
});
