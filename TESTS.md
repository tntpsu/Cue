# TESTS — coverage matrix (Cue v0.3.0)

Last updated: 2026-05-05 (seeded from coverage-matrix skill).

Full taxonomy + discipline: `~/.claude/skills/coverage-matrix/SKILL.md`. Empty cells block the next ship. `/ship-app` blocks if this file has unfilled cells.

## Use case × failure mode

| Use case | Happy | Bad input | Network down | Worker 401 | Mic denied | Mid-utterance lifecycle |
|---|---|---|---|---|---|---|
| Privacy gate accept on first launch | e2e:1 | n/a | n/a | n/a | n/a | n/a |
| Tap to start mock session | e2e:2 | n/a | n/a | n/a | n/a | manual |
| Tap to start real (Worker) session | manual:hw | n/a | manual:hw | manual:hw | manual:hw | manual |
| Mode cycle via double-tap | e2e:1 (idle) | n/a | n/a | n/a | n/a | n/a |
| Mock suggestion populates on tick | e2e:3 | n/a | n/a | n/a | n/a | n/a |
| Audio capture → chunked POST | unit:transport TODO | n/a | manual:hw | manual:hw | manual:hw | manual |
| Deepgram transcribe round-trip | manual:hw | manual:hw | manual:hw | manual:hw | n/a | manual |
| Anthropic / OpenAI suggestion path | manual:hw | manual:hw | manual:hw | manual:hw | n/a | manual |
| End-of-utterance trigger (silence + sentence-final) | unit:utterance | unit:utterance | n/a | n/a | n/a | n/a |
| Diarization (`[A]`/`[B]` labels) | manual:hw | manual:hw | n/a | n/a | n/a | n/a |
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
- **Unit:** 76 tests across `src/` modules — see `npm test`
- **Integration (JSDOM):** transport/utterance flows partial; storage round-trip TODO
- **E2E:** `scripts/regression.mjs` — privacy gate + mode cycle + mock suggestions + render-loop liveness
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
