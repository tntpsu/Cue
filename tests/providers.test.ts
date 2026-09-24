// Direct-to-provider backend. Every request shape here mirrors
// worker-template/index.ts; a drift between the two is a bug in whichever
// side changed without the other.

import { describe, expect, it, vi } from 'vitest'
import {
  wavWrap, keyLooksValid, explainProviderHttp, transcribeDirect, suggestDirect,
  buildSystemPrompt, parseNumberedList, DEEPGRAM_LISTEN_URL, ANTHROPIC_MESSAGES_URL, OPENAI_CHAT_URL,
  PROVIDER_ORIGINS, type FetchLike,
} from '../src/providers'
import { MODES } from '../src/modes'

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}
function mockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const f: FetchLike = async (url, init) => { calls.push({ url, init }); return handler(url, init) }
  return { f, calls }
}

describe('wavWrap', () => {
  it('writes a valid 44-byte PCM16 mono header around the samples', () => {
    const pcm = new Uint8Array([1, 2, 3, 4, 5, 6])
    const wav = wavWrap(pcm, 16000)
    const v = new DataView(wav.buffer)
    const tag = (o: number) => String.fromCharCode(wav[o]!, wav[o + 1]!, wav[o + 2]!, wav[o + 3]!)
    expect(wav.byteLength).toBe(44 + 6)
    expect(tag(0)).toBe('RIFF'); expect(tag(8)).toBe('WAVE'); expect(tag(12)).toBe('fmt '); expect(tag(36)).toBe('data')
    expect(v.getUint32(4, true)).toBe(36 + 6)
    expect(v.getUint16(20, true)).toBe(1)        // PCM
    expect(v.getUint16(22, true)).toBe(1)        // mono
    expect(v.getUint32(24, true)).toBe(16000)
    expect(v.getUint32(28, true)).toBe(32000)    // byte rate
    expect(v.getUint16(34, true)).toBe(16)
    expect(v.getUint32(40, true)).toBe(6)
    expect(Array.from(wav.subarray(44))).toEqual([1, 2, 3, 4, 5, 6])
  })
})

describe('keyLooksValid', () => {
  it('recognises each provider’s shape and rejects blanks', () => {
    expect(keyLooksValid('deepgram', 'a'.repeat(40))).toBe(true)
    expect(keyLooksValid('deepgram', 'not-a-key')).toBe(false)
    expect(keyLooksValid('anthropic', 'sk-ant-' + 'x'.repeat(30))).toBe(true)
    expect(keyLooksValid('openai', 'sk-' + 'x'.repeat(30))).toBe(true)
    expect(keyLooksValid('openai', 'sk-ant-' + 'x'.repeat(30))).toBe(true) // an Anthropic key still has the sk- prefix; not our job to block
    expect(keyLooksValid('anthropic', '')).toBe(false)
    expect(keyLooksValid('deepgram', '   ')).toBe(false)
  })
})

describe('transcribeDirect', () => {
  it('POSTs WAV to Deepgram with the Token auth and diarization params, and parses utterances', async () => {
    const { f, calls } = mockFetch(() => jsonResponse(200, {
      results: {
        channels: [{ alternatives: [{ transcript: 'hello there  ' }] }],
        utterances: [
          { speaker: 0, transcript: 'hello', confidence: 0.9 },
          { speaker: 1, transcript: '   ', confidence: 0.5 },
          { transcript: 'there' },
        ],
      },
    }))
    const r = await transcribeDirect(new Uint8Array(3200), 'a'.repeat(40), f)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe(DEEPGRAM_LISTEN_URL)
    expect(DEEPGRAM_LISTEN_URL).toContain('diarize=true')
    expect(DEEPGRAM_LISTEN_URL).toContain('utterances=true')
    const headers = calls[0]!.init!.headers as Record<string, string>
    expect(headers.Authorization).toBe('Token ' + 'a'.repeat(40))
    expect(headers['Content-Type']).toBe('audio/wav')
    expect((calls[0]!.init!.body as Blob).size).toBe(44 + 3200)
    expect(r).toEqual({ ok: true, text: 'hello there', utterances: [
      { speaker: 0, text: 'hello', confidence: 0.9 },
      { speaker: 0, text: 'there', confidence: 0 },
    ] })
  })
  it('maps a rejected key to an actionable message, and a thrown fetch to a network failure', async () => {
    const bad = await transcribeDirect(new Uint8Array(10), 'k', mockFetch(() => new Response('nope', { status: 401 })).f)
    expect(bad).toMatchObject({ ok: false, status: 401 })
    expect((bad as { error: string }).error).toMatch(/Deepgram rejected the API key/)
    const down = await transcribeDirect(new Uint8Array(10), 'k', async () => { throw new Error('Load failed') })
    expect(down).toMatchObject({ ok: false, status: null })
    expect((down as { error: string }).error).toMatch(/Network failure: Load failed/)
  })
})

describe('buildSystemPrompt', () => {
  it('uses the mode prompt from modes.ts, lets a custom prompt win, and appends the do-not-repeat note', () => {
    const date = MODES.find(m => m.id === 'date')!.systemPrompt
    expect(buildSystemPrompt({ mode: 'date' })).toBe(date)
    expect(buildSystemPrompt({ mode: 'nonsense' })).toBe(date)
    expect(buildSystemPrompt({ mode: 'date', customPrompt: '  Be terse.  ' })).toBe('Be terse.')
    const withRecent = buildSystemPrompt({ mode: 'sting', recentSuggestions: ['a', '', 'b'] })
    expect(withRecent).toContain(MODES.find(m => m.id === 'sting')!.systemPrompt)
    expect(withRecent).toMatch(/DO NOT repeat[\s\S]*- a\n- b$/)
  })
})

describe('parseNumberedList', () => {
  it('keeps numbered lines, tolerates preamble, falls back to whole text', () => {
    expect(parseNumberedList('Sure!\n1. Tell me more\n2) Go on\nthanks')).toEqual(['Tell me more', 'Go on'])
    expect(parseNumberedList('just one line')).toEqual(['just one line'])
  })
})

describe('suggestDirect', () => {
  it('Anthropic: sends the browser-access header, version, system + user, and parses content[0].text', async () => {
    const { f, calls } = mockFetch(() => jsonResponse(200, { content: [{ text: '1. Nice\n2. Cool' }] }))
    const r = await suggestDirect({ provider: 'anthropic', apiKey: 'sk-ant-x', systemPrompt: 'SYS', transcript: 'hi' }, f)
    expect(calls[0]!.url).toBe(ANTHROPIC_MESSAGES_URL)
    const h = calls[0]!.init!.headers as Record<string, string>
    expect(h['x-api-key']).toBe('sk-ant-x')
    expect(h['anthropic-version']).toBe('2023-06-01')
    expect(h['anthropic-dangerous-direct-browser-access']).toBe('true')
    const body = JSON.parse(calls[0]!.init!.body as string)
    expect(body.system).toBe('SYS')
    expect(body.messages[0].content).toContain('"hi"')
    expect(r).toEqual({ ok: true, suggestions: ['Nice', 'Cool'] })
  })
  it('OpenAI: bearer auth, system message first, parses choices[0].message.content', async () => {
    const { f, calls } = mockFetch(() => jsonResponse(200, { choices: [{ message: { content: '1. Yes' } }] }))
    const r = await suggestDirect({ provider: 'openai', apiKey: 'sk-x', systemPrompt: 'SYS', transcript: 'hi' }, f)
    expect(calls[0]!.url).toBe(OPENAI_CHAT_URL)
    expect((calls[0]!.init!.headers as Record<string, string>).Authorization).toBe('Bearer sk-x')
    const body = JSON.parse(calls[0]!.init!.body as string)
    expect(body.messages[0]).toEqual({ role: 'system', content: 'SYS' })
    expect(r).toEqual({ ok: true, suggestions: ['Yes'] })
  })
  it('explains quota and key failures per provider', async () => {
    const r = await suggestDirect({ provider: 'openai', apiKey: 'k', systemPrompt: 's', transcript: 't' }, mockFetch(() => new Response('', { status: 429 })).f)
    expect((r as { error: string }).error).toMatch(/OpenAI rate-limited/)
    expect(explainProviderHttp('anthropic', 402, '')).toMatch(/no credit/)
  })
})

describe('whitelist contract', () => {
  it('every provider URL is on an origin the app.json whitelist must carry', () => {
    for (const url of [DEEPGRAM_LISTEN_URL, ANTHROPIC_MESSAGES_URL, OPENAI_CHAT_URL]) {
      expect(PROVIDER_ORIGINS.some(o => url.startsWith(o + '/'))).toBe(true)
    }
  })
})

describe('createBestTransport precedence', () => {
  it('prefers complete provider keys, then a Worker, else reports not ready', async () => {
    const { createBestTransport } = await import('../src/transport')
    const keys = { deepgramKey: 'a'.repeat(40), llmProvider: 'anthropic' as const, llmKey: 'sk-ant-x' }
    expect(createBestTransport({ keys, workerUrl: 'https://w.example', bearerToken: 't' }).ready).toBe(true)
    // Half-configured keys must not win over a working Worker.
    const half = { ...keys, llmKey: '' }
    const viaWorker = createBestTransport({ keys: half, workerUrl: 'https://w.example', bearerToken: 't' })
    expect(viaWorker.ready).toBe(true)
    const none = createBestTransport({ keys: half, workerUrl: '', bearerToken: '' })
    expect(none.ready).toBe(false)
    await expect(none.startMicSession(() => {}, () => {})).rejects.toThrow(/not configured/)
  })
})
