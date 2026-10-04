import { readFile } from "node:fs/promises";

// The package is the single source of the application release version.
const pkg = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);
export const APP_VERSION = pkg.version;
