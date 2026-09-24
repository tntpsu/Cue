// Direct-to-provider backend: the plugin talks to Deepgram and the LLM itself,
// with keys the user pasted into phone settings. This is what makes Cue
// distributable: the Even Hub network whitelist is a fixed list of origins
// baked in at pack time, so each user cannot point Cue at their own Worker,
// but every install can talk to the same three provider origins.
//
// Everything here is a port of worker-template/index.ts, which stays as the
// optional "advanced" route for anyone who already runs a Worker. Keep the
// request shapes identical so the two paths behave the same.
//
// All three APIs accept browser (CORS) requests; Anthropic requires the
// explicit `anthropic-dangerous-direct-browser-access` header, whose name
// warns that the key lives client-side. For a bring-your-own-key app on the
// user's own phone that is the intended model, and it is disclosed in the
// mic/network permission text.

import { MODES, type ModeId } from './modes'

export type LlmProvider = 'anthropic' | 'openai'
export type KeyKind = 'deepgram' | LlmProvider

export interface DirectKeys {
  deepgramKey: string
  llmProvider: LlmProvider
  llmKey: string
}

export const DEEPGRAM_ORIGIN = 'https://api.deepgram.com'
export const ANTHROPIC_ORIGIN = 'https://api.anthropic.com'
export const OPENAI_ORIGIN = 'https://api.openai.com'
export const PROVIDER_ORIGINS = [DEEPGRAM_ORIGIN, ANTHROPIC_ORIGIN, OPENAI_ORIGIN] as const

// Same params the Worker sends: diarize + utterances give per-speaker turns.
export const DEEPGRAM_LISTEN_URL =
  `${DEEPGRAM_ORIGIN}/v1/listen?model=nova-2&punctuate=true&diarize=true&utterances=true&smart_format=true`
export const ANTHROPIC_MESSAGES_URL = `${ANTHROPIC_ORIGIN}/v1/messages`
export const OPENAI_CHAT_URL = `${OPENAI_ORIGIN}/v1/chat/completions`

export const DIRECT_MODELS: Record<LlmProvider, string> = {
  anthropic: 'claude-haiku-4-5',
  openai: 'gpt-4o-mini',
}

export const SAMPLE_RATE = 16000

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export interface DirectUtterance { speaker: number; text: string; confidence: number }
export type TranscribeResult =
  | { ok: true; text: string; utterances: DirectUtterance[] }
  | { ok: false; status: number | null; error: string }
export type SuggestResult =
  | { ok: true; suggestions: string[] }
  | { ok: false; status: number | null; error: string }

/** A Blob-safe copy of the bytes: lib.dom's BlobPart wants an ArrayBuffer-backed
 *  view, and a Uint8Array's buffer may (by type) be a SharedArrayBuffer. */
export function toArrayBuffer(u8: Uint8Array): ArrayBuffer {
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer
}

/** 44-byte RIFF/WAVE header around PCM16 mono. Deepgram's batch endpoint
 *  wants a container; raw PCM needs the streaming API, which the WebView
 *  cannot open (no WebSocket). */
export function wavWrap(pcm: Uint8Array, sampleRate = SAMPLE_RATE): Uint8Array {
  const numChannels = 1
  const bitsPerSample = 16
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8)
  const blockAlign = numChannels * (bitsPerSample / 8)
  const dataSize = pcm.byteLength
  const buffer = new ArrayBuffer(44 + dataSize)
  const view = new DataView(buffer)
  const ascii = (offset: number, s: string) => { for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i)) }
  ascii(0, 'RIFF')
  view.setUint32(4, 36 + dataSize, true)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, numChannels, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, byteRate, true)
  view.setUint16(32, blockAlign, true)
  view.setUint16(34, bitsPerSample, true)
  ascii(36, 'data')
  view.setUint32(40, dataSize, true)
  new Uint8Array(buffer, 44).set(pcm)
  return new Uint8Array(buffer)
}

/** Loose format hints for the settings page. Never blocks saving: providers
 *  change key formats, and the first real call is the actual validation. */
export function keyLooksValid(kind: KeyKind, key: string): boolean {
  const k = key.trim()
  if (!k) return false
  if (kind === 'deepgram') return /^[0-9a-f]{40}$/i.test(k)
  if (kind === 'anthropic') return k.startsWith('sk-ant-') && k.length > 20
  if (kind === 'openai') return k.startsWith('sk-') && k.length > 20
  return false
}

export function explainProviderHttp(kind: KeyKind, status: number, body: string): string {
  const who = kind === 'deepgram' ? 'Deepgram' : kind === 'anthropic' ? 'Anthropic' : 'OpenAI'
  if (status === 401 || status === 403) return `${who} rejected the API key. Check the ${who} key in phone settings.`
  if (status === 402) return `${who} says the account has no credit. Add billing on your ${who} account.`
  if (status === 429) return `${who} rate-limited or out of quota. Slow down or check your ${who} usage.`
  if (status >= 500) return `${who} server error (${status}): ${body.slice(0, 100)}`
  return `${who} HTTP ${status}: ${body.slice(0, 120)}`
}

export async function transcribeDirect(
  pcm: Uint8Array,
  deepgramKey: string,
  fetchImpl: FetchLike = fetch,
): Promise<TranscribeResult> {
  try {
    const body = new Blob([toArrayBuffer(wavWrap(pcm))], { type: 'audio/wav' })
    const resp = await fetchImpl(DEEPGRAM_LISTEN_URL, {
      method: 'POST',
      headers: { Authorization: `Token ${deepgramKey}`, 'Content-Type': 'audio/wav' },
      body,
    })
    if (!resp.ok) {
      const txt = await resp.text().catch(() => '')
      return { ok: false, status: resp.status, error: explainProviderHttp('deepgram', resp.status, txt) }
    }
    const json = (await resp.json()) as {
      results?: {
        channels?: Array<{ alternatives?: Array<{ transcript?: string }> }>
        utterances?: Array<{ speaker?: number; transcript?: string; confidence?: number }>
      }
    }
    const text = (json.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? '').trim()
    const utterances = (json.results?.utterances ?? [])
      .map(u => ({
        speaker: typeof u.speaker === 'number' ? u.speaker : 0,
        text: (u.transcript ?? '').trim(),
        confidence: typeof u.confidence === 'number' ? u.confidence : 0,
      }))
      .filter(u => u.text.length > 0)
    return { ok: true, text, utterances }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false, status: null, error: `Network failure: ${msg.slice(0, 120)}` }
  }
}

/** Same assembly the Worker does: custom prompt wins, else the mode's prompt
 *  from modes.ts (the Worker carried a shorter mirror of these), plus the
 *  "don't repeat these" note from the rolling suggestion list. */
export function buildSystemPrompt(params: { mode: string; customPrompt?: string; recentSuggestions?: string[] }): string {
  const custom = params.customPrompt?.trim()
  const modePrompt = MODES.find(m => m.id === (params.mode as ModeId))?.systemPrompt
    ?? MODES.find(m => m.id === 'date')?.systemPrompt
    ?? ''
  const base = custom || modePrompt
  const recent = (params.recentSuggestions ?? []).filter(s => typeof s === 'string' && s.trim()).slice(-12)
  const dedupe = recent.length > 0
    ? `\n\nDO NOT repeat any of these recent suggestions verbatim or near-verbatim — find a different angle:\n${recent.map(s => `- ${s}`).join('\n')}`
    : ''
  return base + dedupe
}

/** "1. foo\n2. bar" → ["foo", "bar"]; tolerates preamble by keeping only
 *  numbered lines, and falls back to the whole text if there were none. */
export function parseNumberedList(text: string): string[] {
  const out: string[] = []
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*\d+[.)]\s+(.+)$/)
    if (m && m[1]) out.push(m[1].trim())
  }
  return out.length > 0 ? out : [text.trim()]
}

export async function suggestDirect(
  params: { provider: LlmProvider; apiKey: string; systemPrompt: string; transcript: string; signal?: AbortSignal },
  fetchImpl: FetchLike = fetch,
): Promise<SuggestResult> {
  const { provider, apiKey, systemPrompt, transcript, signal } = params
  const userContent = provider === 'anthropic'
    ? `Recent conversation transcript (the other person's voice):\n\n"${transcript}"\n\nSuggestions:`
    : `Recent conversation transcript:\n\n"${transcript}"\n\nSuggestions:`
  const req: { url: string; init: RequestInit } = provider === 'anthropic'
    ? {
        url: ANTHROPIC_MESSAGES_URL,
        init: {
          method: 'POST',
          headers: {
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
            'anthropic-dangerous-direct-browser-access': 'true',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: DIRECT_MODELS.anthropic, max_tokens: 200, system: systemPrompt,
            messages: [{ role: 'user', content: userContent }],
          }),
          signal,
        },
      }
    : {
        url: OPENAI_CHAT_URL,
        init: {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: DIRECT_MODELS.openai, max_tokens: 200,
            messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userContent }],
          }),
          signal,
        },
      }
  try {
    const resp = await fetchImpl(req.url, req.init)
    if (!resp.ok) {
      const txt = await resp.text().catch(() => '')
      return { ok: false, status: resp.status, error: explainProviderHttp(provider, resp.status, txt) }
    }
    const json = (await resp.json()) as {
      content?: Array<{ text?: string }>
      choices?: Array<{ message?: { content?: string } }>
    }
    const text = provider === 'anthropic'
      ? (json.content?.[0]?.text ?? '')
      : (json.choices?.[0]?.message?.content ?? '')
    return { ok: true, suggestions: parseNumberedList(text) }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false, status: null, error: `Network failure: ${msg.slice(0, 120)}` }
  }
}
