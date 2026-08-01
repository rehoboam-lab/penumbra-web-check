# Penumbra Web-Check Fork

Upstream: https://github.com/Lissy93/web-check

This fork backs the `penumbra-web-check` Render service (Unphish v2's owned
UnphishScan check engine, `srv-d8818puq1p3s73fq2g90`). As of 2026-07-29 the
Render service still deploys the upstream Docker image
`docker.io/lissy93/web-check:2.1.0` directly — this repo exists as the patch
surface / provenance anchor so the service is no longer source-less.

## Patches

Stability patches (branch `stability-patches`) fixing the OOM-wedge / 502
failure mode observed under concurrent load on Render: a hung page render
would leave an orphaned Chromium holding memory forever, each fallback
render launched a brand-new browser, request timeouts didn't actually stop
the abandoned work, and there was no cap on how many renders could run at
once — so a burst of traffic could stack up unboundedly until the instance
wedged.

| # | What | Why | Env knobs |
|---|------|-----|-----------|
| 1 | `api/screenshot.js` `directChromiumScreenshot()`: `execFile` now runs with `{ timeout, killSignal: 'SIGKILL' }`, and the temp screenshot file is cleaned up on every exit path (success, error, timeout, or abort). | A hung page render previously had no timeout at all — the child Chromium process, and the memory it held, lived forever. | `CHROMIUM_RENDER_TIMEOUT_MS` (default `30000`) |
| 2 | `api/_common/middleware.js`: each request gets its own `AbortController`; its `signal` is threaded through to the handler as an extra argument, and the controller is aborted when the request timeout wins the `Promise.race`. | Previously the timeout race's loser (the handler) kept running to completion in the background even after the client got a timeout response — this patch lets cooperating handlers (currently `screenshot.js`) cancel that work instead. Handlers that ignore the extra `signal` argument are unaffected. | (uses existing `PUBLIC_API_TIMEOUT_LIMIT`) |
| 3 | `api/screenshot.js` `puppeteerScreenshot()`: converted from a fresh `puppeteer.launch()` per request to one lazily-initialized, module-level shared browser (auto-relaunches on disconnect), with a per-request incognito `browser.createBrowserContext()` that is always closed in a `finally` block. | Launching a full browser process per request was a major driver of memory pressure and slow cold starts under concurrent load; one shared browser process with isolated per-request contexts is far cheaper and still request-isolated. | none |
| 4 | `api/screenshot.js`: a small in-module counting semaphore bounds concurrent screenshot renders. Requests over the limit queue briefly, then respond `429` with a `Retry-After` header if the queue doesn't drain in time. | Without admission control, a burst of concurrent screenshot requests could stack up unbounded renders (each holding a Chromium process) and OOM the service. This gives explicit backpressure instead. | `SCREENSHOT_MAX_CONCURRENCY` (default `3`), `SCREENSHOT_QUEUE_TIMEOUT_MS` (default `5000`) |

### Activation step (owner/Render, not code)

As of 2026-07-29 the Render service (`srv-d8818puq1p3s73fq2g90`) deploys the
vendored upstream Docker image `docker.io/lissy93/web-check:2.1.0` directly —
**these patches only take effect once the Render service is switched from
that image deploy to building from this fork** (or a pinned image is
published from it and the service points at that instead). Until that
switch happens, this repo is patch-ready but inert in production.

Other notes:

- The D25 scanner-parity instrumentation (request waterfall, resource hashes,
  DOM snapshot, page links, mobile viewport) was deliberately implemented
  worker-side in `unphish-v2` (`workers/temporal/capture/instrumented-capture.mjs`,
  driving the dedicated `unphish-capture-chromium` CDP browser), NOT here —
  this service keeps serving the ~17 `/api/<check>` endpoints and the legacy
  `/api/screenshot` fallback unchanged.
