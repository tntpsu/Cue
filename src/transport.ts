// Transport layer: chunked audio → transcript → suggestions, over one of two
// backends. The Worker backend (the original) POSTs to the user's personal
// Cloudflare Worker; the direct backend (v0.5.0) talks to Deepgram and the
// LLM itself with keys from phone settings, which is what makes Cue
// installable from the store (see providers.ts). Both share the chunking,
// flush, stats and logging below; only "how to transcribe a chunk" and
// "how to get suggestions" differ.
//
// All communication goes through fetch() — never WebSocket — because the
// Even Hub WebView (at least on iOS) blocks outbound `new WebSocket()`
// during handshake even when the network whitelist permits the host.
// `WS open failed` was the symptom; chunked HTTP POST is the workaround.
//
// Two flows:
//   1. POST /transcribe — plugin buffers ~CHUNK_MS of PCM16 audio, then
//      POSTs the raw buffer. Worker wraps as WAV, calls Deepgram batch,
//      returns { text }. Trade-off vs streaming WS: ~CHUNK_MS latency
//      added, no interim transcripts.
//   2. POST /suggest — same as before; sends transcript context, gets
//      back numbered suggestions list.
//
// Both gated on a SHARED_SECRET bearer the user pasted into phone settings.
// If the user hasn't configured a Worker, transport.ready returns false
// and main.ts falls back to mock-mode suggestions.

import {
  transcribeDirect, suggestDirect, buildSystemPrompt, DEEPGRAM_LISTEN_URL,
  ANTHROPIC_MESSAGES_URL, OPENAI_CHAT_URL, toArrayBuffer, type DirectKeys,
} from './providers'

export interface TranscriptUtterance {
  speaker: number  // Deepgram-assigned speaker id (0, 1, 2, ...)
  text: string
  confidence: number
}

export interface TranscriptEvent {
  type: 'transcript'
  text: string  // joined transcript for the chunk (back-compat)
  isFinal: boolean
  // v0.4.0: per-speaker turns within the chunk. Empty array if Deepgram
  // returned no utterances field (older worker, single-speaker chunk, etc).
  utterances: TranscriptUtterance[]
}

export interface CueTransport {
  ready: boolean
  startMicSession: (onTranscript: (e: TranscriptEvent) => void, onError: (msg: string) => void) => Promise<void>
  sendAudioFrame: (frame: Uint8Array) => void
  endMicSession: () => Promise<void>
  requestSuggestions: (params: {
    mode: string
    transcript: string
    customPrompt?: string
    /** v0.4.2: rolling list of recent suggestions; worker adds a "don't repeat these" instruction to the LLM prompt. */
    recentSuggestions?: string[]
  }) => Promise<{ ok: true; suggestions: string[] } | { ok: false; error: string }>
  /** Diagnostic stats — used by the UI to show whether audio is flowing. */
  stats: () => { framesReceived: number; bytesReceived: number; chunksFlushed: number; chunksOk: number; lastError: string }
}

// Per-fetch debug log entry — captured for every /transcribe and /suggest
// call so the phone-side debug panel can show exactly what URL was hit,
// what the worker said, and how long it took. Decoupled via a callback
// so transport.ts stays UI-free.
export interface CueFetchLog {
  ts: number
  url: string
  method: string
  status: number | null    // null = network failure / aborted
  ms: number
  ok: boolean
  error?: string           // user-friendly summary
  bytes?: number           // request body size
}

let logSink: ((entry: CueFetchLog) => void) | null = null
export function setTransportLogger(sink: ((entry: CueFetchLog) => void) | null): void {
  logSink = sink
}

function explainHttp(status: number, body: string): string {
  if (status === 401) return 'Worker rejected bearer token. Check SHARED_SECRET in phone settings matches the value you set on the Worker.'
  if (status === 405) return `Worker route exists but rejected the method. Most likely your Worker URL is OLD or wrong — verify it points at your latest deploy. (Body: ${body.slice(0, 80)})`
  if (status === 404) return 'Worker URL responded but /transcribe route is missing. Re-deploy worker-template/ to pick up the latest endpoint.'
  if (status === 500) {
    if (body.includes('DEEPGRAM_API_KEY not configured')) {
      return 'Worker is missing DEEPGRAM_API_KEY. Run `npx wrangler secret put DEEPGRAM_API_KEY` in worker-template/.'
    }
    return `Worker internal error: ${body.slice(0, 120)}`
  }
  if (status === 429) return 'Deepgram rate-limited the worker. Slow down or check your Deepgram quota.'
  if (status >= 500) return `Worker upstream error (${status}): ${body.slice(0, 120)}`
  if (status === 0) return 'Network failure (CORS, DNS, or no connectivity).'
  return `HTTP ${status}: ${body.slice(0, 120)}`
}

// Audio chunking — keep low enough that the user feels live, high enough
// that Deepgram batch latency + chunk-boundary inaccuracy stays tolerable.
// 2.5s is the empirical sweet spot for a coaching app where the LLM
// /suggest step debounces at 6s anyway.
const SAMPLE_RATE = 16000
const BYTES_PER_SECOND = SAMPLE_RATE * 2 // 16-bit mono
const CHUNK_MS = 2500
const CHUNK_BYTES = Math.round((BYTES_PER_SECOND * CHUNK_MS) / 1000)
const MIN_CHUNK_BYTES = Math.round(BYTES_PER_SECOND * 0.5) // 500ms — below this, skip the call

/** What differs between the Worker and direct paths. Errors are returned, not
 *  thrown, so the shared flush treats both identically. */
interface TransportBackend {
  ready: boolean
  /** Shown in the phone debug log; must never include a key. */
  transcribeUrl: string
  /** Reachability check before a session; throws with a user-readable message. */
  probe(): Promise<void>
  transcribe(chunk: Uint8Array): Promise<
    | { ok: true; text: string; utterances: TranscriptUtterance[] }
    | { ok: false; status: number | null; error: string }
  >
  suggest(params: { mode: string; transcript: string; customPrompt?: string; recentSuggestions?: string[] }):
    Promise<{ ok: true; suggestions: string[] } | { ok: false; error: string }>
}

function workerBackend(workerUrl: string, bearerToken: string): TransportBackend {
  const baseHttp = workerUrl.replace(/\/$/, '')
  return {
    ready: !!workerUrl && !!bearerToken,
    transcribeUrl: `${baseHttp}/transcribe`,
    async probe() {
      // Probe /healthz (unauthenticated) to confirm reachability; the bearer
      // is validated by the first /transcribe POST, which gives a clearer
      // 401 than a failed probe would.
      try {
        const probeCtrl = new AbortController()
        const probeTimer = setTimeout(() => probeCtrl.abort(), 5_000)
        const probe = await fetch(`${baseHttp}/healthz`, { signal: probeCtrl.signal }).finally(() =>
          clearTimeout(probeTimer),
        )
        if (!probe.ok) throw new Error(`worker /healthz returned ${probe.status}`)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        throw new Error(`worker unreachable: ${msg.slice(0, 80)}`)
      }
    },
    async transcribe(chunk) {
      // Body as Blob, not raw ArrayBuffer — WKWebView's fetch handles
      // Blobs more consistently across iOS versions, especially with
      // CORS preflight where some implementations refuse raw binary.
      const body = new Blob([toArrayBuffer(chunk)], { type: 'application/octet-stream' })
      const resp = await fetch(`${baseHttp}/transcribe`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${bearerToken}` },
        body,
      })
      if (!resp.ok) {
        const txt = await resp.text().catch(() => '')
        return { ok: false, status: resp.status, error: explainHttp(resp.status, txt) }
      }
      const json = (await resp.json()) as {
        ok: boolean
        text?: string
        error?: string
        utterances?: Array<{ speaker?: number; text?: string; confidence?: number }>
      }
      if (!json.ok) return { ok: false, status: resp.status, error: json.error ?? 'transcribe failed' }
      const utterances: TranscriptUtterance[] = (json.utterances ?? [])
        .map(u => ({
          speaker: typeof u.speaker === 'number' ? u.speaker : 0,
          text: (u.text ?? '').trim(),
          confidence: typeof u.confidence === 'number' ? u.confidence : 0,
        }))
        .filter(u => u.text.length > 0)
      return { ok: true, text: (json.text ?? '').trim(), utterances }
    },
    async suggest({ mode, transcript, customPrompt, recentSuggestions }) {
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), 12_000)
      try {
        const resp = await fetch(`${baseHttp}/suggest`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${bearerToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ mode, transcript, customPrompt, recentSuggestions }),
          signal: ctrl.signal,
        })
        if (!resp.ok) return { ok: false as const, error: `Worker HTTP ${resp.status}` }
        return (await resp.json()) as { ok: true; suggestions: string[] } | { ok: false; error: string }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return { ok: false as const, error: msg }
      } finally {
        clearTimeout(timer)
      }
    },
  }
}

function directBackend(keys: DirectKeys): TransportBackend {
  const ready = !!keys.deepgramKey.trim() && !!keys.llmKey.trim()
  return {
    ready,
    transcribeUrl: DEEPGRAM_LISTEN_URL,
    async probe() {
      // No health endpoint to hit without spending a request; the first chunk
      // surfaces a bad key with a provider-specific message instead.
    },
    async transcribe(chunk) {
      return transcribeDirect(chunk, keys.deepgramKey.trim())
    },
    async suggest({ mode, transcript, customPrompt, recentSuggestions }) {
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), 12_000)
      try {
        const r = await suggestDirect({
          provider: keys.llmProvider,
          apiKey: keys.llmKey.trim(),
          systemPrompt: buildSystemPrompt({ mode, customPrompt, recentSuggestions }),
          transcript,
          signal: ctrl.signal,
        })
        return r.ok ? r : { ok: false as const, error: r.error }
      } finally {
        clearTimeout(timer)
      }
    },
  }
}

/** Worker path: the user's personal Cloudflare Worker proxies to the providers. */
export function createTransport(workerUrl: string, bearerToken: string): CueTransport {
  return createChunkedTransport(workerBackend(workerUrl, bearerToken), 'Worker not configured')
}

/** Direct path (v0.5.0): keys from phone settings, providers called from the plugin. */
export function createDirectTransport(keys: DirectKeys): CueTransport {
  return createChunkedTransport(directBackend(keys), 'API keys not configured')
}

/** Pick the backend from what the user has configured. Precedence: complete
 *  provider keys win (the distributable path), then a configured Worker, and
 *  otherwise a not-ready transport so main.ts falls back to mock mode. */
export function createBestTransport(cfg: { keys: DirectKeys; workerUrl: string; bearerToken: string }): CueTransport {
  const direct = createDirectTransport(cfg.keys)
  if (direct.ready) return direct
  return createTransport(cfg.workerUrl, cfg.bearerToken)
}

/** URL the debug log shows for the LLM call on each backend. */
export function suggestUrlFor(provider: DirectKeys['llmProvider']): string {
  return provider === 'anthropic' ? ANTHROPIC_MESSAGES_URL : OPENAI_CHAT_URL
}

function createChunkedTransport(backend: TransportBackend, notReadyMessage: string): CueTransport {
  const ready = backend.ready

  let onTranscriptCb: ((e: TranscriptEvent) => void) | null = null
  let onErrorCb: ((msg: string) => void) | null = null
  let pending = new Uint8Array(0)
  let inFlight = false
  let active = false
  // Diagnostic counters — surface via stats() so the UI can show whether
  // audio is flowing (most common silent failure mode: SDK starts mic but
  // never emits audio events to our handler).
  let framesReceived = 0
  let bytesReceived = 0
  let chunksFlushed = 0
  let chunksOk = 0
  let lastError = ''

  // POST one accumulated chunk to the worker. We never block the audio
  // pipeline on a slow request — `inFlight` gates concurrency and any
  // bytes that arrive while a request is in flight just keep accumulating
  // in `pending` for the next flush.
  async function flush(force = false): Promise<void> {
    // `force` lets endMicSession drain the trailing partial chunk
    // even after `active` has been cleared. Without it, the
    // post-session flush is a silent no-op (caught while writing
    // v0.4.0 utterance tests; previously the trailing 5-30s of a
    // session was being dropped on the floor).
    if ((!active && !force) || inFlight || pending.byteLength < MIN_CHUNK_BYTES) return
    inFlight = true
    chunksFlushed += 1
    const chunk = pending
    pending = new Uint8Array(0)
    const url = backend.transcribeUrl
    const startedAt = Date.now()
    try {
      const result = await backend.transcribe(chunk)
      if (!result.ok) {
        lastError = result.status === null
          ? `network: ${result.error.slice(0, 70)}`
          : `HTTP ${result.status} ${result.error.slice(0, 60)}`
        logSink?.({
          ts: startedAt, url, method: 'POST',
          status: result.status, ms: Date.now() - startedAt, ok: false,
          error: result.error, bytes: chunk.byteLength,
        })
        onErrorCb?.(result.status === null
          ? `transcribe network error: ${result.error.slice(0, 80)}`
          : `transcribe HTTP ${result.status}: ${result.error.slice(0, 80)}`)
        return
      }
      chunksOk += 1
      lastError = '' // success — clear stale error
      logSink?.({
        ts: startedAt, url, method: 'POST',
        status: 200, ms: Date.now() - startedAt, ok: true, bytes: chunk.byteLength,
      })
      if (result.text && onTranscriptCb) {
        onTranscriptCb({ type: 'transcript', text: result.text, isFinal: true, utterances: result.utterances })
      }
    } catch (err) {
      // Backends return errors rather than throwing; this is the last line
      // of defence so a surprise never wedges `inFlight`.
      const msg = err instanceof Error ? err.message : String(err)
      lastError = `network: ${msg.slice(0, 70)}`
      logSink?.({
        ts: startedAt, url, method: 'POST',
        status: null, ms: Date.now() - startedAt, ok: false,
        error: `Network failure: ${msg.slice(0, 120)}`, bytes: chunk.byteLength,
      })
      onErrorCb?.(`transcribe network error: ${msg.slice(0, 80)}`)
    } finally {
      inFlight = false
    }
  }

  return {
    ready,
    async startMicSession(onTranscript, onError) {
      if (!ready) {
        throw new Error(notReadyMessage)
      }
      await backend.probe()
      onTranscriptCb = onTranscript
      onErrorCb = onError
      pending = new Uint8Array(0)
      inFlight = false
      active = true
    },
    sendAudioFrame(frame) {
      if (!active) return
      framesReceived += 1
      bytesReceived += frame.byteLength
      // Accumulate. Each incoming frame is small (~10-40ms typically); we
      // append until we hit CHUNK_BYTES, then trigger an async flush.
      const merged = new Uint8Array(pending.byteLength + frame.byteLength)
      merged.set(pending, 0)
      merged.set(frame, pending.byteLength)
      pending = merged
      if (pending.byteLength >= CHUNK_BYTES) {
        void flush()
      }
    },
    async endMicSession() {
      // Final flush for the trailing partial chunk so a quick utterance
      // ending mid-buffer isn't dropped. `force` is required because the
      // active-flag check would otherwise skip the trailing send (set
      // active=false BEFORE awaiting so no new sendAudioFrame races in).
      active = false
      await flush(true)
      onTranscriptCb = null
      onErrorCb = null
    },
    stats() {
      return { framesReceived, bytesReceived, chunksFlushed, chunksOk, lastError }
    },
    async requestSuggestions({ mode, transcript, customPrompt, recentSuggestions }) {
      if (!ready) return { ok: false as const, error: notReadyMessage }
      return backend.suggest({ mode, transcript, customPrompt, recentSuggestions })
    },
  }
}
