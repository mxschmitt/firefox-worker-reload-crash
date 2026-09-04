# [Bug]: Firefox 153 content-process SIGSEGV when reloading while a Web Worker script is compiling

### Version

1.62.1 — and still reproduces on `@playwright/test@next` (1.64.0-alpha-2026-09-04, Firefox 155.0).

### Steps to reproduce

Self-contained repro (no Monaco, no bundler, no build step — one `new Worker()` and a reload):

```bash
git clone https://github.com/mxschmitt/firefox-worker-reload-crash
cd firefox-worker-reload-crash
npm ci
npx playwright install firefox
npm test          # or: npm run loop
```

The page is two lines:

```js
window.__worker = new Worker("/worker.js");   // ~2 MB of plain functions
window.__ready = true;                        // deliberately NOT awaiting the worker
```

and the test reloads as soon as `__ready` is set, so the reload tears the worker down while
the JS engine is still compiling its script.

### Expected behavior

The tab survives the reloads, as it does on Playwright 1.61.1 / Firefox 151 and on every
Firefox build up to and including `firefox-1536` (152.0.4).

### Actual behavior

The Firefox content process dies with SIGSEGV. Playwright surfaces it as `Page crashed`:

```
EVENT page.crash
page.reload: Page crashed
```

and with `DEBUG=pw:browser`:

```
[Parent NNNNN, IPC I/O Parent] WARNING: process NNNNN exited on signal 11: \
  file ipc/chromium/src/chrome/common/process_watcher_posix_sigchld.cc:161
```

8/8 sessions crash on Playwright 1.62.1.

### Bisect

Every Firefox build Playwright shipped during the 1.62 cycle, same repro, same machine:

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

The boundary is exactly the `firefox-1536` → `firefox-1538` roll. Those two nightlies are three
days apart, so the Playwright-side code is effectively unchanged — this is the browser roll, not
a Juggler change. (`firefox-1537` was never published to npm.)

### Not Linux-only, and not fixed on `@next`

| Platform | Playwright | Firefox | crashes |
|---|---|---|---|
| Linux x64 | 1.61.1 | 151.0 (`firefox-1532`) | 0/8 |
| Linux x64 | 1.62.1 | 153.0 (`firefox-1538`) | 8/8 |
| Linux x64 | 1.64.0-alpha-2026-09-04 (`@next`) | 155.0 (`firefox-1543`) | **6/6** |
| macOS 26.6.1 arm64 | 1.61.1 | 151.0 (`firefox-1532`) | 0/6 |
| macOS 26.6.1 arm64 | 1.62.1 | 153.0 (`firefox-1538`) | 6/6 |
| macOS 26.6.1 arm64 | 1.64.0-alpha-2026-09-04 (`@next`) | 155.0 (`firefox-1543`) | **6/6** |

It still reproduces on the current nightly with Firefox 155, on both Linux x64 and macOS arm64,
and the 151 → 153 boundary is identical on both platforms.

To be clear about what this is: **most likely an exposure shift rather than a bug introduced in
153.** Mozilla crash-stats shows the `WorkerScriptLoader::EvaluateScript` signature on 152.0a1,
152.0.x, 153.0.x, 154.x and 155.0a1 — 175 reports since 2026-03-01, 173 of them content-process
— so the race predates 153. The 153 build just makes it reliable.

### Crash details

Core dump from the content process:

```
Program terminated with signal SIGSEGV, Segmentation fault.
Crashing thread name: "DOM Worker"

=> mov 0x8(%rdi),%rax
   mov 0x10(%rax),%rax
   ret

si_addr = 0x8
rdi     = 0x0     <-- null this-pointer
```

`libxul.so` in the Playwright build is stripped, so frames only symbolize as offsets (base
`0x755202800000`): `libxul+0x6a74400`, `+0x6a52070`, `+0x6a51c01`, `+0x6a5487f`, `+0x6a54915`,
`+0x6a751a4`, `+0x3d51e6c`, `+0x3d5559a`, `+0x6a6fce5`, `+0x6a73e65`, `+0x6a55139`, `+0x6a54d91`,
`+0x6a7e2bd`.

This matches the open Firefox bug
**[Bugzilla 2044428](https://bugzilla.mozilla.org/show_bug.cgi?id=2044428)** —
`Crash in [@ mozilla::dom::workerinternals::loader::WorkerScriptLoader::EvaluateScript]`
(NEW, unassigned, Core :: DOM: Workers, SIGSEGV in content process). Its analysis: a re-entrant
`TryShutdown()` reached from inside `JS::Compile()` nulls `mWorkerRef` underneath a still-running
`EvaluateScript`. The reporter's own trigger there was "refreshed the page — iframe crashed".

### What is and isn't required

Required:
- an actual **Web Worker** — the same ~7 MB served to the main thread via `<script src>` never
  crashed (0/4)
- a worker script **large enough to still be compiling** when the reload lands:
  0.25 MB → 0/4, 0.5 MB → 0/4, 0.75 MB → 2/4, 1 MB → 4/4, 2 MB → 6/6
- reloading immediately

Not required: `postMessage` to the worker (0 messages still crashes 4/4), Monaco, TypeScript,
a bundler, module workers, multiple tabs, or any settle delay.

### Why file this against Playwright

The crash only reproduces on Playwright's bundled Firefox, and the trigger — reload immediately
after load — is something test automation does constantly, so any Playwright suite that reloads a
page with a heavy worker (Monaco, PDF.js, ffmpeg.wasm, a large service/language worker) will hit
it. Worth either picking up a Firefox build with a fix for
[2044428](https://bugzilla.mozilla.org/show_bug.cgi?id=2044428) or nudging it upstream — it has
been sitting at P3 since June.

This replaces [#42555](https://github.com/microsoft/playwright/issues/42555), which was correctly
closed as a draft with no repro attached.

### Environment

```
Linux : Ubuntu 24.04.4 LTS, 6.8.0, x86_64 (Hetzner ccx23, 4 dedicated vCPU), Node 22.23.2
macOS : 26.6.1, arm64, Node 24.9.0
@playwright/test 1.62.1 (Firefox 153.0) and 1.64.0-alpha-2026-09-04 (Firefox 155.0)
headless
```
