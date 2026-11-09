# TESTS — coverage matrix (Cue v0.8.0)

Last updated: 2026-11-09 (v0.8.0 wearer attribution from the Even speaker tag).

Full taxonomy + discipline: `~/.claude/skills/coverage-matrix/SKILL.md`. Empty cells block the next ship. `/ship-app` blocks if this file has unfilled cells.

## Use case × failure mode

| Use case | Happy | Bad input | Network down | Worker 401 | Mic denied | Mid-utterance lifecycle |
|---|---|---|---|---|---|---|
| Privacy gate accept on first launch | e2e:1 | n/a | n/a | n/a | n/a | n/a |
| Tap to start mock session | e2e:2 | n/a | n/a | n/a | n/a | manual |
| Tap to start real (Worker) session | manual:hw | n/a | manual:hw | manual:hw | manual:hw | manual |
| Mode cycle via double-tap | e2e:1 (idle) | n/a | n/a | n/a | n/a | n/a |
| Tap-and-hold menu: spec passes the SDK validator, ≤10 items, 32-byte labels, unique ids, no exit item, one Switch item per mode in cycle order; `menuActionFor` maps every id; `even.ts` filters invalid items, attaches `menuObject` at page creation, dispatches only numeric `menuItemClickEvent.itemID`; picking an item switches mode in the simulator | unit:menu + unit:even.audio (menu) + e2e:1b (Sting, then back to Date) | unit:menu (ids 0 / 999 → null) + unit:even.audio (all-invalid list sends no menuObject) | n/a | n/a | n/a | manual:hw (menu mid-session, Calibrate me from the glasses, Fresh topics refusals) |
| Direction tag tally: finite numbers keyed as-is, null/garbage folded to `none`, role counted per key, busiest-first summary capped for the overlay, reset on startMic | unit:audio-role (direction) + unit:even.audio (direction) | unit:audio-role (NaN, Infinity, strings) | n/a | n/a | n/a | n/a |
| What the raw direction values mean on real glasses, and whether direction alone separates a speaker across the room from the table | manual:hw (overlay `dir` line over a two-person session and one quiz night) | n/a | n/a | n/a | n/a | n/a |
| v0.8.0 attribution: role spans × utterance window → self share ≥ 0.6 of ≥ 300 ms tagged = wearer; untimed utterance judged on the whole chunk; phone mic (all unknown), no spans, or too little tagged audio → abstain; threshold exact at the boundary; verdict counters + overlay line | unit:attribution (12) | unit:attribution (reversed / missing end, empty window) | n/a | n/a | n/a | n/a |
| v0.8.0 plumbing: `even.ts` hands the role to the frame handler; `transport.ts` records ms spans per chunk (same-role runs merge, untagged defaults to unknown, fresh list per chunk, `chunkMs` from bytes) and maps Worker / direct `start`/`end` seconds to `startMs`/`endMs` (absent when missing); `appendTurn` keeps the `wearer` flag and never merges across verdicts | unit:even.audio + unit:transport (3) + unit:providers:transcribe + unit:conversation (2) | unit:transport (timing absent) | n/a | n/a | n/a | n/a |
| v0.8.0 end to end on the fake bridge: self-tagged frames mark the utterance "(you)" and keep it out of `/suggest` with the picker unset; the tag beats a wrong picker across two chunks whose ids both start at 0; setting off → tag ignored; untagged frames fall back to the picker (the v0.4 tests) | integration:audio.bridge (3 new + 2 existing) | integration:audio.bridge (setting off) | n/a | n/a | n/a | n/a |
| Whether the Even tag's 60 % / 300 ms rule attributes real utterances correctly, and how often it abstains, in a two-person session | manual:hw (overlay `who` counts vs. what was actually said; note mic source) | manual:hw | n/a | n/a | n/a | n/a |
| Third-party contract: Deepgram diarization speaker ids are numbered from 0 per request, so with chunked batch calls they never identify a person across chunks; nothing may persist or compare them across chunks (the v0.4.0–v0.4.2 picker did, found 2026-11-09) | manual:docs (Deepgram diarization docs; KNOWN_QUIRKS entry) + unit:conversation (turns never merge across `wearer` verdicts) + integration:audio.bridge (ids restarting at 0 in two chunks) | n/a | n/a | n/a | n/a | n/a |
| Mock suggestion populates on tick | e2e:3 | n/a | n/a | n/a | n/a | n/a |
| Audio capture → chunked POST | unit:transport TODO | n/a | manual:hw | manual:hw | manual:hw | manual |
| Deepgram transcribe round-trip | manual:hw | manual:hw | manual:hw | manual:hw | n/a | manual |
| Anthropic / OpenAI suggestion path | manual:hw | manual:hw | manual:hw | manual:hw | n/a | manual |
| v0.5.0 direct Deepgram call: WAV wrap, Token auth, diarize params, utterance parsing | unit:providers:transcribe | unit:providers (401 → key rejected; thrown fetch → network) | unit:providers | n/a | n/a | n/a |
| v0.5.0 direct LLM call: Anthropic browser header + version, OpenAI bearer, numbered-list parsing, prompt assembly (custom wins, do-not-repeat note) | unit:providers:suggest + unit:providers:prompt | unit:providers (429/402 explained) | unit:providers | n/a | n/a | n/a |
| Backend precedence: complete keys > Worker > mock; half-configured keys never win | unit:providers:createBestTransport | unit:providers:createBestTransport | n/a | n/a | n/a | n/a |
| Live auth against the real providers | `npm run test:backends` with keys in env (skipped otherwise) | manual | manual | n/a | n/a | n/a |
| Provider origins are whitelisted | unit:providers:whitelist + lint-app-json gap check | n/a | n/a | n/a | n/a | n/a |
| Store listing matches the build: every mode named, providers + mic + AI disclosed, Even App floor stated, field limits, every cited screenshot exists at 576×288 (`scripts/capture-store-shots.mjs` shoots one live session per mode) | unit:store-listing:5 | unit:store-listing (fails on drift) | n/a | n/a | n/a | n/a |
| End-of-utterance trigger (silence + sentence-final) | unit:utterance | unit:utterance | n/a | n/a | n/a | n/a |
| Diarization (`[A]`/`[B]` labels) | manual:hw | manual:hw | n/a | n/a | n/a | n/a |
| v0.6.0 speaker-role gate: `self` frames dropped only when the setting is on; `other`, `unknown` and untagged frames always delivered; tally resets per session | unit:even.audio (fake bridge) + unit:audio-role (literals pinned to the SDK enum) | unit:audio-role (garbage role → unknown) | n/a | n/a | n/a | unit:even.audio (stopMic clears source) |
| v0.6.0 mic source: glasses first, phone when the glasses return false or throw, failure when both refuse (no frames delivered) | unit:even.audio | n/a | n/a | n/a | unit:even.audio (both refuse) | n/a |
| Whether the Even app's `speakerRole` tag is right often enough to turn the gate on by default | manual:hw (diagnostic overlay `self/other/unk` counts over a real two-person session) | manual:hw | n/a | n/a | n/a | n/a |
| v0.7.0 Trivia mode: registry entry with `emphasizeFirstWord=false` + `dedupeSuggestions=false`, every coaching mode keeps both true, custom keeps emphasis off; glyph ◈ exists in the font; prompt assembly drops the do-not-repeat note for trivia even when recent suggestions are passed; listing names the mode and cites `06-trivia.png` | unit:modes + unit:glyphs + unit:providers:prompt + unit:store-listing | unit:modes (flags are booleans on every mode) | n/a | n/a | n/a | n/a |
| Mock pool is mode-scoped: trivia and custom cycle only the entries written for them, everything else cycles the full script | unit:mock (4 ticks each) | unit:mock (fallback to the full script when a mode has no entries) | n/a | n/a | n/a | n/a |
| Trivia in the field: can the near-field glasses mic (or the phone mic on the table) hear a quiz host over a PA in a loud room well enough for Deepgram, and does the answer land inside the answer window | manual:hw (one quiz night, Custom-free; note mic source + overlay role counts) | manual:hw | n/a | n/a | n/a | n/a |
| SDK floor: pin ≥ 0.0.16, installed = pin, `app.json` `min_sdk_version` = installed (0.0.14 / 0.0.15 re-fire timers, see KNOWN_QUIRKS) | unit:sdk-floor | unit:sdk-floor | n/a | n/a | n/a | n/a |
| Battery glyph in header updates | manual:hw | n/a | n/a | n/a | n/a | n/a |
| Idle auto-pause after 5 min | manual:hw | n/a | n/a | n/a | n/a | n/a |
| Render loop emits state logs while mic on | e2e:5 | n/a | n/a | n/a | n/a | n/a |
| Tap to stop mic returns to idle | e2e:4 | n/a | n/a | n/a | n/a | n/a |
| Every glyph drawn on the glasses exists in the firmware font — getTextWidth returns 20 for a supported symbol and 4 for the missing-glyph fallback, which draws as a box while looking fine in the editor and simulator | unit:glyphs (all mode glyphs, status indicators, battery at 8 charge levels, full non-ASCII sweep) | unit:glyphs (pins ⚡ ◉ ◼ ↳ ✓ as known-broken so the rule itself is guarded) | n/a | n/a | n/a |
| Phone panel does not overflow at iPhone widths — <main> keeps overflow-x hidden and every form control stays in the viewport (the two bugs that got Euchre v0.3.0 and Hearts v0.1.5 rejected) | `npm run test:webkit:layout` — WebKit at 320/390/430px, 18 checks | test:webkit:layout (reports the widest offending element) | n/a | n/a | manual trigger, needs `npm run dev` |
| A failing session is visible rather than silent — 2 consecutive chunk failures raise a compact glasses banner + full phone message; first good frame clears both | unit:transport-alert (9 status→label cases) | unit:transport-alert (unknown message falls back) | n/a | n/a | banner is plain ASCII; '⚠' measures 4px and would draw as a box |
| Mic permission text matches behaviour — audio never stored, transcribed text IS kept on the phone (last 50 sessions, other speakers' words only, clearable in settings) | manual:review (app.json ↔ storage.ts SessionRecord + clearSessionHistory) | n/a | n/a | n/a | **rejection-class if it drifts again** |

## By dimension (status)

- **Static:** lint+tsc ✓, app-json validation ✓, network whitelist matches code TODO, secret scan TODO
- **Unit:** 178 tests across `src/` modules — see `npm test`
- **Integration (JSDOM):** `tests/audio.bridge.test.ts` drives real-mode sessions through the fake bridge and a mocked Worker (tag attribution, picker fallback, calibrate, trailing flush); storage round-trip TODO
- **E2E:** `scripts/regression.mjs` — privacy gate + mode cycle + menu mode switch + mock suggestions + render-loop liveness (7 checks; `npm run sim` on simulator 0.9.5)
- **Worker integration:** `scripts/worker-test.mjs` (offline) covers Deepgram/Anthropic round-trip without burning credits per run
- **WebKit parity:** `scripts/test-webkit.mjs` — Playwright run against iOS-WKWebView-shaped browser
- **Hardware:** field-test log TODO (could live in PREMORTEM equivalent)
- **Performance:** 2.5s chunk latency is platform floor (per KNOWN_QUIRKS); no budgets enforced in code yet
- **Security:** no secrets in source ✓ (Worker secrets are in wrangler), bearer never logged TODO grep
- **Privacy:** mic disclosure ↔ code TODO audit; no audio persisted ✓
- **Migration:** v0.2 → v0.3 schema (end-of-utterance heuristic) — manually verified
- **Regression:** chunked-POST replaces WebSocket (per KNOWN_QUIRKS); diarization wearer-exclusion in v0.4

## Outstanding gaps before v0.4 ship

- [ ] Network whitelist consistency check (grep `fetch(` vs app.json)
- [ ] Bearer-never-logged grep
- [ ] Mic disclosure/code parity audit
- [ ] Field-test log structure (port from HandsFree PREMORTEM § A pattern)
- [ ] Storage round-trip test (jsdom)
