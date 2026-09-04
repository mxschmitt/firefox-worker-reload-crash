# [Regression]: Firefox content process SIGSEGV on page.reload() while a Web Worker script is still compiling

> Filed as https://github.com/microsoft/playwright/issues/42565

### Last Good Version

1.61.1 (Firefox 151.0, `firefox-1532`)

### First Bad Version

1.62.0 (Firefox 153.0, `firefox-1538`) — still broken on `@playwright/test@next`
(1.64.0-alpha-2026-09-04, Firefox 155.0, `firefox-1543`).

### Steps to reproduce

```bash
git clone https://github.com/mxschmitt/firefox-worker-reload-crash
cd firefox-worker-reload-crash
npm ci
npx playwright install firefox
npm test          # or: npm run loop  (standalone, no test runner)
```

The repro has one dependency (`@playwright/test`), no bundler and no build step. The whole page is:

```js
window.__worker = new Worker("/worker.js");   // ~2 MB of plain functions
window.__ready = true;                        // deliberately NOT awaiting the worker
```

and the test calls `page.reload()` as soon as `__ready` is set, so the reload tears the worker
down while the JS engine is still compiling its script.

### Expected behavior

The tab survives the reloads, as it does on 1.61.1 and on every Firefox build up to and
including `firefox-1536` (152.0.4).

### Actual behavior

The Firefox content process dies with SIGSEGV; Playwright surfaces it as `Page crashed` /
`Target crashed`:

```
EVENT page.crash
page.reload: Page crashed
```

With `DEBUG=pw:browser`:

```
[Parent 12830, IPC I/O Parent] WARNING: process 13090 exited on signal 11: file ipc/chromium/src/chrome/common/process_watcher_posix_sigchld.cc:161
```

8/8 sessions crash on 1.62.1. `npx playwright test` fails 3/3.

### Additional context

**Bisect — every Firefox build Playwright shipped during the 1.62 cycle**, same repro, same machine:

| Playwright | Firefox build | Firefox version | crashes |
|---|---|---|---|
| 1.61.1 | `firefox-1532` | 151.0 | 0/8 |
| 1.62.0-alpha-2026-06-17 | `firefox-1532` | 151.0 | 0/8 |
| 1.62.0-alpha-2026-06-18 | `firefox-1533` | 151.0 | 0/8 |
| 1.62.0-alpha-2026-07-08 | `firefox-1534` | 152.0.4 | 0/8 |
| 1.62.0-alpha-2026-07-17 | `firefox-1535` | 152.0.4 | 0/8 |
| 1.62.0-alpha-2026-07-20 | `firefox-1536` | 152.0.4 | 0/8 |
| **1.62.0-alpha-2026-07-23** | **`firefox-1538`** | **153.0** | **7/8** |
| 1.62.1 | `firefox-1538` | 153.0 | 8/8 |

The boundary is exactly the `firefox-1536` → `firefox-1538` browser roll. Those two nightlies are
three days apart, so the Playwright-side code is effectively unchanged — this looks like the
browser roll rather than a Juggler change. (`firefox-1537` was never published to npm.)

**Not platform-specific, and not fixed on `@next`:**

| Platform | Playwright | Firefox | crashes |
|---|---|---|---|
| Linux x64 | 1.61.1 | 151.0 | 0/8 |
| Linux x64 | 1.62.1 | 153.0 | 8/8 |
| Linux x64 | 1.64.0-alpha-2026-09-04 (`@next`) | 155.0 | **6/6** |
| macOS 26.6.1 arm64 | 1.61.1 | 151.0 | 0/6 |
| macOS 26.6.1 arm64 | 1.62.1 | 153.0 | 6/6 |
| macOS 26.6.1 arm64 | 1.64.0-alpha-2026-09-04 (`@next`) | 155.0 | **6/6** |

**What is and isn't required.** Required:

- an actual **Web Worker** — the same ~7 MB served to the main thread via `<script src>` never
  crashed (0/4), so it is not merely parse cost
- a worker script **large enough to still be compiling** when the reload lands:
  0.25 MB → 0/4, 0.5 MB → 0/4, 0.75 MB → 2/4, 1 MB → 4/4, 2 MB → 6/6
- reloading immediately, without waiting for the worker

Not required: `postMessage` to the worker (it never receives one and still crashes 4/4), Monaco,
TypeScript, a bundler, module workers, multiple tabs, or any settle delay.

**Crash details.** Core dump from the content process (`MOZ_DISABLE_CONTENT_SANDBOX=1` so a core
is written):

```
Program terminated with signal SIGSEGV, Segmentation fault.
Crashing thread name: "DOM Worker"

=> mov 0x8(%rdi),%rax
   mov 0x10(%rax),%rax
   ret

si_addr = 0x8
rdi     = 0x0     <-- null this-pointer
```

`libxul.so` in the Playwright build is stripped, so frames symbolize only as offsets (base
`0x755202800000`): `libxul+0x6a74400`, `+0x6a52070`, `+0x6a51c01`, `+0x6a5487f`, `+0x6a54915`,
`+0x6a751a4`, `+0x3d51e6c`, `+0x3d5559a`, `+0x6a6fce5`, `+0x6a73e65`, `+0x6a55139`, `+0x6a54d91`,
`+0x6a7e2bd`.

**Likely upstream bug.** This looks like
[Bugzilla 2044428](https://bugzilla.mozilla.org/show_bug.cgi?id=2044428) —
`Crash in [@ mozilla::dom::workerinternals::loader::WorkerScriptLoader::EvaluateScript]` (NEW,
unassigned, Core :: DOM: Workers, SIGSEGV in content process). The analysis there is that a
re-entrant `TryShutdown()`, reached from inside `JS::Compile()`, nulls `mWorkerRef` underneath a
still-running `EvaluateScript`; the reporter's trigger was "refreshed the page — iframe crashed".
That also predicts the size threshold above: the script has to be big enough for a GC to happen
mid-compile and for compilation to still be in flight when the reload cancels the worker.

**Caveat on scope, so this isn't overstated.** I only tested Playwright's bundled Firefox — I did
*not* test stock Firefox with this repro, so I can't claim it is Playwright-specific. Mozilla
crash-stats in fact shows the `WorkerScriptLoader::EvaluateScript` signature on 152.0a1, 152.0.x,
153.0.x, 154.x and 155.0a1 (175 reports since 2026-03-01, 173 of them content-process), so the
underlying race predates Firefox 153 and affects stock builds too. What is new in `firefox-1538`
is that it became *reliably* reproducible — 0/8 → 8/8 across a single browser roll.

Filing here because the regression is visible purely through Playwright's bundled browser and the
trigger (reload right after load) is routine in test automation: any suite that reloads a page
carrying a heavy worker (Monaco, PDF.js, ffmpeg.wasm, a large language/service worker) will hit
it. It may be worth tracking 2044428 for the next Firefox roll.

Supersedes #42555, which was rightly closed as a draft with no reproduction attached.

### Environment

```
Linux (crashes 8/8):
  System:
    OS: Linux 6.8 Ubuntu 24.04.4 LTS 24.04.4 LTS (Noble Numbat)
    CPU: (4) x64 AMD EPYC-Milan Processor
    Memory: 14.67 GB / 15.24 GB
  Binaries:
    Node: 22.23.2 - /usr/bin/node
    npm: 10.9.8 - /usr/bin/npm
  npmPackages:
    @playwright/test: 1.62.1 => 1.62.1

macOS (crashes 6/6):
  System:
    OS: macOS 26.6.1
    CPU: (12) arm64 Apple M4 Pro
    Memory: 396.38 MB / 24.00 GB
  Binaries:
    Node: 24.9.0
    npm: 11.19.0
  npmPackages:
    @playwright/test: 1.62.1 => 1.62.1
```
