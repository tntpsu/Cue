// Cue personal Cloudflare Worker — proxies the glasses-to-Deepgram audio
// stream + caches the rolling transcript so the LLM call can use it as
// context. Each Cue user deploys their own Worker with their own
// Deepgram + Anthropic / OpenAI keys; the plugin never sees the keys.
//
// Endpoints:
//   GET /ws?token=<bearer>      — WebSocket. Plugin sends raw 16kHz mono
//                                 16-bit PCM frames; we proxy to Deepgram
//                                 and stream interim+final transcripts back
//                                 as JSON text frames {"type":"transcript",
//                                 "text": "...", "isFinal": bool}.
//
//   POST /suggest               — body { mode, transcript, customPrompt? }
//                                 Auth: Authorization: Bearer <SHARED_SECRET>
//                                 Returns { ok, suggestions: string[] }.
//
//   GET /healthz                — sanity check
//
// All cookies/keys live in Worker secrets, set via:
//   wrangler secret put SHARED_SECRET
//   wrangler secret put DEEPGRAM_API_KEY
//   wrangler secret put ANTHROPIC_API_KEY      (or OPENAI_API_KEY)

interface Env {
  SHARED_SECRET: string
  DEEPGRAM_API_KEY: string
  ANTHROPIC_API_KEY?: string
  OPENAI_API_KEY?: string
}

// IMPORTANT: must be https:// not wss:// — Cloudflare Workers' fetch() only
// accepts http(s) schemes for outbound WebSocket negotiation. The Upgrade
// header on the request handles the protocol switch. Using wss:// here
// produces a runtime TypeError ("Fetch API cannot load: wss://...") that
// returns HTTP 500 to the client.
const DEEPGRAM_WS = 'https://api.deepgram.com/v1/listen?model=nova-2&interim_results=true&encoding=linear16&sample_rate=16000&channels=1'
// Batch (HTTP) Deepgram endpoint used by /transcribe — same model, no
// interim results since each call gets one chunk.
//   diarize=true        → adds speaker:N per word (so plugin can tell
//                          who is talking — wearer vs other person)
//   utterances=true     → groups words into speaker turns with start/end
//   smart_format=true   → cleaner punctuation, numbers, dates
const DEEPGRAM_HTTP = 'https://api.deepgram.com/v1/listen?model=nova-2&punctuate=true&diarize=true&utterances=true&smart_format=true'

const SAMPLE_RATE = 16000

// WAV-wrap raw PCM16 mono so Deepgram's HTTP endpoint (which sniffs the
// container) accepts it. Same shape used by typical clients.
function wavWrap(pcm: Uint8Array): Uint8Array {
  const numChannels = 1
  const bitsPerSample = 16
  const byteRate = SAMPLE_RATE * numChannels * (bitsPerSample / 8)
  const blockAlign = numChannels * (bitsPerSample / 8)
  const dataSize = pcm.byteLength
  const buffer = new ArrayBuffer(44 + dataSize)
  const view = new DataView(buffer)
  view.setUint8(0, 0x52); view.setUint8(1, 0x49); view.setUint8(2, 0x46); view.setUint8(3, 0x46) // "RIFF"
  view.setUint32(4, 36 + dataSize, true)
  view.setUint8(8, 0x57); view.setUint8(9, 0x41); view.setUint8(10, 0x56); view.setUint8(11, 0x45) // "WAVE"
  view.setUint8(12, 0x66); view.setUint8(13, 0x6d); view.setUint8(14, 0x74); view.setUint8(15, 0x20) // "fmt "
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, numChannels, true)
  view.setUint32(24, SAMPLE_RATE, true)
  view.setUint32(28, byteRate, true)
  view.setUint16(32, blockAlign, true)
  view.setUint16(34, bitsPerSample, true)
  view.setUint8(36, 0x64); view.setUint8(37, 0x61); view.setUint8(38, 0x74); view.setUint8(39, 0x61) // "data"
  view.setUint32(40, dataSize, true)
  new Uint8Array(buffer, 44).set(pcm)
  return new Uint8Array(buffer)
}

async function handleTranscribe(request: Request, env: Env): Promise<Response> {
  // POST /transcribe — body is raw PCM16 mono 16kHz audio. Bearer-gated.
  // Wraps as WAV and sends to Deepgram's HTTP /v1/listen endpoint, which
  // returns a single transcript for the chunk. This bypasses WebSockets
  // entirely so the plugin's WebView (which can't open outbound WS) can
  // still get real STT via fetch() — same network permission as /suggest.
  if (request.method !== 'POST') {
    // Echo what we ACTUALLY received in the body so the plugin's debug
    // log shows whether something is downgrading POST→GET in transit
    // (Cloudflare WAF, redirect, WebView quirk, etc.). Plain text body
    // so it's readable when curl-tested.
    const cf = (request as unknown as { cf?: Record<string, unknown> }).cf
    const headerKeys: string[] = []
    request.headers.forEach((_v, k) => headerKeys.push(k))
    return new Response(
      `POST only. Received: method=${request.method}, url=${request.url}, ` +
      `headers=[${headerKeys.join(',')}], cf-ray=${request.headers.get('cf-ray') ?? 'none'}, ` +
      `cf-country=${(cf as { country?: string } | undefined)?.country ?? 'none'}`,
      { status: 405, headers: { 'Content-Type': 'text/plain', ...corsHeaders() } },
    )
  }
  const auth = request.headers.get('Authorization') ?? ''
  if (!env.SHARED_SECRET || auth !== `Bearer ${env.SHARED_SECRET}`) {
    return jsonResponse(401, { ok: false, error: 'unauthorized' })
  }
  if (!env.DEEPGRAM_API_KEY) {
    return jsonResponse(500, { ok: false, error: 'DEEPGRAM_API_KEY not configured' })
  }
  const pcm = new Uint8Array(await request.arrayBuffer())
  if (pcm.byteLength < 1600) {
    // < ~50ms of audio at 16k. Don't burn quota on near-empty chunks.
    return jsonResponse(200, { ok: true, text: '' })
  }
  const wav = wavWrap(pcm)
  const dgRes = await fetch(DEEPGRAM_HTTP, {
    method: 'POST',
    headers: {
      Authorization: `Token ${env.DEEPGRAM_API_KEY}`,
      'Content-Type': 'audio/wav',
    },
    body: wav,
  })
  if (!dgRes.ok) {
    const errText = await dgRes.text()
    return jsonResponse(dgRes.status, { ok: false, error: `deepgram ${dgRes.status}: ${errText.slice(0, 200)}` })
  }
  const json = (await dgRes.json()) as {
    results?: {
      channels?: Array<{ alternatives?: Array<{ transcript?: string; words?: Array<{ word?: string; speaker?: number; confidence?: number }> }> }>
      utterances?: Array<{ start?: number; end?: number; speaker?: number; transcript?: string; confidence?: number }>
    }
  }
  const text = (json.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? '').trim()
  // Per-speaker utterances. Each is a turn — same speaker until they
  // stop. Plugin uses these to show speaker labels and to exclude the
  // wearer's own speech from the suggestion-prompt context.
  const utterances = (json.results?.utterances ?? [])
    .map(u => ({
      speaker: typeof u.speaker === 'number' ? u.speaker : 0,
      text: (u.transcript ?? '').trim(),
      confidence: typeof u.confidence === 'number' ? u.confidence : 0,
      start: typeof u.start === 'number' ? u.start : undefined,
      end: typeof u.end === 'number' ? u.end : undefined,
    }))
    .filter(u => u.text.length > 0)
  return jsonResponse(200, { ok: true, text, utterances })
}

function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  }
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() },
  })
}

async function handleSuggest(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') return jsonResponse(405, { ok: false, error: 'POST only' })
  const auth = request.headers.get('Authorization') ?? ''
  if (!env.SHARED_SECRET || auth !== `Bearer ${env.SHARED_SECRET}`) {
    return jsonResponse(401, { ok: false, error: 'unauthorized' })
  }
  let body: {
    mode?: string
    transcript?: string
    customPrompt?: string
    recentSuggestions?: string[]
  }
  try {
    body = (await request.json()) as typeof body
  } catch {
    return jsonResponse(400, { ok: false, error: 'invalid JSON body' })
  }
  if (!body.transcript || typeof body.transcript !== 'string') {
    return jsonResponse(400, { ok: false, error: 'transcript required' })
  }
  // v0.4.2: client passes its rolling list of recent suggestions; we
  // append a "don't repeat these" instruction to the system prompt so
  // the LLM doesn't re-surface the same phrasing.
  const baseSystem = body.customPrompt?.trim() || systemPromptForMode(body.mode ?? 'date')
  const recent = (body.recentSuggestions ?? []).filter(s => typeof s === 'string').slice(-12)
  const dedupeNote = recent.length > 0
    ? `\n\nDO NOT repeat any of these recent suggestions verbatim or near-verbatim — find a different angle:\n${recent.map(s => `- ${s}`).join('\n')}`
    : ''
  const systemPrompt = baseSystem + dedupeNote

  // Anthropic-first; OpenAI fallback if no Anthropic key is set.
  if (env.ANTHROPIC_API_KEY) {
    return await callAnthropic(env.ANTHROPIC_API_KEY, systemPrompt, body.transcript)
  }
  if (env.OPENAI_API_KEY) {
    return await callOpenAI(env.OPENAI_API_KEY, systemPrompt, body.transcript)
  }
  return jsonResponse(500, { ok: false, error: 'no LLM API key configured (set ANTHROPIC_API_KEY or OPENAI_API_KEY)' })
}

function systemPromptForMode(mode: string): string {
  // Mirror of src/modes.ts on the plugin side. Kept simple — the plugin
  // sends the full prompt for custom mode, but we ship default fallbacks
  // here in case the plugin doesn't pass one.
  const PROMPTS: Record<string, string> = {
    date: 'You are a warm, curious conversation coach. Suggest 2-3 natural responses or questions the wearer could say next. Each under 12 words. Numbered list, no preamble.',
    'argue-calm': 'You are a couples therapist. Suggest 2-3 short responses that validate the other person\'s feelings. Avoid "but". Each under 12 words. Numbered list, no preamble.',
    'sales-close': 'You are a sales coach. Suggest 2-3 short responses to any objection raised. Each under 14 words. Numbered list, no preamble.',
    sting: 'Suggest 2-3 sharp but friendly comebacks under 12 words. Nothing mean. Numbered list, no preamble.',
    listen: 'Suggest 2-3 short reflective listening prompts ("what I hear is...", "tell me more about..."). Under 14 words. Numbered list, no preamble.',
    trivia: 'You are a trivia expert sitting next to the wearer at a quiz. Answer the most recent question in the transcript. Numbered list, at most two lines: 1. the answer alone (under 8 words); 2. the runner-up if unsure, else the fact that confirms it (under 10 words). No hedging. If there is no question yet, reply exactly: 1. No question heard yet.',
    interview: 'You are coaching the wearer through being interviewed. Based on the interviewer\'s most recent question, suggest 2-3 short structured answers (under 20 words). Lead with the headline; STAR framing only when natural. Avoid hedging language. Numbered list, no preamble.',
  }
  return PROMPTS[mode] ?? PROMPTS.date!
}

async function callAnthropic(
  apiKey: string,
  systemPrompt: string,
  transcript: string,
): Promise<Response> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5',
      max_tokens: 200,
      system: systemPrompt,
      messages: [
        {
          role: 'user',
          content: `Recent conversation transcript (the other person's voice):\n\n"${transcript}"\n\nSuggestions:`,
        },
      ],
    }),
  })
  if (!res.ok) {
    const text = await res.text()
    return jsonResponse(res.status, { ok: false, error: `anthropic ${res.status}: ${text.slice(0, 200)}` })
  }
  const json = (await res.json()) as { content?: Array<{ text?: string }> }
  const text = json.content?.[0]?.text ?? ''
  return jsonResponse(200, { ok: true, suggestions: parseNumberedList(text) })
}

async function callOpenAI(
  apiKey: string,
  systemPrompt: string,
  transcript: string,
): Promise<Response> {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      max_tokens: 200,
      messages: [
        { role: 'system', content: systemPrompt },
        {
          role: 'user',
          content: `Recent conversation transcript:\n\n"${transcript}"\n\nSuggestions:`,
        },
      ],
    }),
  })
  if (!res.ok) {
    const text = await res.text()
    return jsonResponse(res.status, { ok: false, error: `openai ${res.status}: ${text.slice(0, 200)}` })
  }
  const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> }
  const text = json.choices?.[0]?.message?.content ?? ''
  return jsonResponse(200, { ok: true, suggestions: parseNumberedList(text) })
}

// Parse "1. foo\n2. bar\n3. baz" into ["foo", "bar", "baz"]. Tolerates
// LLM preamble / trailing text by only keeping numbered lines.
function parseNumberedList(text: string): string[] {
  const lines = text.split(/\r?\n/)
  const out: string[] = []
  for (const line of lines) {
    const m = line.match(/^\s*\d+[.)]\s+(.+)$/)
    if (m && m[1]) out.push(m[1].trim())
  }
  return out.length > 0 ? out : [text.trim()]
}

async function handleWebSocket(request: Request, env: Env): Promise<Response> {
  // Auth via query token (WebSocket doesn't support custom headers from
  // browser clients reliably, so we accept the bearer in ?token=).
  const url = new URL(request.url)
  const token = url.searchParams.get('token')
  if (!env.SHARED_SECRET || token !== env.SHARED_SECRET) {
    return jsonResponse(401, { ok: false, error: 'unauthorized' })
  }

  const upgrade = request.headers.get('Upgrade') ?? ''
  if (upgrade.toLowerCase() !== 'websocket') {
    return jsonResponse(400, { ok: false, error: 'expected WebSocket upgrade' })
  }

  // Open a WebSocket to Deepgram and pipe frames in both directions.
  // Workers' fetch() supports outbound WS; WebSocketPair gives us the
  // pair to hand back to the client.
  const dgRes = await fetch(DEEPGRAM_WS, {
    headers: {
      Authorization: `Token ${env.DEEPGRAM_API_KEY}`,
      Upgrade: 'websocket',
    },
  })
  const dgWs = (dgRes as unknown as { webSocket: WebSocket }).webSocket
  if (!dgWs) return jsonResponse(502, { ok: false, error: 'failed to open Deepgram WS' })
  dgWs.accept()

  const pair = new WebSocketPair()
  const [client, server] = Object.values(pair) as [WebSocket, WebSocket]
  server.accept()

  // Pipe: glasses audio → Deepgram
  server.addEventListener('message', evt => {
    if (typeof evt.data === 'string') return // ignore text frames from client
    try {
      dgWs.send(evt.data)
    } catch {
      /* ignore */
    }
  })
  server.addEventListener('close', () => {
    try { dgWs.close() } catch { /* ignore */ }
  })

  // Pipe: Deepgram transcripts → glasses (as JSON text frames)
  dgWs.addEventListener('message', evt => {
    try {
      const data = typeof evt.data === 'string' ? evt.data : new TextDecoder().decode(evt.data as ArrayBuffer)
      const parsed = JSON.parse(data) as {
        channel?: { alternatives?: Array<{ transcript?: string }> }
        is_final?: boolean
      }
      const text = parsed.channel?.alternatives?.[0]?.transcript ?? ''
      if (text) {
        server.send(
          JSON.stringify({ type: 'transcript', text, isFinal: !!parsed.is_final }),
        )
      }
    } catch {
      /* ignore parse errors */
    }
  })
  dgWs.addEventListener('close', () => {
    try { server.close() } catch { /* ignore */ }
  })

  return new Response(null, { status: 101, webSocket: client })
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Log every incoming request so `wrangler tail` shows what's actually
    // arriving at the worker (vs what the plugin claims it's sending).
    // Catches the class of bug where Cloudflare WAF / WebView / a redirect
    // mangles the method en route. Cheap — Workers logging is async.
    // eslint-disable-next-line no-console
    console.log(`[req] ${request.method} ${new URL(request.url).pathname} ua=${(request.headers.get('user-agent') ?? '').slice(0, 60)}`)
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() })
    }
    const url = new URL(request.url)
    if (url.pathname === '/healthz') return jsonResponse(200, { ok: true })
    if (url.pathname === '/suggest') return handleSuggest(request, env)
    if (url.pathname === '/transcribe') return handleTranscribe(request, env)
    if (url.pathname === '/ws') return handleWebSocket(request, env)
    return jsonResponse(404, { ok: false, error: 'not found' })
  },
}
