// Unit tests for the transport layer's HTTP path. We mock fetch globally so
// these tests don't make real network calls — the goal is to verify the
// request shape and response handling, not to exercise a real Worker.
//
// The WebSocket path can't be tested cleanly here without a full WS mock
// (and in practice the audio pipeline only has value when run end-to-end
// against real glasses + a real deployed Worker — covered manually).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTransport } from '../src/transport'

const ORIGINAL_FETCH = globalThis.fetch

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH
  vi.restoreAllMocks()
})

describe('createTransport', () => {
  it('reports not-ready when URL or token missing', () => {
    expect(createTransport('', '').ready).toBe(false)
    expect(createTransport('https://x.workers.dev', '').ready).toBe(false)
    expect(createTransport('', 'bearer').ready).toBe(false)
  })

  it('reports ready when both are set', () => {
    expect(createTransport('https://x.workers.dev', 'bearer').ready).toBe(true)
  })

  it('requestSuggestions returns error when not ready', async () => {
    const t = createTransport('', '')
    const r = await t.requestSuggestions({ mode: 'date', transcript: 'hi' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/not configured/)
  })

  it('requestSuggestions sends POST with bearer + JSON body', async () => {
    const fetchSpy = vi.fn(async (_url: string, init?: RequestInit) => {
      // Capture for assertions and return a canned ok response.
      return new Response(
        JSON.stringify({ ok: true, suggestions: ['First', 'Second', 'Third'] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    })
    globalThis.fetch = fetchSpy as unknown as typeof fetch
    const t = createTransport('https://cue.example.workers.dev', 'secret')
    const r = await t.requestSuggestions({
      mode: 'date',
      transcript: 'How was your day?',
    })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.suggestions).toEqual(['First', 'Second', 'Third'])
    expect(fetchSpy).toHaveBeenCalledOnce()
    const [url, init] = fetchSpy.mock.calls[0]!
    expect(url).toBe('https://cue.example.workers.dev/suggest')
    expect(init?.method).toBe('POST')
    const headers = init?.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer secret')
    expect(headers['Content-Type']).toBe('application/json')
    const body = JSON.parse(init?.body as string)
    expect(body).toEqual({ mode: 'date', transcript: 'How was your day?', customPrompt: undefined })
  })

  it('requestSuggestions surfaces non-ok HTTP as error result', async () => {
    globalThis.fetch = vi.fn(async () => new Response('rate limited', { status: 429 })) as unknown as typeof fetch
    const t = createTransport('https://cue.example.workers.dev', 'secret')
    const r = await t.requestSuggestions({ mode: 'date', transcript: 'hi' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/429/)
  })

  it('requestSuggestions surfaces network failure as error result', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError('Failed to fetch')
    }) as unknown as typeof fetch
    const t = createTransport('https://cue.example.workers.dev', 'secret')
    const r = await t.requestSuggestions({ mode: 'date', transcript: 'hi' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/Failed to fetch/)
  })

  // ─── v0.4.0: utterances field on /transcribe response ─────────────
  it('parses utterances field into TranscriptEvent.utterances', async () => {
    const fetchSpy = vi.fn(async (url: string) => {
      // Probe response (healthz) gets a generic ok
      if (typeof url === 'string' && url.includes('/healthz')) {
        return new Response('ok', { status: 200 })
      }
      // /transcribe response shape from the v0.4.0 worker
      return new Response(
        JSON.stringify({
          ok: true,
          text: 'hello there how are you',
          utterances: [
            { speaker: 0, text: 'hello there', confidence: 0.95 },
            { speaker: 1, text: 'how are you', confidence: 0.91 },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    })
    globalThis.fetch = fetchSpy as unknown as typeof fetch

    const t = createTransport('https://cue.example.workers.dev', 'secret')
    let captured: { text: string; isFinal: boolean; utterances: Array<{ speaker: number; text: string; confidence: number }> } | null = null
    await t.startMicSession(
      e => { captured = { text: e.text, isFinal: e.isFinal, utterances: e.utterances } },
      () => {},
    )
    // Send enough audio bytes to trip MIN_CHUNK_BYTES (~16KB) so endMicSession's
    // tail-flush fires.
    t.sendAudioFrame(new Uint8Array(20_000))
    await t.endMicSession()
    expect(captured).not.toBeNull()
    expect(captured!.utterances).toHaveLength(2)
    expect(captured!.utterances[0]).toMatchObject({ speaker: 0, text: 'hello there', confidence: 0.95 })
    expect(captured!.utterances[1]).toMatchObject({ speaker: 1, text: 'how are you', confidence: 0.91 })
    expect(captured!.text).toBe('hello there how are you')
  })

  // ─── v0.8.0: speaker-role spans + utterance timing ───────────────
  it('records the Even speaker role of each frame as ms spans on the chunk, merging runs', async () => {
    globalThis.fetch = vi.fn(async (url: string) => {
      if (url.includes('/healthz')) return new Response('ok', { status: 200 })
      return new Response(JSON.stringify({ ok: true, text: 'x', utterances: [] }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      })
    }) as unknown as typeof fetch
    const t = createTransport('https://cue.example.workers.dev', 'secret')
    let captured: { roles: unknown; chunkMs: number } | null = null
    await t.startMicSession(e => { captured = { roles: e.roles, chunkMs: e.chunkMs } }, () => {})
    // 16_000 bytes = 500 ms at 16 kHz mono 16-bit.
    t.sendAudioFrame(new Uint8Array(16_000), 'self')
    t.sendAudioFrame(new Uint8Array(16_000), 'self')
    t.sendAudioFrame(new Uint8Array(16_000), 'other')
    t.sendAudioFrame(new Uint8Array(8_000))
    await t.endMicSession()
    expect(captured!.chunkMs).toBe(1750)
    expect(captured!.roles).toEqual([
      { startMs: 0, endMs: 1000, role: 'self' },
      { startMs: 1000, endMs: 1500, role: 'other' },
      { startMs: 1500, endMs: 1750, role: 'unknown' },
    ])
  })

  it('starts a fresh span list for every chunk', async () => {
    const seen: Array<{ roles: Array<{ role: string; startMs: number }>; chunkMs: number }> = []
    globalThis.fetch = vi.fn(async (url: string) => {
      if (url.includes('/healthz')) return new Response('ok', { status: 200 })
      return new Response(JSON.stringify({ ok: true, text: 'x', utterances: [] }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      })
    }) as unknown as typeof fetch
    const t = createTransport('https://cue.example.workers.dev', 'secret')
    await t.startMicSession(e => { seen.push({ roles: e.roles, chunkMs: e.chunkMs }) }, () => {})
    t.sendAudioFrame(new Uint8Array(80_000), 'other')  // exactly one chunk → auto flush
    await new Promise(r => setTimeout(r, 20))
    t.sendAudioFrame(new Uint8Array(32_000), 'self')
    await t.endMicSession()
    expect(seen).toHaveLength(2)
    expect(seen[0]!.roles).toEqual([{ startMs: 0, endMs: 2500, role: 'other' }])
    expect(seen[1]!.roles).toEqual([{ startMs: 0, endMs: 1000, role: 'self' }])
  })

  it('maps Worker utterance start/end seconds to startMs/endMs, leaving them off when absent', async () => {
    globalThis.fetch = vi.fn(async (url: string) => {
      if (url.includes('/healthz')) return new Response('ok', { status: 200 })
      return new Response(JSON.stringify({
        ok: true,
        text: 'hello there how are you',
        utterances: [
          { speaker: 0, text: 'hello there', confidence: 0.95, start: 0.21, end: 1.04 },
          { speaker: 1, text: 'how are you', confidence: 0.91 },
        ],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }) as unknown as typeof fetch
    const t = createTransport('https://cue.example.workers.dev', 'secret')
    let captured: Array<Record<string, unknown>> = []
    await t.startMicSession(e => { captured = e.utterances as Array<Record<string, unknown>> }, () => {})
    t.sendAudioFrame(new Uint8Array(20_000))
    await t.endMicSession()
    expect(captured[0]).toEqual({ speaker: 0, text: 'hello there', confidence: 0.95, startMs: 210, endMs: 1040 })
    expect(captured[1]).toEqual({ speaker: 1, text: 'how are you', confidence: 0.91 })
  })

  it('handles missing utterances field (back-compat with older worker)', async () => {
    const fetchSpy = vi.fn(async (url: string) => {
      if (typeof url === 'string' && url.includes('/healthz')) {
        return new Response('ok', { status: 200 })
      }
      // Old worker: no utterances field
      return new Response(
        JSON.stringify({ ok: true, text: 'just text, no speakers' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    })
    globalThis.fetch = fetchSpy as unknown as typeof fetch

    const t = createTransport('https://cue.example.workers.dev', 'secret')
    let captured: { text: string; utterances: unknown[] } | null = null
    await t.startMicSession(e => { captured = { text: e.text, utterances: e.utterances } }, () => {})
    t.sendAudioFrame(new Uint8Array(20_000))
    await t.endMicSession()
    expect(captured).not.toBeNull()
    expect(captured!.text).toBe('just text, no speakers')
    expect(captured!.utterances).toEqual([]) // empty array, not undefined
  })

  it('drops empty-text utterances from the array', async () => {
    const fetchSpy = vi.fn(async (url: string) => {
      if (typeof url === 'string' && url.includes('/healthz')) {
        return new Response('ok', { status: 200 })
      }
      return new Response(
        JSON.stringify({
          ok: true,
          text: 'hi',
          utterances: [
            { speaker: 0, text: 'hi', confidence: 0.9 },
            { speaker: 0, text: '', confidence: 0.0 },        // dropped
            { speaker: 1, text: '   ', confidence: 0.1 },     // dropped (whitespace)
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    })
    globalThis.fetch = fetchSpy as unknown as typeof fetch
    const t = createTransport('https://cue.example.workers.dev', 'secret')
    let captured: { utterances: unknown[] } | null = null
    await t.startMicSession(e => { captured = { utterances: e.utterances } }, () => {})
    t.sendAudioFrame(new Uint8Array(20_000))
    await t.endMicSession()
    expect(captured!.utterances).toHaveLength(1)
  })

  it('passes customPrompt when provided', async () => {
    const fetchSpy = vi.fn(async () => new Response(
      JSON.stringify({ ok: true, suggestions: ['x'] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ))
    globalThis.fetch = fetchSpy as unknown as typeof fetch
    const t = createTransport('https://cue.example.workers.dev', 'secret')
    await t.requestSuggestions({
      mode: 'custom',
      transcript: 'foo',
      customPrompt: 'You are a butler...',
    })
    const body = JSON.parse(fetchSpy.mock.calls[0]![1]!.body as string)
    expect(body.customPrompt).toBe('You are a butler...')
  })
})
