// Resolve playwright (or playwright-core) from a local node_modules, NODE_PATH,
// the npm global root, or nvm — bare ESM imports can't see global installs.

import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { execSync } from "node:child_process";

const require = createRequire(import.meta.url);

export function loadPlaywright() {
  const roots = [""];
  try { roots.push(execSync("npm root -g", { encoding: "utf8" }).trim()); } catch { /* no npm */ }
  const nvm = join(homedir(), ".config/nvm/versions/node");
  try { for (const v of readdirSync(nvm)) roots.push(join(nvm, v, "lib/node_modules")); } catch { /* no nvm */ }
  for (const r of roots) {
    for (const pkg of ["playwright", "playwright-core"]) {
      try { return require(r ? join(r, pkg) : pkg); } catch { /* next */ }
    }
  }
  console.error("playwright not found — npm i -g playwright");
  process.exit(2);
}
