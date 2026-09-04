// Serves a page that starts one classic Web Worker with a large script.
// No build step, no framework, no dependencies.
import { createServer } from "node:http";

const WORKER_MB = Number(process.env.WORKER_MB || 2);

// A large but completely ordinary worker script. The only thing that matters
// is that it takes a while for the JS engine to compile.
export function makeWorkerJs(mb = WORKER_MB) {
  const parts = ["var __sink = 0;\n"];
  const target = mb * 1024 * 1024;
  let size = 0;
  for (let i = 0; size < target; i++) {
    const fn = `function f${i}(a,b){var x=a*${i}+b;for(var j=0;j<3;j++){x+=j*${i};}__sink+=x;return x;}\n`;
    parts.push(fn);
    size += fn.length;
  }
  return parts.join("");
}

export const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>worker reload crash</title></head>
<body>
<script>
  // Start the worker and immediately declare the page ready. We deliberately
  // do NOT wait for the worker to finish starting -- the crash needs the
  // reload to land while the worker script is still being compiled.
  window.__worker = new Worker("/worker.js");
  window.__ready = true;
<\/script>
</body></html>`;

export function startServer(port = 0, mb = WORKER_MB) {
  const workerJs = makeWorkerJs(mb);
  const server = createServer((req, res) => {
    const path = new URL(req.url, "http://127.0.0.1").pathname;
    if (path === "/worker.js") {
      res.writeHead(200, { "content-type": "text/javascript" });
      res.end(workerJs);
    } else {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(html);
    }
  });
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () =>
      resolve({ server, port: server.address().port, bytes: workerJs.length }),
    );
  });
}

// `node server.mjs` runs it standalone on 4182 for the Playwright test.
if (import.meta.url === `file://${process.argv[1]}`) {
  const { port, bytes } = await startServer(Number(process.env.PORT || 4182));
  console.log(`listening on http://127.0.0.1:${port}/ (worker.js = ${bytes} bytes)`);
}
