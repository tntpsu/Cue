# Cue

> **Helps you say the right thing.**

A multi-mode conversation coach for Even Realities G2 smart glasses. Listens to the conversation, surfaces 2-3 suggested responses on the display in real time. Pick a mode (Date / Argue calm / Sales close / Sting / Listen well / Custom) to shape the suggestions. The app never speaks for you — it offers cues you say in your own voice.

## Status: v0.4.4 (correctness pass: glyphs that actually render, phone layout that cannot overflow, failures you can see)

> **Distribution blocker:** the Even Hub network whitelist is a static list of exact origins fixed at pack time — no wildcards, no runtime hosts ([docs](https://hub.evenrealities.com/docs/build/networking)). The BYO-Worker flow below therefore only works for whoever packed the `.ehpk`; a second user's own Worker URL is blocked before the request leaves the WebView. Distributing Cue needs the Worker to become a fixed origin with **user-supplied API keys**. Tracked as the top item before any listing.

If you've deployed the personal Worker (see `worker-template/README.md`) and pasted its URL + bearer token in phone settings, Cue streams audio over chunked HTTP → Deepgram for transcription, and POSTs your rolling transcript to the Worker's `/suggest` endpoint for LLM suggestions. If those settings are blank or the Worker is unreachable, Cue falls back to the v0.1.0 timer-driven mock suggestions so the app stays demonstrable.

| Version | What's in it |
|---|---|
| v0.1.0 | Scaffold, mode picker, privacy opt-in, mic toggle, glasses UI, mock suggestion driver |
| v0.2.0 | Worker template (Deepgram + LLM bridge), real audio capture via `audioControl`, transport layer, live captions, debounced LLM suggestions. Mock fallback preserved. |
| v0.2.5 | Test infrastructure: chunked HTTP transport, JSDOM tests, worker integration tests, app.json lint, KNOWN_QUIRKS, WebKit harness for iOS WKWebView parity. |
| v0.3.0 | End-of-utterance detection (sentence-final punctuation + silence-gap + max-wait), sentence-aware transcript trimming, battery glyph in glasses header, idle auto-pause after 5 min, word-boundary line wrap on suggestions, per-mode bullet glyphs, first-word emphasis. |
| v0.3.1 | Phone-side `idle-auto-pause-min` setting — was a 5-min hardcode. 0 disables. |
| v0.3.2 | Battery glyph now appears on idle screen (was only visible mid-session). Mock-bridge JSDOM coverage for v0.3 state machine (auto-pause, mode cycle, foreground re-paint). Stale `wss://` whitelist entry removed (chunked HTTP supplanted WebSocket in v0.2.5). |
| v0.3.3 | Mock-mode adds a longer-suggestion entry that exercises the v0.3 word-wrap path + custom-mode coverage (no more silent fallback to date-mode). `lint-app-json.mjs` extended to auto-detect whitelist gaps + stale entries by greping `src/`. Regression script gains a `countStateLogs` render-loop liveness assertion (would catch a silent main-loop death). |
| v0.4.0 | Speaker diarization — Worker requests `diarize=true&utterances=true`; per-speaker turns parsed into the transcript; wearer's own lines excluded from the suggestion context. |
| v0.4.1 | Phone-side speaker selector + `(you)` markers in the transcript view. |
| v0.4.2 | "Calibrate me" — one tap anchors the next speaker heard as the wearer, persisted across reload. |
| v0.4.3 | Per-session transcript persistence: one record per mic-on/mic-off pair (mode, other speakers' transcript, suggestion count), capped at 50 newest-first, reviewable and clearable in phone settings. |
| **v0.4.4** *(current)* | Correctness pass, no new features. Three glyphs were missing from the firmware font and drew as boxes: the battery indicator above 20% charge (so, nearly always), the Sting mode marker, and the `live` indicator that tells you a Worker is configured. Both rejection-class phone-layout bugs fixed (`overflow-x` on the wrapper, `max-width`/`box-sizing` on the speaker selector) and proved at 320/390/430px in WebKit. A failing session now says so on the glasses (`ERR rate limited`, `ERR key rejected`) instead of looking like silence. Mic permission text corrected to match what the app actually stores. 114 tests. |
| v0.5.0 *(planned)* | User-supplied API keys so the app is distributable (see blocker above). Worker-side dedupe of repeated suggestions, retry/backoff on rate-limit. |

## How it works (current v0.2.0)

1. **One-time** — deploy the personal Cloudflare Worker (see [`worker-template/README.md`](worker-template/README.md)). You get a `https://<sub>.workers.dev` URL and a `SHARED_SECRET` bearer.
2. **Wire it to Cue** — paste both into phone-side settings. (Skip this step and Cue runs in mock mode.)
3. Open Cue from the Even Hub launcher.
4. **Privacy notice** appears on first launch — read and accept (or decline) before the mic can be enabled.
5. Pick a mode in the phone-side settings page.
6. Put on the glasses, open Cue. The idle screen shows `◉ live` if a Worker is configured, `◌ mock` otherwise.
7. Tap glasses to start a session. With a Worker, audio streams to Deepgram and you'll see live transcript captions on glasses; suggestions arrive ~6s after each transcript update. Without a Worker, the timer-driven mock fires.
8. Glasses double-tap when not micced = cycle mode. Ring double-tap during a session = "fresh topics" prompt (date / custom modes).
9. Glasses double-tap during a session = exit (also stops mic).

## Privacy is a real feature, not boilerplate

- **Mic OFF by default** every session. No exceptions.
- **Explicit opt-in** required on first launch via a modal.
- **Mic indicator always visible** when listening — never hidden.
- **No persistence** of audio — when real STT lands in v0.2, audio streams through and is dropped. Transcripts buffered ≤3 min in Worker memory.
- **No analytics** that include conversation content.
- **You are responsible** for ensuring it's legal where you are. Recording someone without their knowledge violates two-party-consent laws in CA, FL, IL, MD, MA, MT, NH, PA, WA, and many countries.

## Modes

| Glyph | Mode | Use it for |
|---|---|---|
| ★ | **Date** | Curious, warm. Suggests questions and follow-ups. Ring-tap for fresh topics when stuck. |
| ◇ | **Argue calm** | Validating, deescalating. For tense conversations. |
| ▶ | **Sales close** | Listens for objections, suggests handlers. |
| ⚡ | **Sting** | Sharp witty comebacks. Banter mode. |
| ● | **Listen well** | Reflective listening prompts ("what I hear is…", "tell me more"). |
| ◆ | **Custom** | Use your own system prompt (write it in phone settings). |

## Glasses gestures

| Gesture | Action |
|---|---|
| Single tap (mic off) | Start mic session |
| Single tap (mic on) | Stop mic session |
| Double tap (mic off) | Cycle to next mode |
| Ring double tap (mic on) | Request fresh topics (proactive — date / custom modes) |
| Glasses double tap (mic on) | Exit app (also stops mic) |

## Development

```bash
npm install
npm run dev          # Vite dev server on :5176
npm run build        # tsc + vite build
npm run pack         # evenhub pack → cue.ehpk
npm run deploy       # build + pack
npm test             # Vitest unit tests
npm run test:watch   # Vitest watch mode
```

Test on real glasses via QR:
```bash
npx evenhub qr --url http://<your-mac-lan-ip>:5176
```

Test in simulator:
```bash
npx evenhub-simulator --glow http://localhost:5176
```

## Source files

| File | Purpose |
|---|---|
| `src/main.ts` | Entry, state machine, phone settings UI, glasses render |
| `src/even.ts` | Glasses bridge wrapper (text container, input routing, mic capture, battery) |
| `src/transport.ts` | Worker transport — chunked HTTP POST for audio + REST for suggestions |
| `src/modes.ts` | Mode registry — id, label, glyph, system prompt, behavior flags |
| `src/utterance.ts` | Pure heuristics — end-of-utterance trigger, sentence-aware trim, word wrap, battery glyph |
| `src/mock.ts` | Mock-mode timer-driven canned suggestions (fallback when Worker unset) |
| `src/storage.ts` | Native `setLocalStorage` wrapper for mode + privacy + Worker config |
| `worker-template/` | Cloudflare Worker source — Deepgram + `/suggest` LLM bridge |
| `tests/*.test.ts` | Vitest unit tests (54 passing) |
| `scripts/regression.mjs` | Simulator-driven e2e flow check (mock-fallback path, 4/4) |

## Roadmap

Full plan in `~/Documents/Pulse/ROADMAP.md` § "Plan: Cue". Remaining for v0.4+:
- Worker-side dedupe of suggestions repeating the same advice
- Retry/backoff on Deepgram or LLM rate-limit
- Partial-transcript pulses if streaming-Deepgram path becomes viable on WKWebView
- Phone-side IDLE_AUTO_PAUSE_MS setting (currently a 5-min hardcode)

## Packaging note

The Worker URL is per-user (each deployer gets their own `*.workers.dev` subdomain). Before running `npm run pack`, replace `https://your-cue-worker.example.workers.dev` in `app.json`'s `permissions[].whitelist` with your own Worker URL — otherwise the WebView in the packaged build will block the request.
