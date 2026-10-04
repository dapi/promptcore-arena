import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { APP_VERSION } from "../src/version.mjs";

// SemVer 2.0.0, including prereleases and build metadata.
const semver =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;
assert.ok(semver.test(APP_VERSION), "package.json: нужна версия SemVer");
const changelog = await readFile(
  new URL("../CHANGELOG.md", import.meta.url),
  "utf8",
);
assert.ok(
  changelog
    .split("\n")
    .some((line) => line.startsWith(`## [${APP_VERSION}] — `)),
  `CHANGELOG.md: нет записи для ${APP_VERSION}`,
);
if (process.env.GITHUB_REF?.startsWith("refs/tags/"))
  assert.equal(
    process.env.GITHUB_REF.slice(10),
    `v${APP_VERSION}`,
    "Тег должен совпадать с package.json",
  );
console.log(`Версия ${APP_VERSION}: SemVer и журнал изменений согласованы`);
