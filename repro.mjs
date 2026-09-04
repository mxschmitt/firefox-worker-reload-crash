// Standalone crash loop -- no test runner involved.
//   node repro.mjs
//   SESSIONS=8 RELOADS=5 WORKER_MB=2 node repro.mjs
//   PW_ROOT=/path/to/other/playwright node repro.mjs   (for version bisects)
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { startServer } from "./server.mjs";

const require = createRequire(join(resolve(process.env.PW_ROOT || process.cwd()), "package.json"));
const { firefox } = require("@playwright/test");

const SESSIONS = Number(process.env.SESSIONS || 8);
const RELOADS = Number(process.env.RELOADS || 5);
const WORKER_MB = Number(process.env.WORKER_MB || 2);
const LABEL = process.env.LABEL || "repro";

const { server, port, bytes } = await startServer(0, WORKER_MB);
const url = `http://127.0.0.1:${port}/`;

let crashes = 0;
for (let s = 1; s <= SESSIONS; s++) {
  const browser = await firefox.launch({ headless: true });
  if (s === 1) console.log(`[${LABEL}] firefox=${browser.version()} worker.js=${bytes} bytes`);
  const page = await browser.newPage();
  let crashed = false;
  page.on("crash", () => { crashed = true; });
  try {
    await page.goto(url, { waitUntil: "load" });
    await page.waitForFunction(() => window.__ready === true, null, { timeout: 30_000 });
    for (let i = 1; i <= RELOADS; i++) {
      await page.reload({ waitUntil: "load" });
      await page.waitForFunction(() => window.__ready === true, null, { timeout: 30_000 });
    }
    console.log(`[${LABEL}] session ${s} survived`);
  } catch (error) {
    crashes++;
    console.log(`[${LABEL}] session ${s} CRASHED crashed=${crashed} ${error.message.split("\n")[0]}`);
  } finally {
    await browser.close().catch(() => {});
  }
}
console.log(`[${LABEL}] DONE crashes=${crashes}/${SESSIONS}`);
server.close();
process.exitCode = crashes ? 1 : 0;
