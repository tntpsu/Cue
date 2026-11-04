// End-to-end audio pipeline tests. Drives synthetic PCM through a fake
// bridge into transport.sendAudioFrame, mocks the Worker /healthz +
// /transcribe + /suggest responses, and asserts that the conversation
// renders correctly on the glasses.
//
// What this covers that transport.test.ts can't:
//   - The full main.ts state machine (toggleMic → startRealSession →
//     even.startMic frame handler → transport.sendAudioFrame).
//   - Diarization rendering: utterances flow into onTranscriptFrame,
//     appendTurn into the conversation buffer, [A]/[B] labels appear.
//   - Wearer-id filter: wearer's lines stay rendered with "(you)" but
//     are excluded from the /suggest transcript field.
//   - Trailing flush on mic-off catching the partial chunk.
//   - Calibrate-me anchoring wearer to the first detected speaker.
//
// The "PCM" is plain Uint8Array — transport.ts only counts bytes for
// chunking, never decodes. Diarization comes from the mocked worker
// response shape, not from real audio.

/// <reference types="vitest/globals" />
// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

interface FakeRuntime {
  render: (text: string) => Promise<void>
  onTap: (h: (src: string) => void) => void
  onSwipe: (h: (dir: string, src: string) => void) => void
  onDoubleTap: (h: (src: string) => void) => void
  onForeground: (h: () => void) => void
  startMic: (h: (frame: Uint8Array) => void) => Promise<boolean>
  stopMic: () => Promise<void>
  exitApp: () => Promise<void>
  getStorage: (k: string) => Promise<string>
  setStorage: (k: string, v: string) => Promise<boolean>
  getBatteryLevel: () => Promise<number | undefined>
  getMicSource: () => 'glasses' | 'phone' | null
  getAudioStats: () => { frames: number; self: number; other: number; unknown: number; dropped: number }
}

interface FakeBridge {
  runtime: FakeRuntime
  invokeTap: (src?: string) => void
  invokeDoubleTap: (src?: string) => void
  invokeForeground: () => void
  lastRender: () => string
  micActive: () => boolean
  /** Pump one PCM frame to whatever handler main.ts registered via even.startMic. */
  pumpFrame: (frame: Uint8Array) => void
  /** Pump a sequence of N frames each `bytes` long. */
  pumpFrames: (count: number, bytes: number) => void
}

function createFakeBridge(initialBattery: number | undefined = 80): FakeBridge {
  let tapHandler: ((src: string) => void) | null = null
  let doubleTapHandler: ((src: string) => void) | null = null
  let foregroundHandler: (() => void) | null = null
  let frameHandler: ((frame: Uint8Array) => void) | null = null
  let lastRendered = ''
  let mic = false
  const battery = initialBattery
  const storage: Record<string, string> = {}

  const runtime: FakeRuntime = {
    render: async (text: string) => { lastRendered = text },
    onTap: h => { tapHandler = h },
    onSwipe: () => {},
    onDoubleTap: h => { doubleTapHandler = h },
    onForeground: h => { foregroundHandler = h },
    startMic: async (h: (frame: Uint8Array) => void) => {
      mic = true
      frameHandler = h
      return true
    },
    stopMic: async () => { mic = false; frameHandler = null },
    exitApp: async () => {},
    getStorage: async k => storage[k] ?? '',
    setStorage: async (k, v) => { storage[k] = v; return true },
    getBatteryLevel: async () => battery,
    getMicSource: () => (mic ? 'glasses' : null),
    getAudioStats: () => ({ frames: 0, self: 0, other: 0, unknown: 0, dropped: 0 }),
  }
  return {
    runtime,
    invokeTap: (src = 'glasses') => tapHandler?.(src),
    invokeDoubleTap: (src = 'glasses') => doubleTapHandler?.(src),
    invokeForeground: () => foregroundHandler?.(),
    lastRender: () => lastRendered,
    micActive: () => mic,
    pumpFrame: (frame: Uint8Array) => frameHandler?.(frame),
    pumpFrames: (count: number, bytes: number) => {
      for (let i = 0; i < count; i++) {
        // Deterministic non-zero bytes so any byte-count assertion is meaningful.
        const f = new Uint8Array(bytes)
        for (let j = 0; j < bytes; j++) f[j] = (i + j) & 0xff
        frameHandler?.(f)
      }
    },
  }
}

interface FakeFetchOpts {
  /** Per-call utterances to return in order. After exhausted, returns text-only. */
  utterancesQueue?: Array<Array<{ speaker: number; text: string; confidence?: number }>>
  /** Suggestions to return on /suggest. Defaults to a static triple. */
  suggestions?: string[]
  /** Captures every transcribe + suggest call so tests can assert. */
  calls?: Array<{ url: string; method: string; body?: unknown; bytes?: number }>
}

function installFakeFetch(opts: FakeFetchOpts): void {
  const transcribeQueue = opts.utterancesQueue ? [...opts.utterancesQueue] : []
  const suggestions = opts.suggestions ?? ['Ask follow-up.', 'Mirror back.', 'Pivot to next topic.']
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString()
    const method = init?.method ?? 'GET'
    if (url.endsWith('/healthz')) {
      opts.calls?.push({ url, method })
      return new Response('ok', { status: 200 })
    }
    if (url.endsWith('/transcribe')) {
      const body = init?.body as Blob | undefined
      const bytes = body ? body.size : 0
      opts.calls?.push({ url, method, bytes })
      const utts = transcribeQueue.shift() ?? []
      const joined = utts.map(u => u.text).join(' ').trim()
      return new Response(
        JSON.stringify({
          ok: true,
          text: joined || 'sample transcript',
          utterances: utts.map(u => ({ ...u, confidence: u.confidence ?? 0.9 })),
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    }
    if (url.endsWith('/suggest')) {
      const body = init?.body ? JSON.parse(init.body as string) : null
      opts.calls?.push({ url, method, body })
      return new Response(
        JSON.stringify({ ok: true, suggestions }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    }
    return new Response('not found', { status: 404 })
  }) as unknown as typeof fetch
}

let fake: FakeBridge

async function bootMocked(initialStorage: Record<string, string> = {}): Promise<void> {
  vi.resetModules()
  fake = createFakeBridge()

  // Pre-populate both bridge storage and localStorage fallback so
  // bootstrap reads are robust to ordering.
  for (const [k, v] of Object.entries(initialStorage)) {
    await fake.runtime.setStorage(k, v)
  }
  const lsStore = { ...initialStorage }
  globalThis.localStorage = {
    getItem: (k: string) => lsStore[k] ?? null,
    setItem: (k: string, v: string) => { lsStore[k] = v },
    removeItem: (k: string) => { delete lsStore[k] },
    clear: () => { for (const k of Object.keys(lsStore)) delete lsStore[k] },
    key: (i: number) => Object.keys(lsStore)[i] ?? null,
    get length() { return Object.keys(lsStore).length },
  } as Storage

  vi.doMock('../src/even', () => ({
    connectEvenRuntime: vi.fn(() => Promise.resolve(fake.runtime)),
  }))

  document.body.innerHTML = '<div id="app"></div>'
  // @ts-expect-error — define is normally injected by Vite at build time
  globalThis.__APP_VERSION__ = '0.0.0-test'

  await import('../src/main')
  await new Promise(r => setTimeout(r, 60))
}

const ORIGINAL_FETCH = globalThis.fetch

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH
  document.body.innerHTML = ''
  vi.doUnmock('../src/even')
  vi.useRealTimers()
  vi.restoreAllMocks()
})

// CHUNK_BYTES from transport.ts: 16000 sample-rate × 2 bytes × 2.5s = 80_000.
const CHUNK_BYTES = 80_000

describe('Cue audio pipeline (fake bridge + mocked worker)', () => {
  it('probes /healthz on mic-on when worker is configured', async () => {
    const calls: FakeFetchOpts['calls'] = []
    installFakeFetch({ calls })
    await bootMocked({
      'cue:privacy-agreed:v1': '1',
      'cue:worker-url:v1': 'https://cue-test.workers.dev',
      'cue:worker-token:v1': 'test-bearer',
    })
    fake.invokeTap('glasses')
    await new Promise(r => setTimeout(r, 50))
    const probed = calls!.some(c => c.url.endsWith('/healthz'))
    expect(probed).toBe(true)
  })

  it('chunks PCM into a /transcribe POST after CHUNK_BYTES bytes accumulate', async () => {
    const calls: FakeFetchOpts['calls'] = []
    installFakeFetch({
      calls,
      utterancesQueue: [
        [{ speaker: 0, text: 'how was your day' }],
      ],
    })
    await bootMocked({
      'cue:privacy-agreed:v1': '1',
      'cue:worker-url:v1': 'https://cue-test.workers.dev',
      'cue:worker-token:v1': 'test-bearer',
    })
    fake.invokeTap('glasses')
    await new Promise(r => setTimeout(r, 50))
    // 100KB > CHUNK_BYTES (80KB), so the threshold-flush fires once.
    fake.pumpFrames(10, 10_000)
    await new Promise(r => setTimeout(r, 50))
    const transcribeCalls = calls!.filter(c => c.url.endsWith('/transcribe'))
    expect(transcribeCalls).toHaveLength(1)
    expect(transcribeCalls[0]!.bytes).toBeGreaterThanOrEqual(CHUNK_BYTES)
  })

  it('renders [A]/[B] labels for two-speaker utterances', async () => {
    installFakeFetch({
      utterancesQueue: [
        [
          { speaker: 0, text: 'how was your day' },
          { speaker: 1, text: 'pretty good thanks' },
        ],
      ],
    })
    await bootMocked({
      'cue:privacy-agreed:v1': '1',
      'cue:worker-url:v1': 'https://cue-test.workers.dev',
      'cue:worker-token:v1': 'test-bearer',
    })
    fake.invokeTap('glasses')
    await new Promise(r => setTimeout(r, 50))
    fake.pumpFrames(10, 10_000)
    // Wait long enough for fetch + onTranscript + paint to settle.
    await new Promise(r => setTimeout(r, 80))
    const out = fake.lastRender()
    expect(out).toMatch(/\[A\] how was your day/)
    expect(out).toMatch(/\[B\] pretty good/)
  })

  it('marks the wearer with "(you)" and excludes wearer text from /suggest transcript', async () => {
    const calls: FakeFetchOpts['calls'] = []
    installFakeFetch({
      calls,
      utterancesQueue: [
        [
          { speaker: 0, text: 'I had a long day' },              // wearer
          { speaker: 1, text: 'tell me about the meeting' },     // other
        ],
      ],
    })
    await bootMocked({
      'cue:privacy-agreed:v1': '1',
      'cue:worker-url:v1': 'https://cue-test.workers.dev',
      'cue:worker-token:v1': 'test-bearer',
      'cue:wearer-speaker-id:v1': '0',  // I am speaker A
    })
    fake.invokeTap('glasses')
    await new Promise(r => setTimeout(r, 50))
    fake.pumpFrames(10, 10_000)
    // Wait for transcribe + the silence-driven /suggest fire (sentence-final).
    await new Promise(r => setTimeout(r, 200))

    const out = fake.lastRender()
    expect(out).toMatch(/\[A \(you\)\] I had a long day/)
    expect(out).toMatch(/\[B\] tell me about the meeting/)

    // /suggest payload's transcript field must NOT contain wearer's text.
    const suggestCalls = calls!.filter(c => c.url.endsWith('/suggest'))
    expect(suggestCalls.length).toBeGreaterThanOrEqual(1)
    const lastSuggest = suggestCalls[suggestCalls.length - 1]!
    const transcript = (lastSuggest.body as { transcript: string }).transcript
    expect(transcript).not.toMatch(/I had a long day/)
    expect(transcript).toMatch(/tell me about the meeting/)
  })

  it('flushes a trailing partial chunk when mic is toggled off', async () => {
    const calls: FakeFetchOpts['calls'] = []
    installFakeFetch({
      calls,
      utterancesQueue: [
        [{ speaker: 0, text: 'short utterance before stop' }],
      ],
    })
    await bootMocked({
      'cue:privacy-agreed:v1': '1',
      'cue:worker-url:v1': 'https://cue-test.workers.dev',
      'cue:worker-token:v1': 'test-bearer',
    })
    fake.invokeTap('glasses')
    await new Promise(r => setTimeout(r, 50))
    // Pump less than CHUNK_BYTES but more than MIN_CHUNK_BYTES (16000).
    // 2 frames × 10000 = 20000 bytes — below threshold so no auto-flush
    // happens, but trailing flush on mic-off should send it.
    fake.pumpFrames(2, 10_000)
    await new Promise(r => setTimeout(r, 30))
    const before = calls!.filter(c => c.url.endsWith('/transcribe')).length
    expect(before).toBe(0) // no auto-flush yet
    // Tap again — mic off → trailing flush.
    fake.invokeTap('glasses')
    await new Promise(r => setTimeout(r, 80))
    const after = calls!.filter(c => c.url.endsWith('/transcribe')).length
    expect(after).toBe(1)
  })

  it('calibrate-me anchors wearer to first detected speaker', async () => {
    installFakeFetch({
      utterancesQueue: [
        [
          { speaker: 1, text: 'this is me speaking' },  // first speech → wearer
        ],
      ],
    })
    await bootMocked({
      'cue:privacy-agreed:v1': '1',
      'cue:worker-url:v1': 'https://cue-test.workers.dev',
      'cue:worker-token:v1': 'test-bearer',
      'cue:calibrating:v1': '1',  // user just tapped Calibrate me
      'cue:wearer-speaker-id:v1': '-1', // none yet
    })
    fake.invokeTap('glasses')
    await new Promise(r => setTimeout(r, 50))
    fake.pumpFrames(10, 10_000)
    await new Promise(r => setTimeout(r, 100))

    // Speaker B's line should now be marked "(you)".
    expect(fake.lastRender()).toMatch(/\[B \(you\)\] this is me speaking/)
    // And the wearer-speaker-id should have been persisted.
    expect(await fake.runtime.getStorage('cue:wearer-speaker-id:v1')).toBe('1')
  })
})
