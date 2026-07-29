# Penumbra Web-Check Fork

Upstream: https://github.com/Lissy93/web-check

This fork backs the `penumbra-web-check` Render service (Unphish v2's owned
UnphishScan check engine, `srv-d8818puq1p3s73fq2g90`). As of 2026-07-29 the
Render service still deploys the upstream Docker image
`docker.io/lissy93/web-check:2.1.0` directly — this repo exists as the patch
surface / provenance anchor so the service is no longer source-less.

## Patches

None yet. Note before the first patch lands:

- The D25 scanner-parity instrumentation (request waterfall, resource hashes,
  DOM snapshot, page links, mobile viewport) was deliberately implemented
  worker-side in `unphish-v2` (`workers/temporal/capture/instrumented-capture.mjs`,
  driving the dedicated `unphish-capture-chromium` CDP browser), NOT here —
  this service keeps serving the ~17 `/api/<check>` endpoints and the legacy
  `/api/screenshot` fallback unchanged.
- If/when a patch is needed, switch the Render service from the image deploy
  to this repo (or publish a pinned image from it) in the same change.
