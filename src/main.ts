// Cue — multi-mode conversation coach for Even G2 glasses.
//
// See ~/Documents/Pulse/ROADMAP.md § "Plan: Cue" for the full plan.

import { connectEvenRuntime, type EvenRuntime, type InputSource, type SwipeDir } from './even'
import { DEFAULT_MODE, MODES, type Mode, type ModeId, modeById, nextMode } from './modes'
import { nextMockExchange, nextMockProactiveTopics, resetMock } from './mock'
import {
  DEFAULT_IDLE_AUTO_PAUSE_MIN,
  DEFAULT_WEARER_SPEAKER_ID,
  getCustomPrompt,
  getIdleAutoPauseMin,
  getMode,
  getShowDebugOverlay,
  getWearerSpeakerId,
  getWorkerToken,
  getWorkerUrl,
  hasAgreedToPrivacy,
  setCustomPrompt,
  setIdleAutoPauseMin,
  setMode,
  setPrivacyAgreed,
  appendSessionRecord,
  clearSessionHistory,
  getCalibrating,
  loadSessionHistory,
  setCalibrating,
  setShowDebugOverlay,
  setStorageBridge,
  setWearerSpeakerId,
  setWorkerToken,
  setWorkerUrl,
} from './storage'
import { createTransport, setTransportLogger, type CueFetchLog, type CueTransport, type TranscriptEvent } from './transport'
import {
  appendTurn,
  batteryHeaderSuffix,
  pruneTurns,
  shouldRequestSuggestion,
  speakerLabel,
  trimToSentences,
  wrapWords,
  type ConversationTurn,
} from './utterance'

// --- module state ---

let even: EvenRuntime | null = null
let currentMode: ModeId = DEFAULT_MODE
let micOn = false
let agreedToPrivacy = false
let lastTranscript = ''
let suggestions: string[] = []
let proactiveActive = false // true when user just ring-tapped for topics
let mockTimer: number | null = null
// Single tick while mic is on — handles the silence-based suggestion
// trigger, idle auto-pause, battery refresh, and stats-line repaint.
let micTickTimer: number | null = null

const MOCK_TICK_MS = 8_000

// Sliding transcript window we send to the LLM. Char budget is soft —
// trimToSentences may emit slightly less to keep sentence boundaries clean.
const TRANSCRIPT_WINDOW_CHARS = 1500
// How often the mic-tick fires while listening. 1s is fast enough to feel
// reactive on a sentence-final pause, slow enough not to hammer BLE.
const MIC_TICK_MS = 1_000
// Auto-pause after this much idle. Idle = no non-empty transcript chunk.
// 0 disables. Sourced from phone settings on bootstrap; falls back to default.
let idleAutoPauseMs = DEFAULT_IDLE_AUTO_PAUSE_MIN * 60_000

let transport: CueTransport | null = null
let isRealMode = false // true when transport.ready (Worker configured)
let liveTranscript = '' // accumulated final transcripts
let lastSuggestionAt = 0
let suggestionInFlight = false
// Tracking for shouldRequestSuggestion — set on each non-empty transcript chunk.
let lastChunkText = ''
let lastChunkAt = 0
// Tracking for idle auto-pause — set on every non-empty transcript chunk
// AND on mic-on (so the timer doesn't fire instantly on a quiet start).
let lastTranscriptAt = 0
// Cached so renderGlasses doesn't have to await. Refreshed on the mic tick.
let cachedBatteryLevel: number | undefined
// One-shot reason string shown on the idle screen after auto-pause.
// Cleared when the user manually re-engages the mic.
let autoPausedReason = ''

// v0.4.0 settings — hydrated from storage on bootstrap.
let showDebugOverlay = false  // diagnostic stats line on glasses
let wearerSpeakerId = DEFAULT_WEARER_SPEAKER_ID  // -1 = none / no filter
// v0.4.2: when true, the next non-empty utterance's speaker is anchored
// as wearer + the flag is cleared. Set by phone-side "Calibrate me".
let calibratingNow = false

// v0.4.3: session-record bookkeeping — captures mic-on → mic-off as
// one entry in the persisted session-history. Resets on each mic-on.
let sessionStartedAt = 0
let sessionSuggestionCount = 0

// v0.4.0 transcript display: per-speaker rolling buffer. Pure helpers
// in utterance.ts (appendTurn / pruneTurns / speakerLabel) — covered
// by unit tests there.
const conversation: ConversationTurn[] = []
const MAX_DISPLAYED_TURNS = 4

// Phone-side fetch debug log. Captures every /transcribe + /suggest
// call so we can see exactly what URL / status / error is happening
// when mic-on doesn't produce transcripts. In-memory, capped.
const FETCH_LOG_CAP = 50
const fetchLog: CueFetchLog[] = []
function pushFetchLog(entry: CueFetchLog): void {
  fetchLog.unshift(entry)
  if (fetchLog.length > FETCH_LOG_CAP) fetchLog.length = FETCH_LOG_CAP
  renderFetchLog()
}

function fmtAgo(ts: number): string {
  const sec = Math.round((Date.now() - ts) / 1000)
  if (sec < 60) return `${sec}s ago`
  if (sec < 3600) return `${Math.round(sec / 60)}m ago`
  return `${Math.round(sec / 3600)}h ago`
}

function renderFetchLog(): void {
  if (!fetchLogEl) return
  if (fetchLog.length === 0) {
    fetchLogEl.innerHTML = '<div style="color: #7b7b7b;">No fetches yet. Tap to start a mic session — chunks POST to /transcribe every ~2.5s.</div>'
    return
  }
  fetchLogEl.innerHTML = fetchLog
    .map(e => {
      const statusBadge = e.ok
        ? `<span style="color: #2a2;">${e.status ?? '?'}</span>`
        : `<span style="color: #c00;">${e.status ?? 'NET'}</span>`
      const ms = `${e.ms}ms`
      const bytes = e.bytes !== undefined ? ` ${(e.bytes / 1024).toFixed(1)}KB` : ''
      const err = e.error ? `<div style="color: #c00; margin-top: .15rem;">↳ ${escapeHtml(e.error)}</div>` : ''
      const url = e.url.length > 70 ? `${e.url.slice(0, 67)}…` : e.url
      return `<div style="padding: .35rem 0; border-bottom: 1px solid #f0f0f0;">
        <div style="display: flex; gap: .5rem; align-items: center;">
          <span style="color: #999; min-width: 6em;">${fmtAgo(e.ts)}</span>
          ${statusBadge}
          <span style="color: #555;">${e.method} ${ms}${bytes}</span>
        </div>
        <div style="color: #232323; word-break: break-all;">${escapeHtml(url)}</div>
        ${err}
      </div>`
    })
    .join('')
}

// --- DOM scaffold (phone-side) ---

const root = document.querySelector<HTMLDivElement>('#app')
if (!root) throw new Error('App root missing')

root.innerHTML = `
  <main style="font-family: system-ui; padding: 1rem; max-width: 720px; margin: 0 auto; color: #232323;">
    <h1 style="margin: 0 0 .25rem 0;">Cue <span style="font-size: .55em; color: #7b7b7b; font-weight: 400;">v${__APP_VERSION__}</span></h1>
    <p style="color: #7b7b7b; margin: 0 0 1rem 0;">Helps you say the right thing.</p>
    <p id="status" style="margin: 0 0 1rem 0;">Connecting…</p>

    <div id="privacy-modal" style="display: none; position: fixed; inset: 0; background: rgba(0,0,0,.6); align-items: center; justify-content: center; z-index: 100;">
      <div style="background: #fff; max-width: 520px; padding: 1.5rem; border-radius: 8px; box-shadow: 0 10px 40px rgba(0,0,0,.3);">
        <h2 style="margin: 0 0 .5rem 0;">Before you start</h2>
        <p>
          Cue records audio from the glasses microphone to suggest responses.
          Audio streams to a transcription service and is dropped — Cue never
          stores recordings.
        </p>
        <p style="font-weight: 600;">
          You are responsible for ensuring this is legal where you are.
          Recording someone without their knowledge is illegal in some
          jurisdictions (CA, FL, IL, MD, MA, MT, NH, PA, WA in the US, and
          many countries).
        </p>
        <p>
          The mic is OFF by default and requires explicit opt-in each
          session. The mic indicator stays visible whenever Cue is listening.
        </p>
        <div style="display: flex; gap: .5rem; justify-content: flex-end; margin-top: 1rem;">
          <button id="privacy-decline" type="button" style="padding: .5rem 1rem; cursor: pointer; background: #eee;">No thanks</button>
          <button id="privacy-accept" type="button" style="padding: .5rem 1rem; cursor: pointer; background: #232323; color: #fff;">I understand — continue</button>
        </div>
      </div>
    </div>

    <section>
      <h2 style="font-size: 1.1em; margin: 1rem 0 .5rem 0;">Mode</h2>
      <div id="mode-list" style="display: grid; gap: .5rem; max-width: 520px;"></div>
    </section>

    <section>
      <h2 style="font-size: 1.1em; margin: 1.5rem 0 .5rem 0;">Custom prompt (used when Mode = Custom)</h2>
      <textarea id="custom-prompt" rows="4" style="width: 100%; max-width: 520px; padding: .5rem; box-sizing: border-box; font-family: ui-monospace, monospace; font-size: .9em;" placeholder="You are a... Suggest 2-3 short responses, numbered, no preamble."></textarea>
      <button id="save-custom" type="button" style="margin-top: .35rem; padding: .35rem .7rem; cursor: pointer;">Save custom prompt</button>
    </section>

    <section>
      <h2 style="font-size: 1.1em; margin: 1.5rem 0 .5rem 0;">Worker (v0.2.0+)</h2>
      <p style="color: #7b7b7b; font-size: .9em; max-width: 520px;">
        v0.1.0 uses MOCK suggestions on a timer — no API keys needed.
        v0.2.0 onwards routes mic audio through your personal Cloudflare Worker
        for real STT + LLM. Set those credentials here in advance.
      </p>
      <div style="display: grid; gap: .25rem; max-width: 520px;">
        <label>Worker URL <input id="worker-url" type="url" placeholder="https://cue-worker.your-sub.workers.dev" style="padding: .35rem; width: 100%; box-sizing: border-box;" /></label>
        <label>Bearer token <input id="worker-token" type="password" placeholder="(SHARED_SECRET from Worker)" style="padding: .35rem; width: 100%; box-sizing: border-box; font-family: monospace;" /></label>
        <button id="save-worker" type="button" style="margin-top: .25rem; padding: .35rem .7rem; cursor: pointer; max-width: 200px;">Save Worker config</button>
        <p id="worker-status" style="color: #2a2; font-size: .85em; min-height: 1.2em;"></p>
      </div>
    </section>

    <section>
      <h2 style="font-size: 1.1em; margin: 1.5rem 0 .5rem 0;">Behavior</h2>
      <div style="display: grid; gap: .5rem; max-width: 520px;">
        <label>Auto-pause after idle (minutes; 0 disables) <input id="idle-auto-pause-min" type="number" min="0" step="1" style="padding: .35rem; width: 6em; box-sizing: border-box;" /></label>
        <button id="save-idle" type="button" style="padding: .35rem .7rem; cursor: pointer; max-width: 200px;">Save</button>
        <p id="idle-status" style="color: #2a2; font-size: .85em; min-height: 1.2em; margin: 0;"></p>

        <hr style="border: 0; border-top: 1px solid #eee; margin: .5rem 0;" />

        <label style="display: flex; align-items: center; gap: .5rem; cursor: pointer;">
          <input id="show-debug-overlay" type="checkbox" />
          Show diagnostic overlay on glasses (audio frames / chunks / errors)
        </label>
        <p style="color: #7b7b7b; font-size: .85em; margin: 0;">Off by default. Turn on when something isn't working and you want to see what's happening on-glasses.</p>

        <hr style="border: 0; border-top: 1px solid #eee; margin: .5rem 0;" />

        <label>Which speaker is you?
          <select id="wearer-speaker-id" style="padding: .35rem; margin-left: .5rem;">
            <option value="-1">None / auto-detect (don't filter)</option>
            <option value="0">Speaker A is me</option>
            <option value="1">Speaker B is me</option>
            <option value="2">Speaker C is me</option>
            <option value="3">Speaker D is me</option>
          </select>
        </label>
        <p style="color: #7b7b7b; font-size: .85em; margin: 0;">When set, your own speech is shown but excluded from the suggestion prompt — Cue suggests responses TO the other person, not echoes of you. Watch the glasses for [A]/[B]/etc labels in a real conversation, then pick yours.</p>
        <p id="wearer-status" style="color: #2a2; font-size: .85em; min-height: 1.2em; margin: 0;"></p>

        <button id="calibrate-me" type="button" style="padding: .35rem .7rem; cursor: pointer; max-width: 220px; margin-top: .25rem;">Calibrate me (one-tap)</button>
        <p style="color: #7b7b7b; font-size: .85em; margin: 0;">Tap, put on glasses, say "this is me" — the next utterance Deepgram detects becomes your speaker ID. Replaces the dropdown above.</p>
        <p id="calibrate-status" style="color: #2a2; font-size: .85em; min-height: 1.2em; margin: 0;"></p>
      </div>
    </section>

    <section style="margin-top: 2rem;">
      <details>
        <summary style="cursor: pointer; color: #232323;">Past sessions (review your conversations)</summary>
        <p style="color: #7b7b7b; margin: .5rem 0; font-size: .85em; max-width: 520px;">
          Last 50 mic sessions. Stored locally on this device (Even Hub's
          per-app storage) — never sent to any server beyond what the live
          /transcribe + /suggest calls already do.
        </p>
        <div style="display: flex; gap: .5rem; margin-bottom: .5rem;">
          <button id="session-history-clear" type="button" style="padding: .35rem .7rem; cursor: pointer; background: #eee;">Clear all</button>
          <button id="session-history-refresh" type="button" style="padding: .35rem .7rem; cursor: pointer; background: #eee;">Refresh</button>
        </div>
        <div id="session-history" style="max-width: 720px; max-height: 360px; overflow-y: auto; font-size: .85em; border: 1px solid #ddd; padding: .5rem;"></div>
      </details>
    </section>

    <section style="margin-top: 2rem;">
      <details>
        <summary style="cursor: pointer; color: #232323;">Recent fetches (debug)</summary>
        <p style="color: #7b7b7b; margin: .5rem 0; font-size: .85em; max-width: 520px;">
          Last 50 calls to your Worker (/transcribe + /suggest) with status, latency,
          and any error message. Use this to figure out why mic-on isn't producing
          transcripts — 405 = wrong/old worker URL, 401 = bearer mismatch,
          500 with "DEEPGRAM_API_KEY" = worker secret missing.
        </p>
        <div style="display: flex; gap: .5rem; margin-bottom: .5rem;">
          <button id="fetch-log-clear" type="button" style="padding: .35rem .7rem; cursor: pointer; background: #eee;">Clear</button>
          <button id="fetch-log-refresh" type="button" style="padding: .35rem .7rem; cursor: pointer; background: #eee;">Refresh</button>
        </div>
        <div id="fetch-log" style="max-width: 720px; max-height: 320px; overflow-y: auto; font-family: ui-monospace, monospace; font-size: .8em; border: 1px solid #ddd; padding: .5rem;"></div>
      </details>
    </section>

    <section style="margin-top: 2rem; color: #7b7b7b; font-size: .85em;">
      <h3 style="font-size: 1em; margin: 0 0 .5rem 0;">How to use</h3>
      <ol style="padding-left: 1.25rem; line-height: 1.5;">
        <li>Pick a mode from the list above.</li>
        <li>Put on the glasses and open Cue from the Even Hub launcher.</li>
        <li>Tap glasses to toggle mic on/off (privacy escape: glasses double-tap or remove glasses).</li>
        <li>v0.1.0 produces mock suggestions on a timer so you can try the flow. Real STT + LLM lands in v0.2+.</li>
      </ol>
    </section>
  </main>
`

const status = document.querySelector<HTMLParagraphElement>('#status')!
const modeList = document.querySelector<HTMLDivElement>('#mode-list')!
const customPromptInput = document.querySelector<HTMLTextAreaElement>('#custom-prompt')!
const saveCustomBtn = document.querySelector<HTMLButtonElement>('#save-custom')!
const workerUrlInput = document.querySelector<HTMLInputElement>('#worker-url')!
const workerTokenInput = document.querySelector<HTMLInputElement>('#worker-token')!
const saveWorkerBtn = document.querySelector<HTMLButtonElement>('#save-worker')!
const workerStatus = document.querySelector<HTMLParagraphElement>('#worker-status')!
const privacyModal = document.querySelector<HTMLDivElement>('#privacy-modal')!
const privacyAccept = document.querySelector<HTMLButtonElement>('#privacy-accept')!
const privacyDecline = document.querySelector<HTMLButtonElement>('#privacy-decline')!
const idleAutoPauseInput = document.querySelector<HTMLInputElement>('#idle-auto-pause-min')!
const saveIdleBtn = document.querySelector<HTMLButtonElement>('#save-idle')!
const idleStatus = document.querySelector<HTMLParagraphElement>('#idle-status')!
const showDebugOverlayInput = document.querySelector<HTMLInputElement>('#show-debug-overlay')!
const wearerSpeakerSelect = document.querySelector<HTMLSelectElement>('#wearer-speaker-id')!
const wearerStatus = document.querySelector<HTMLParagraphElement>('#wearer-status')!
const calibrateBtn = document.querySelector<HTMLButtonElement>('#calibrate-me')!
const calibrateStatus = document.querySelector<HTMLParagraphElement>('#calibrate-status')!

calibrateBtn.addEventListener('click', async () => {
  await setCalibrating(true)
  calibratingNow = true
  calibrateStatus.style.color = '#2a2'
  calibrateStatus.textContent = 'Listening for your voice — say "this is me" within ~10s.'
  window.setTimeout(() => { calibrateStatus.textContent = '' }, 12_000)
})

showDebugOverlayInput.addEventListener('change', async () => {
  showDebugOverlay = showDebugOverlayInput.checked
  await setShowDebugOverlay(showDebugOverlay)
  void paint()
})

wearerSpeakerSelect.addEventListener('change', async () => {
  const id = Number.parseInt(wearerSpeakerSelect.value, 10)
  wearerSpeakerId = Number.isFinite(id) ? id : DEFAULT_WEARER_SPEAKER_ID
  await setWearerSpeakerId(wearerSpeakerId)
  wearerStatus.style.color = '#2a2'
  wearerStatus.textContent = wearerSpeakerId < 0
    ? 'Auto-detect: no filter applied; suggestions consider all speech.'
    : `Speaker ${speakerLabel(wearerSpeakerId)} = you. Your lines won't be sent to the suggestion model.`
  window.setTimeout(() => { wearerStatus.textContent = '' }, 5000)
  void paint()
})

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

function renderModeList(): void {
  modeList.innerHTML = MODES.map(
    m => `
    <label style="display: flex; gap: .75rem; align-items: flex-start; padding: .6rem .75rem; background: ${m.id === currentMode ? '#fef991' : '#eee'}; border-radius: 4px; cursor: pointer;">
      <input type="radio" name="mode" value="${m.id}" ${m.id === currentMode ? 'checked' : ''} style="margin-top: .2rem;" />
      <div style="flex: 1;">
        <div><span style="margin-right: .5rem;">${m.glyph}</span><strong>${escapeHtml(m.label)}</strong></div>
        <div style="color: #555; font-size: .85em; margin-top: .15rem;">${escapeHtml(m.description)}</div>
      </div>
    </label>
  `,
  ).join('')
  modeList.querySelectorAll<HTMLInputElement>('input[name="mode"]').forEach(input => {
    input.addEventListener('change', async () => {
      currentMode = input.value as ModeId
      await setMode(currentMode)
      renderModeList()
      await paint()
    })
  })
}

// --- glasses display ---

function trunc(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s
}

// Width budget per line on the 576-px greyscale display, derived from the
// existing trunc-to-38 the v0.2 build used. Two lines per suggestion is the
// sweet spot — enough room to land a question without dropping context.
const LINE_WIDTH = 38
const SUGGESTION_MAX_LINES = 2

// Per-mode prefix glyph for suggestions — gives the user a visual cue of
// which coach they're hearing without re-reading the header. Numbers stay
// for accessibility ordering.
const MODE_BULLET: Record<ModeId, string> = {
  date: '★',
  'argue-calm': '◇',
  'sales-close': '▶',
  sting: '▲',
  listen: '●',
  interview: '▣',
  custom: '◆',
}

function emphasizeFirstWord(s: string): string {
  // Cheap proxy for "imperative-verb emphasis": uppercase the first word.
  // The LLM's suggestion templates put the action verb first in every
  // mode prompt, so this lands the eye on the right word without any
  // English-NLP gymnastics.
  const m = /^(\S+)(\s.*)?$/.exec(s.trim())
  if (!m) return s
  const [, first, rest] = m
  return `${first!.toUpperCase()}${rest ?? ''}`
}

function renderGlasses(): string {
  const mode: Mode = modeById(currentMode)
  const micGlyph = micOn ? '●' : '○'
  const battery = batteryHeaderSuffix(cachedBatteryLevel)
  // Header is fixed-width-ish: mode label left, mic state center, battery right.
  const header = `${mode.glyph} ${mode.label.toUpperCase()}  ${micGlyph} ${micOn ? 'LIVE' : 'mic off'}${battery ? `  ${battery}` : ''}`
  if (!agreedToPrivacy) {
    return [
      header,
      '',
      'Cue needs your consent before',
      'turning on the mic. Open Cue',
      'on your phone first to review',
      'and accept the privacy notice.',
    ].join('\n')
  }
  if (!micOn) {
    const idleLines: string[] = [
      header,
      '',
      `Mode: ${mode.label}`,
      mode.description.length > 64 ? trunc(mode.description, 64) : mode.description,
      '',
    ]
    if (autoPausedReason) {
      idleLines.push(autoPausedReason)
      idleLines.push('')
    }
    idleLines.push(`${isRealMode ? '◎ live' : '◌ mock'} ready`)
    idleLines.push('[tap] start mic')
    idleLines.push('[2x] cycle mode')
    return idleLines.join('\n')
  }
  // Live view.
  const lines: string[] = [header, '']
  // v0.4.0: render up to MAX_DISPLAYED_TURNS of the rolling conversation
  // with [A]/[B] speaker labels. Wearer's turns marked "(you)" so the
  // user knows we're filtering them from the suggestion context.
  pruneTurns(conversation, Date.now())
  const recent = conversation.slice(-MAX_DISPLAYED_TURNS)
  if (recent.length > 0) {
    for (const turn of recent) {
      const label = speakerLabel(turn.speaker)
      const youMarker = turn.speaker === wearerSpeakerId ? ' (you)' : ''
      lines.push(trunc(`[${label}${youMarker}] ${turn.text}`, 76))
    }
  } else if (lastTranscript) {
    // Mock mode + early frames before any conversation turn lands.
    lines.push(trunc(lastTranscript, 100))
  } else {
    lines.push(proactiveActive ? 'Fresh topics:' : 'Listening…')
  }
  // Diagnostic stats — gated on showDebugOverlay. Default OFF; toggle
  // on via phone-side "Show diagnostic overlay on glasses." Same info
  // as before: audio frames flowing, chunk success rate, last error.
  if (showDebugOverlay && isRealMode && transport) {
    const s = transport.stats()
    lines.push(`audio frames=${s.framesReceived} chunks=${s.chunksFlushed}/${s.chunksOk}ok`)
    if (s.lastError) {
      lines.push(`err: ${s.lastError}`)
    }
  }
  lines.push('')
  lines.push('—'.repeat(20))
  if (suggestions.length > 0) {
    const bullet = MODE_BULLET[currentMode] ?? '·'
    const isCustom = currentMode === 'custom'
    suggestions.slice(0, 3).forEach((s, i) => {
      const label = isCustom ? s.trim() : emphasizeFirstWord(s)
      const prefix = `${i + 1}.${bullet} `
      const wrapped = wrapWords(label, LINE_WIDTH - prefix.length, SUGGESTION_MAX_LINES)
      wrapped.forEach((ln, j) => {
        lines.push(j === 0 ? `${prefix}${ln}` : `${' '.repeat(prefix.length)}${ln}`)
      })
    })
  } else {
    lines.push('(suggestions appear here)')
  }
  lines.push('')
  lines.push(mode.proactiveSupported ? '[ring 2x] topics  [tap] mic' : '[tap] toggle mic')
  return lines.join('\n')
}

async function paint(): Promise<void> {
  if (!even) return
  const tag = !agreedToPrivacy ? 'gate' : !micOn ? 'idle' : proactiveActive ? 'proactive' : 'live'
  // eslint-disable-next-line no-console
  console.log(`[cue:state] mode=${currentMode} mic=${micOn ? 'on' : 'off'} stage=${tag} suggestions=${suggestions.length}`)
  await even.render(renderGlasses())
}

// --- mock-mode driver ---

function startMockTimer(): void {
  stopMockTimer()
  // Fire one immediately so the user sees something on tap-to-start.
  void runMockTick()
  mockTimer = window.setInterval(() => void runMockTick(), MOCK_TICK_MS)
}

function stopMockTimer(): void {
  if (mockTimer !== null) {
    window.clearInterval(mockTimer)
    mockTimer = null
  }
}

async function runMockTick(): Promise<void> {
  if (!micOn) return
  if (proactiveActive) return // ring-tap-driven topics override the reactive cycle until cleared
  const next = nextMockExchange(currentMode)
  lastTranscript = next.transcript
  suggestions = next.suggestions
  await paint()
}

async function showProactiveTopics(): Promise<void> {
  if (!micOn) return
  const mode = modeById(currentMode)
  if (!mode.proactiveSupported) return
  proactiveActive = true
  lastTranscript = '' // hide transcript area while showing fresh topics
  suggestions = nextMockProactiveTopics(currentMode)
  await paint()
  // Auto-clear after 12s and resume reactive cycle.
  window.setTimeout(() => {
    proactiveActive = false
    void paint()
  }, 12_000)
}

// --- input handlers ---

async function toggleMic(): Promise<void> {
  if (!agreedToPrivacy) return
  micOn = !micOn
  suggestions = []
  lastTranscript = ''
  liveTranscript = ''
  proactiveActive = false
  if (micOn) {
    // User re-engaged after auto-pause — clear the stale notice.
    autoPausedReason = ''
    lastTranscriptAt = Date.now()
    lastChunkAt = Date.now()
    lastChunkText = ''
    // v0.4.3: start a new session record; reset counters
    sessionStartedAt = Date.now()
    sessionSuggestionCount = 0
    // Reset the LLM transcript window so the new session starts fresh
    liveTranscript = ''
    if (isRealMode && transport && even) {
      await startRealSession()
    } else {
      resetMock()
      startMockTimer()
    }
    startMicTick()
  } else {
    stopMockTimer()
    stopMicTick()
    if (transport) await transport.endMicSession()
    if (even) await even.stopMic()
    // v0.4.3: persist the session record (only if we accumulated something —
    // skip empty sessions where the user toggled mic on/off in <1s).
    if (sessionStartedAt > 0 && liveTranscript.trim().length > 0) {
      void appendSessionRecord({
        startedAt: sessionStartedAt,
        endedAt: Date.now(),
        mode: currentMode,
        transcript: liveTranscript,
        suggestionCount: sessionSuggestionCount,
      }).then(() => renderSessionHistory())
    }
  }
  await paint()
}

function startMicTick(): void {
  stopMicTick()
  micTickTimer = window.setInterval(() => void micTick(), MIC_TICK_MS)
}

function stopMicTick(): void {
  if (micTickTimer !== null) {
    window.clearInterval(micTickTimer)
    micTickTimer = null
  }
}

async function micTick(): Promise<void> {
  if (!micOn) return
  const now = Date.now()
  // Idle auto-pause: no non-empty transcript for idleAutoPauseMs.
  // 0 disables — user can opt out via phone settings.
  if (idleAutoPauseMs > 0 && now - lastTranscriptAt > idleAutoPauseMs) {
    autoPausedReason = `Auto-paused after ${Math.round(idleAutoPauseMs / 60_000)} min idle`
    await toggleMic() // turns mic off + repaints
    return
  }
  // Refresh battery cache (cheap — usually returns the pushed value).
  if (even) {
    try { cachedBatteryLevel = await even.getBatteryLevel() } catch { /* ignore */ }
  }
  // Silence-driven suggestion trigger — sentence-final fires on transcript
  // arrival; this catches the case where the user simply stops talking.
  if (isRealMode) void maybeRequestSuggestions()
  await paint()
}

// --- real (Worker-backed) session ---

async function startRealSession(): Promise<void> {
  if (!transport || !even) return
  liveTranscript = ''
  lastSuggestionAt = 0
  // Transport now uses chunked HTTP POST instead of WebSocket (the WebView
  // blocks outbound WS handshakes — see transport.ts header comment).
  // startMicSession throws on worker-unreachable / probe-failed; per-chunk
  // network blips during the session come back via the onError callback.
  try {
    await transport.startMicSession(onTranscriptFrame, msg => {
      // Per-chunk transport error mid-session. Log but don't kill the
      // session; the next chunk still has a chance.
      // eslint-disable-next-line no-console
      console.warn('[cue] transcribe error:', msg)
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    lastTranscript = `(real-mode unavailable: ${msg.slice(0, 80)})`
    // eslint-disable-next-line no-console
    console.error('[cue] real-mode startMicSession failed:', msg)
    isRealMode = false
    resetMock()
    startMockTimer()
    await paint()
    return
  }
  // Ask the SDK to start the mic. PCM frames flow into transport via
  // sendAudioFrame; transport buffers and POSTs every CHUNK_MS.
  const ok = await even.startMic(frame => {
    transport?.sendAudioFrame(frame)
  })
  if (!ok) {
    lastTranscript = '(mic permission denied)'
    isRealMode = false
    await transport.endMicSession()
    resetMock()
    startMockTimer()
    await paint()
    return
  }
  lastTranscript = '(listening — say something)'
  await paint()
}

function onTranscriptFrame(e: TranscriptEvent): void {
  // v0.4.0: prefer per-speaker utterances when available so we can show
  // [A]/[B] labels and exclude the wearer's own words from the suggestion
  // prompt. Falls back to whole-chunk text when the worker / Deepgram
  // didn't return utterances (older worker or single-speaker chunk).
  const turns = e.utterances && e.utterances.length > 0
    ? e.utterances.map(u => ({ speaker: u.speaker, text: u.text }))
    : (e.text.trim().length > 0 ? [{ speaker: 0, text: e.text.trim() }] : [])

  // Accumulate into the conversation (same-speaker turns merge so words
  // stream in until the speaker actually changes).
  for (const t of turns) {
    appendTurn(conversation, t.speaker, t.text, Date.now())
  }

  // v0.4.2 calibrate-me: if the user just tapped "Calibrate me" on the
  // phone, anchor the FIRST non-empty speaker we see as wearer + clear
  // the one-shot flag. Persists to storage so it survives reload.
  if (calibratingNow && turns.length > 0) {
    const firstSpeaker = turns[0].speaker
    wearerSpeakerId = firstSpeaker
    calibratingNow = false
    void setWearerSpeakerId(firstSpeaker)
    void setCalibrating(false)
    // Reflect in the UI immediately
    if (wearerSpeakerSelect) wearerSpeakerSelect.value = String(firstSpeaker)
    if (calibrateStatus) {
      calibrateStatus.style.color = '#2a2'
      calibrateStatus.textContent = `Got it — Speaker ${speakerLabel(firstSpeaker)} is you.`
      window.setTimeout(() => { calibrateStatus.textContent = '' }, 5_000)
    }
  }

  // Build the rolling LLM-context buffer EXCLUDING the wearer's lines
  // (so suggestions are responses TO the other person, not echoes of
  // what the wearer just said).
  if (e.isFinal) {
    const otherLines = turns
      .filter(t => wearerSpeakerId < 0 || t.speaker !== wearerSpeakerId)
      .map(t => t.text)
      .join(' ')
    if (otherLines.trim().length > 0) {
      liveTranscript = trimToSentences(`${liveTranscript} ${otherLines}`, TRANSCRIPT_WINDOW_CHARS)
      lastChunkText = otherLines
      lastChunkAt = Date.now()
    }
    // Idle auto-pause is "any speech," not "other-only" — we don't want
    // a wearer-only chunk to be considered idle.
    if (e.text.trim().length > 0) lastTranscriptAt = Date.now()
    void maybeRequestSuggestions()
  }
  // Keep lastTranscript for the (now-deprecated) single-line fallback,
  // but renderGlasses now reads from `conversation` directly.
  lastTranscript = e.text
  void paint()
}

async function maybeRequestSuggestions(): Promise<void> {
  if (!transport || !isRealMode) return
  const fire = shouldRequestSuggestion(
    {
      lastChunkText,
      lastChunkAt,
      lastSuggestionAt,
      inFlight: suggestionInFlight,
      transcriptLen: liveTranscript.length,
    },
    Date.now(),
  )
  if (!fire) return
  suggestionInFlight = true
  lastSuggestionAt = Date.now()
  sessionSuggestionCount += 1
  try {
    const customPrompt = currentMode === 'custom' ? await getCustomPrompt() : undefined
    const result = await transport.requestSuggestions({
      mode: currentMode,
      transcript: liveTranscript,
      customPrompt,
      // v0.4.2: send recent suggestions so worker can dedupe — no LLM
      // re-emitting the same advice 3 times in a row.
      recentSuggestions: recentSuggestionsRing.slice(),
    })
    if (result.ok) {
      suggestions = result.suggestions
      // Track the new suggestions for next-call dedupe.
      for (const s of result.suggestions) {
        recentSuggestionsRing.push(s)
      }
      while (recentSuggestionsRing.length > RECENT_SUGGESTIONS_CAP) {
        recentSuggestionsRing.shift()
      }
    } else {
      suggestions = [`(LLM error: ${result.error.slice(0, 40)})`]
    }
    await paint()
  } finally {
    suggestionInFlight = false
  }
}

// Rolling buffer of recent LLM suggestions, sent with each /suggest call
// so the worker can instruct the LLM "don't repeat these." Capped to a
// reasonable history; older suggestions roll off naturally.
const RECENT_SUGGESTIONS_CAP = 12
const recentSuggestionsRing: string[] = []

async function cycleMode(): Promise<void> {
  currentMode = nextMode(currentMode)
  await setMode(currentMode)
  renderModeList()
  await paint()
}

function onTap(_src: InputSource): void {
  if (!agreedToPrivacy) return // require phone-side opt-in first
  if (!micOn) {
    void toggleMic()
    return
  }
  // Mic on: tap toggles mic off (so the user can pause quickly).
  void toggleMic()
}

function onDoubleTap(source: InputSource): void {
  if (!agreedToPrivacy) {
    if (even) void even.exitApp()
    return
  }
  if (!micOn) {
    // Idle: cycle mode regardless of source.
    void cycleMode()
    return
  }
  // Mic on, ring 2x = proactive topics; glasses 2x = exit (stops mic too).
  if (source === 'ring') {
    void showProactiveTopics()
    return
  }
  if (even) {
    micOn = false
    stopMockTimer()
    stopMicTick()
    void even.exitApp()
  }
}

function onSwipe(_dir: SwipeDir): void {
  // Reserved for v0.2+ — could let the user scroll back through the
  // transcript buffer or page through more suggestions.
}

// --- privacy modal handlers ---

privacyAccept.addEventListener('click', async () => {
  agreedToPrivacy = true
  await setPrivacyAgreed()
  privacyModal.style.display = 'none'
  await paint()
})
privacyDecline.addEventListener('click', () => {
  privacyModal.style.display = 'none'
  status.textContent = 'Privacy notice declined. You can re-open Cue anytime to accept.'
})

// --- form handlers ---

saveCustomBtn.addEventListener('click', async () => {
  await setCustomPrompt(customPromptInput.value)
  saveCustomBtn.textContent = 'Saved ✓'
  window.setTimeout(() => { saveCustomBtn.textContent = 'Save custom prompt' }, 2000)
})

// Wire fetch log accessors + handlers (must come BEFORE bootstrap so
// renderFetchLog has a target element when the first chunk fires).
const fetchLogEl = document.querySelector<HTMLDivElement>('#fetch-log')!
const fetchLogClearBtn = document.querySelector<HTMLButtonElement>('#fetch-log-clear')!
const fetchLogRefreshBtn = document.querySelector<HTMLButtonElement>('#fetch-log-refresh')!
fetchLogClearBtn.addEventListener('click', () => { fetchLog.length = 0; renderFetchLog() })
fetchLogRefreshBtn.addEventListener('click', () => renderFetchLog())
setTransportLogger(pushFetchLog)
renderFetchLog()

// v0.4.3 — Session history panel (past mic sessions)
const sessionHistoryEl = document.querySelector<HTMLDivElement>('#session-history')!
const sessionHistoryClearBtn = document.querySelector<HTMLButtonElement>('#session-history-clear')!
const sessionHistoryRefreshBtn = document.querySelector<HTMLButtonElement>('#session-history-refresh')!
sessionHistoryClearBtn.addEventListener('click', async () => {
  if (!confirm('Delete all past session records? This cannot be undone.')) return
  await clearSessionHistory()
  await renderSessionHistory()
})
sessionHistoryRefreshBtn.addEventListener('click', () => { void renderSessionHistory() })

function fmtSessionDuration(start: number, end: number): string {
  const s = Math.round((end - start) / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  const rs = s % 60
  return rs === 0 ? `${m}m` : `${m}m ${rs}s`
}

function fmtSessionDate(ts: number): string {
  const d = new Date(ts)
  const today = new Date()
  const sameDay = d.toDateString() === today.toDateString()
  if (sameDay) return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

async function renderSessionHistory(): Promise<void> {
  if (!sessionHistoryEl) return
  const records = await loadSessionHistory()
  if (records.length === 0) {
    sessionHistoryEl.innerHTML = '<div style="color: #7b7b7b; padding: .5rem;">No past sessions yet. Sessions are saved when you toggle mic off after capturing some transcript.</div>'
    return
  }
  sessionHistoryEl.innerHTML = records
    .map(r => {
      const preview = r.transcript.length > 200 ? `${r.transcript.slice(0, 200)}…` : r.transcript
      return `<div style="padding: .5rem; border-bottom: 1px solid #f0f0f0;">
        <div style="display: flex; gap: .5rem; align-items: center; color: #555;">
          <strong>${escapeHtml(r.mode)}</strong>
          <span>${fmtSessionDate(r.startedAt)}</span>
          <span>· ${fmtSessionDuration(r.startedAt, r.endedAt)}</span>
          <span>· ${r.suggestionCount} suggestion${r.suggestionCount === 1 ? '' : 's'}</span>
        </div>
        <div style="margin-top: .25rem; color: #232323; line-height: 1.4;">${escapeHtml(preview)}</div>
      </div>`
    })
    .join('')
}

// Initial render + re-render after each mic session ends.
void renderSessionHistory()

saveIdleBtn.addEventListener('click', async () => {
  const raw = Number.parseInt(idleAutoPauseInput.value, 10)
  const min = Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_IDLE_AUTO_PAUSE_MIN
  await setIdleAutoPauseMin(min)
  idleAutoPauseMs = min * 60_000
  idleAutoPauseInput.value = String(min)
  idleStatus.style.color = '#2a2'
  idleStatus.textContent = min === 0
    ? 'Saved. Auto-pause disabled.'
    : `Saved. Mic will auto-pause after ${min} min idle.`
  window.setTimeout(() => { idleStatus.textContent = '' }, 4000)
})

saveWorkerBtn.addEventListener('click', async () => {
  await setWorkerUrl(workerUrlInput.value)
  await setWorkerToken(workerTokenInput.value)
  // Re-initialize transport so the next mic session uses the new config.
  transport = createTransport(workerUrlInput.value.trim(), workerTokenInput.value.trim())
  isRealMode = transport.ready
  workerStatus.style.color = '#2a2'
  workerStatus.textContent = isRealMode
    ? 'Saved. Real STT + LLM active on next mic session.'
    : 'Saved (URL + token incomplete — mock mode will run).'
  window.setTimeout(() => { workerStatus.textContent = '' }, 4000)
  // Force an immediate glasses repaint so the ◎ live / ◌ mock indicator
  // reflects the new state without waiting for the next user gesture.
  void paint()
})

// --- bootstrap ---

async function bootstrap(): Promise<void> {
  // eslint-disable-next-line no-console
  console.log('[cue] bootstrap start')
  status.textContent = 'Connecting to glasses…'
  even = await connectEvenRuntime(`Cue v${__APP_VERSION__}\n\nLoading…`)

  if (even) {
    setStorageBridge({ getStorage: even.getStorage, setStorage: even.setStorage })
  }

  // Hydrate state.
  agreedToPrivacy = await hasAgreedToPrivacy()
  // In dev mode (Vite dev server), auto-accept the privacy gate so the
  // simulator regression test and developer workflow aren't blocked by
  // the phone-side modal. Production .ehpk installs run with
  // import.meta.env.DEV === false and require explicit user opt-in.
  if (!agreedToPrivacy && import.meta.env.DEV) {
    agreedToPrivacy = true
    await setPrivacyAgreed()
    // eslint-disable-next-line no-console
    console.log('[cue:state] dev-mode auto-accepted privacy (production requires real opt-in)')
  }
  const persistedMode = await getMode()
  if (persistedMode) currentMode = persistedMode
  customPromptInput.value = await getCustomPrompt()
  const wUrl = await getWorkerUrl()
  const wTok = await getWorkerToken()
  workerUrlInput.value = wUrl
  workerTokenInput.value = wTok
  const idleMin = await getIdleAutoPauseMin()
  idleAutoPauseInput.value = String(idleMin)
  idleAutoPauseMs = idleMin * 60_000
  // Hydrate v0.4.0 toggles.
  showDebugOverlay = await getShowDebugOverlay()
  showDebugOverlayInput.checked = showDebugOverlay
  wearerSpeakerId = await getWearerSpeakerId()
  wearerSpeakerSelect.value = String(wearerSpeakerId)
  calibratingNow = await getCalibrating()
  // Set up transport if both Worker URL + token are configured. If they're
  // unset or change later, mock mode runs.
  transport = createTransport(wUrl, wTok)
  isRealMode = transport.ready
  renderModeList()

  if (!agreedToPrivacy) {
    privacyModal.style.display = 'flex'
  }

  if (!even) {
    status.textContent = 'Running outside the Even runtime — browser preview only.'
    return
  }
  status.textContent = agreedToPrivacy
    ? 'Glasses connected. Use them to start a session.'
    : 'Glasses connected. Accept the privacy notice to enable mic.'

  even.onTap(onTap)
  even.onSwipe(onSwipe)
  even.onDoubleTap(onDoubleTap)
  even.onForeground(() => { void paint() })

  // One-shot battery read so the idle screen shows the glyph before the
  // first mic-tick. The tick keeps it fresh while mic is on; without this
  // call the battery glyph is invisible on every cold-start idle render.
  try { cachedBatteryLevel = await even.getBatteryLevel() } catch { /* ignore */ }

  await paint()
}

void bootstrap().catch(err => {
  // eslint-disable-next-line no-console
  console.error('[cue] bootstrap threw:', err?.message ?? err, err?.stack)
})
