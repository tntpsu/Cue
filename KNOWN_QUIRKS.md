# Known Quirks — Even Hub G2 plugins (and Cloudflare Workers)

Real bugs we've hit + how to avoid them. Each entry is verified empirically.

## EvenHub WebView (iOS WKWebView host)

### `new WebSocket(url)` open handshake fails opaquely

The WebView's `WebSocket()` constructor fires an `error` event during the upgrade handshake even when the worker is fully reachable from a Node.js client. The same wss:// URL works from Node and from desktop browsers — it ONLY fails inside the EvenHub WebView. The browser-spec error message ("WS open failed") deliberately hides handshake details for security, so you can't get more information from the client side.

**Fix:** don't use WebSocket from the plugin. Use chunked HTTP POST via `fetch()` instead — the network whitelist permits fetch and we've verified binary POSTs work. Cue v0.3.0 ships this pattern: buffer ~2.5s of audio, POST a chunk to `/transcribe`, get JSON back. Slightly higher latency than streaming but actually works.

### `app.json` network whitelist is per-host, applies to fetch only

The whitelist gates `fetch()` calls. WebSockets may be a separate (and currently more restrictive) gate. List the exact host with the scheme:

```json
"whitelist": [
  "https://your-worker.workers.dev",
  "wss://your-worker.workers.dev"
]
```

**Don't** use placeholder URLs like `https://your-app.example.workers.dev` — they pass `evenhub pack` validation but block real traffic at runtime. The `lint-app-json.mjs` script in `scripts/` rejects placeholders.

### `body: ArrayBuffer` in fetch can be flaky; use `Blob`

WKWebView's fetch handles raw ArrayBuffers inconsistently across iOS versions, especially with CORS preflight on POST. Always wrap binary bodies:

```js
const body = new Blob([arrayBuffer], { type: 'application/octet-stream' })
await fetch(url, { method: 'POST', body, ... })
```

### `indexedDB.open()` silently doesn't persist in EvenHub WebView

Tried IndexedDB as the storage layer for Hands Free v0.2 (programs, sessions, settings). Two failure modes observed in the WebView, both silent:

1. **Doesn't persist across launches.** Save settings, fully close the app, re-open: empty.
2. **Hangs `await indexedDB.open()`.** First launch sometimes never resolves OR rejects, so anything `await`ed before the bridge connect call blocks the bootstrap. Symptom: phone stuck on the initial `<p>Connecting…</p>` HTML; bridge connection logs never fire.

**Fix:** use `bridge.setLocalStorage` / `bridge.getLocalStorage` (exposed as `runtime.setStorage` / `runtime.getStorage` in `src/even.ts` wrappers). The SDK-provided KV is the only reliably persistent client store in this WebView. Cue / WordDaily / Pulse / Glance all use it; Hands Free initially didn't and got bitten.

**Also**: do storage work AFTER `connectEvenRuntime()` returns — never block bootstrap on a storage `await` that runs before bridge.

### Fallback paths must surface a visible signal

If your code falls back to mock-mode on any failure, the user must be able to *see* why. We had a multi-hour debug loop because the diagnostic transcript got immediately overwritten by mock script content. Pattern: keep an `err` field in your stats and render it on screen.

## Cloudflare Workers

### `fetch('wss://...')` returns HTTP 500

The Workers runtime rejects `wss://` schemes in `fetch()` with `TypeError: Fetch API cannot load: wss://...`. Use `https://` and rely on the `Upgrade: websocket` header to negotiate the protocol upgrade.

```ts
// WRONG
const r = await fetch('wss://api.example.com/ws', { headers: { Upgrade: 'websocket' } })
// RIGHT
const r = await fetch('https://api.example.com/ws', { headers: { Upgrade: 'websocket' } })
```

### Cloudflare bot detection (error 1010) on simple HTTP clients

Python `urllib` and bare `curl` requests sometimes hit Cloudflare's bot challenge with HTTP 403 + error code 1010. Real browsers / WKWebView don't trigger it. For test scripts, set a real-looking User-Agent:

```bash
curl -H "User-Agent: Mozilla/5.0" ...
```

### `wrangler dev --local` doesn't fully proxy outbound WebSocket fetches

Local Workerd doesn't behave identically to production for outbound `fetch()`-with-Upgrade calls — a successful upgrade can return 502 because the upstream connection isn't proxied. Test WebSocket-via-fetch against the deployed worker, not against `wrangler dev --local`.

## SDK (`@evenrealities/even_hub_sdk` v0.0.10)

### `setBackgroundState` / `onBackgroundRestore` don't exist

The plugin docs reference these APIs but they're absent in v0.0.10. Re-fetch state on `FOREGROUND_ENTER_EVENT` instead of relying on a background-state hook.

### Audio events arrive on the same `onEvenHubEvent` channel as input

`bridge.audioControl(true)` enables mic capture; PCM frames arrive as `event.audioEvent.audioPcm` on the regular event handler. Don't expect a separate `onAudioFrame` channel.

### `bridge.audioControl(true)` returns truthy regardless of permission

The return value indicates the call was accepted by the SDK, not that the OS granted mic permission. If the user denies mic on their phone, you'll still get a truthy return + zero audio frames. Only way to detect: count incoming audio frames and surface "no frames after Ns" as a UI signal.

### Concurrent `textContainerUpgrade` calls crash the BLE link

Always serialize render calls through a mutex. The `enqueue()` pattern in `src/even.ts` is the canonical fix.

## Testing

### Vite HMR can leave stale `bridge.onEvenHubEvent` registrations

After editing source files in a `npm run dev` loop with the simulator open, gestures sent via `/api/input` may stop reaching the JS handler. The SDK still logs `[EvenAppBridge] EvenHub event: …` internally, but your `bridge.onEvenHubEvent(cb)` callback never fires.

Cause: HMR reloads the module that called `bridge.onEvenHubEvent`, but the bridge's previous registration may still hold a reference to the now-detached callback. Production page-loads aren't affected (they do a full reload, not module HMR).

**Fix during dev:** `pkill -f evenhub-simulator` and re-launch after meaningful source changes. The pattern is documented at the top of `scripts/regression.mjs` for any project that adopts the e2e regression script.

### Multiple `evenhub-simulator` instances on same `--automation-port` silently fight

If two sim windows are running with `--automation-port 9899`, only the first responds to gesture API calls. The second logs `Address already in use` to stderr and degrades — but `/api/ping` still returns "pong" from the original. Symptom: gestures appear to dispatch but nothing happens.

**Fix:** always `pkill -f evenhub-simulator && sleep 2` before relaunching the sim. Don't open a second sim window thinking the first crashed — the API is lying to you.

### The simulator runs desktop Chromium, NOT iOS WKWebView

Simulator passing != production passing. Specifically:
- WebSocket works in the simulator but may fail in production
- The simulator doesn't enforce `app.json` permissions at all
- Fetch behaviors differ subtly (CORS preflight, binary body handling)

For WKWebView quirks the only real test is on a physical device.

### Testing layer matrix — what each layer catches

| Layer | Engine | Catches | Cost | Trigger |
|---|---|---|---|---|
| Vitest unit | Node | Pure logic, parsers, transport contract | <1s | every commit |
| JSDOM (`@vitest-environment jsdom`) | Chromium-shaped | DOM state machine, handler wiring, save→paint flows | ~1s | every commit |
| Pre-pack lint (`scripts/lint-app-json.mjs`) | Node | Manifest errors, placeholder URLs, version typos | instant | `npm run pack` |
| Backend integration (`scripts/test-backends.mjs`) | Node | API schema drift, dead routes, contract changes on Jina/LRCLIB/ESPN/widget_api/phils-bridge | ~5s | on demand / before deploy |
| Worker integration (`scripts/test-worker.mjs`) | wrangler dev local | Cloudflare Workers fetch quirks (wss vs https), auth gates, route bugs | ~10s | on demand / before deploy |
| Simulator e2e (`scripts/regression.mjs`) | Chromium WebView (Tauri) | Boot, gesture, render-loop liveness, mock fallback | ~10s | manual sim run |
| **Playwright/WebKit** (`scripts/test-webkit.mjs` — Cue only) | macOS WebKit | JS-engine quirks closer to iOS WKWebView — fetch behavior, CORS, WebSocket open-handshake | ~5s | on demand |
| iOS Simulator + Mobile Safari | iOS WKWebView in iOS Simulator | Real iOS WebView behavior (closest desktop-only test) | requires Xcode | rarely |
| Real-device CI | Real glasses + EvenHub WKWebView | All iOS-only platform quirks: ATS, CORS, sandbox, BLE | manual | as needed |

**The structural gap that no automated test currently covers**: iOS WKWebView behavior layered on top of WebKit (App Transport Security, app sandbox restrictions, EvenHub's custom WKContentRuleList if any). For Cue specifically: a binary POST that succeeds from macOS WebKit can still fail from iOS WKWebView due to ATS or sandbox config. The only fixes are (a) iOS Simulator + Xcode (heavy) or (b) real device.

Practical default: run unit + JSDOM + lint on every commit; run integration + WebKit before any real-device test cycle. Real device covers the last 10% no automation can.

### `@vitest-environment jsdom` for plugin state-machine tests

Vitest's default env is `node` — DOM APIs aren't available. Add the directive at the top of any test file that needs `document` / `localStorage`:

```ts
// @vitest-environment jsdom
```

JSDOM is also Chromium-shaped, so it inherits the same "passing here doesn't prove production" caveat. But it IS the right tool for state-machine + handler-wiring tests that don't depend on the WebView itself.

## Build / pack

### `app.json` fields not all documented in the same place

The build-and-deploy skill documents them well; the `evenhub pack` validator enforces a subset. Run `scripts/lint-app-json.mjs` before every pack — it catches the union of common errors (missing fields, version format, supported_languages allowlist, placeholder whitelist URLs).

### Re-pack on every change to `app.json` or `dist/`

The `.ehpk` is just a packaged snapshot of `app.json` + `dist/`. Forgetting to repack after a `app.json` whitelist edit is a real foot-gun — you'll see the OLD whitelist enforced on glasses even though the file looks right locally. The `prepack` lifecycle hook (or our pre-pack lint) reduces this risk.

## Hub dev portal + worker deploy

### Dev portal at `hub.evenrealities.com/hub` is a Nuxt SPA — selectors are pre-baked, not stable

Built `scripts/upload-dev.mjs` (Playwright, in Cue repo) to drive the upload flow against a session captured in `~/.hub-portal-session.json`. The flow is:

1. Click `button:has-text("Upload a build")` on the project detail page
2. Wait for `[role="dialog"][data-state="open"]`
3. Set the .ehpk on the hidden `input[type="file"][accept=".ehpk"]` via Playwright's `setInputFiles`
4. Fill `textarea[name="changelog"]` (max 500 chars)
5. Click `button:has-text("Add build")`
6. Wait for dialog to close (real success signal — NOT the version chip in the dialog header, which is the LAST uploaded version)

False-success caught during build: the dialog header shows the existing build's version. Confirming success requires the dialog to *close* + the new version to appear in the build list.

Session at `~/.hub-portal-session.json` is shared across all four sister repos by design (sandbox blocks cross-repo cred propagation; per-repo dotfiles are cumbersome).

### `wrangler tail` is the only way to see what reaches a deployed Worker

When a plugin reports HTTP 405 / 401 / 500 from a deployed Worker, run `wrangler tail` in the worker directory. The `[req] METHOD /path ua=...` line we added at the top of every Worker's fetch handler shows the actual method/path/UA the request arrived with — distinguishes "Worker rejected method" from "request never reached Worker" (CORS preflight failure, wrong URL configured in plugin settings, etc.).

We hit this exact debugging on Cue v0.3.4 — the user saw 405 from `/transcribe`; tail showed zero requests; root cause was a wrong Worker URL in phone settings. The diagnostic-rich `/transcribe` 405 response (echoes received method + headers + cf-ray) was added so the next round wouldn't need the user to install `wrangler tail` themselves.

### Plugin's `endMicSession` had a silent trailing-flush bug (caught by tests)

Pre-v0.4.1 Cue: `endMicSession()` set `active = false` BEFORE awaiting `flush()`, and `flush()` bailed on `!active`. So sessions shorter than `CHUNK_BYTES` (~80KB / ~2.5s) sent NOTHING to the Worker. Fixed by adding a `force` parameter to `flush()` that bypasses the active-flag check; `endMicSession` passes true. Also the lesson: write the test before the feature so the bug surfaces.

## Sandbox / cross-repo

### Cross-repo file copies are sandbox-blocked when they look like credential propagation

Specifically, copying `.hub-portal-session.json` (Playwright session storage) from one repo to another via `cp` was denied — the sandbox treats it as cross-context credential reuse. Two valid workarounds: (1) move the file to `$HOME` and reference it from there in all repos (the `upload-dev.mjs` approach), (2) regenerate per-repo via headed first-login (slow). Don't try to bypass the sandbox prompt — the home-dir approach is cleaner anyway.

### `jsdom` doesn't deploy to Cloudflare Workers — use `linkedom`

When building a Worker that needs DOM parsing (e.g., `@mozilla/readability`),
`jsdom` is the obvious pick but **it doesn't deploy**. Even with
`compatibility_flags = ["nodejs_compat"]` in wrangler.toml, the build fails
with 17+ "Could not resolve" errors for `path`, `url`, `fs`, `vm`, `zlib`,
`stream`, and other node built-ins jsdom depends on transitively.

**Fix**: swap to [`linkedom`](https://github.com/WebReflection/linkedom).
Pure-JS DOM impl, runs natively in Workers, same `parseHTML(html).document`
API. Mozilla Readability accepts the linkedom Document via a one-line
`as unknown as Document` cast (the structural types match).

Caught when adding /diag + /healthz to Glance's worker — it had been
deployed-ready in code since v0.1 but never actually deployed via
wrangler. Now Glance's Default-Worker feature (v0.5.0) is finally
ship-able end-to-end.

## Bring-your-own keys, not bring-your-own Worker (Cue, 2026-09-24)

The hub network whitelist is a fixed list of exact origins at pack time, so an
app cannot let each user supply their own backend URL. It can let each user
supply their own **keys** to a backend whose origin is the same for everyone.
Cue v0.5.0 calls `api.deepgram.com`, `api.anthropic.com` and `api.openai.com`
directly from the plugin with keys from phone settings.

All three accept browser (CORS) requests from any origin; verified with
preflight probes on 2026-09-22. Anthropic additionally requires the
`anthropic-dangerous-direct-browser-access: true` header. The name is a
warning that the key is client-side, which for a user's own key on their own
phone is the intended model; it is disclosed in the permission text.

`lib.dom`'s `BlobPart` no longer accepts a bare `Uint8Array` (its buffer may be
a `SharedArrayBuffer` by type): hand `new Blob()` an `ArrayBuffer` slice
(`providers.ts` `toArrayBuffer`).
