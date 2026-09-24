# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**Cue** — a multi-mode conversation coach for Even Realities G2 smart glasses. Six built-in modes (Date / Argue calm / Sales close / Sting / Listen well / Custom) shape how the LLM phrases suggestions. Audio captured from the glasses mic is sent in 2.5s chunks either directly to Deepgram (transcription) and Anthropic/OpenAI (suggestions) with keys the user pastes in phone settings (v0.5.0, the distributable path), or to the user's personal Cloudflare Worker which holds those keys (advanced). Real STT + LLM lands as text + utterances back at the plugin; suggestions render on the glasses display in real time.

One of four Even-glasses-app repos at `~/Documents/{Cue,Pulse,Glance,lyrics-glow}`. The other three are non-conversational; this is the only one that needs the audio + Worker pipeline.

## Commands

```bash
npm run dev                   # Vite on :5176 (host 0.0.0.0 for LAN)
npm run build                 # tsc + vite build → dist/
npm run pack                  # lint-app-json + evenhub pack → cue.ehpk
npm run deploy                # build + pack
npm test                      # vitest (76 tests)
npm run test:e2e              # simulator regression
npm run test:webkit           # Playwright/WebKit harness for iOS-WKWebView parity
npm run hub:upload            # node scripts/upload-dev.mjs (uploads ./cue.ehpk to dev portal)
npx evenhub qr --url http://<lan-ip>:5176   # QR for real-glasses hot reload
```

## Architecture

Three layers talk to each other:

1. **Plugin (this repo).** TypeScript + Vite SPA that runs in WKWebView in the Even Realities companion app on the phone. `src/main.ts` owns the state machine, `src/even.ts` wraps the glasses bridge, `src/transport.ts` handles audio chunking over two backends (`src/providers.ts` direct-to-provider, or the Worker; keys win, then Worker, then mock), `src/utterance.ts` holds pure heuristics (end-of-utterance trigger, sentence-aware trim, conversation accumulation, speaker labels), `src/modes.ts` is the mode registry.

2. **Worker (in `worker-template/`).** Personal Cloudflare Worker the user deploys with their own Deepgram + Anthropic/OpenAI keys. Endpoints: `POST /transcribe` (audio → JSON `{text, utterances}`), `POST /suggest` (transcript → JSON `{suggestions[]}`), `GET /healthz`, `GET /ws` (WebSocket — vestigial, see KNOWN_QUIRKS). Logs every request via `console.log` for `wrangler tail` debugging.

3. **Glasses runtime.** Single full-screen text container. `textContainerUpgrade` for flicker-free updates. Audio capture via `audioControl(true)`; PCM frames arrive via `onEvenHubEvent.audioEvent.audioPcm`.

## Critical quirks (also see KNOWN_QUIRKS.md)

- **`new WebSocket()` fails silently in WKWebView** — that's why we use chunked HTTP POST instead of streaming. The 2.5s chunk latency is a platform floor, not a code issue. Never reintroduce the WebSocket path on the plugin side; the Worker can use Deepgram WS server-side.
- **`bridge.audioControl(true)` returns truthy regardless of mic permission** — count audio frames as the real signal, not the call's return value.
- **Concurrent `textContainerUpgrade` calls crash the BLE link** — render is serialized through `enqueue()` in `src/even.ts`. Don't bypass.
- **The wearer's voice gets transcribed too.** v0.4.0 added Deepgram diarization (`diarize=true&utterances=true`) so the plugin can label speakers `[A]/[B]/etc` and exclude the wearer's lines from the suggestion-prompt context. Configure via phone-side "Which speaker is you?" dropdown.
- **`endMicSession` previously dropped the trailing audio chunk** — fixed in v0.4.1 by passing `force=true` to the final `flush()`. If you refactor `flush()`, keep the force-flag escape hatch.

## Conventions

- **Mock mode** runs when no Worker is configured. `src/mock.ts` drives canned suggestions on a timer. Useful for setup-free demos.
- **Phone-side fetch debug log** in settings (added v0.3.4) — every `/transcribe` and `/suggest` call surfaces with status, latency, and a friendly error. Use this first when something stops working.
- **Default OFF for the on-glasses debug overlay** (the `audio frames=N chunks=X/Yok` line). Toggle in phone settings only when actively debugging.
- **Per-mode bullet glyph + first-word emphasis** on suggestions. Custom mode skips the emphasis (user controls phrasing).

## Worker deployment

```bash
cd worker-template && npx wrangler deploy
npx wrangler tail              # live request logs
```

Auth is in `~/.wrangler/state/` (already authenticated; reuse).

## Dev-portal upload

`scripts/upload-dev.mjs` does Playwright-driven upload to `hub.evenrealities.com/hub/<package_id>`. Session cached at `~/.hub-portal-session.json` (shared across all four repos by design — sandbox blocks cross-repo cred propagation).

## Sister repos

`Pulse / Glance / lyrics-glow` share `KNOWN_QUIRKS.md`, `NOTICE`, and `scripts/lint-app-json.mjs`. Don't propagate other files without confirming — these four apps have intentionally divergent state machines.
