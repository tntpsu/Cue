// Live provider check: runs ONLY when real keys are in the environment, so the
// default `npm test` stays offline and deterministic (it reports these as
// skipped). Proves auth + request shape against the real APIs without the
// Worker in the loop:
//
//   DEEPGRAM_API_KEY=... ANTHROPIC_API_KEY=... npm run test:backends
//   (or OPENAI_API_KEY instead of ANTHROPIC_API_KEY)
//
// A second of silence is enough for Deepgram to answer 200 with an empty
// transcript, which is all the auth path needs; it costs nothing measurable.

import { describe, expect, it } from 'vitest'
import { transcribeDirect, suggestDirect, buildSystemPrompt } from '../src/providers'

const DG = process.env.DEEPGRAM_API_KEY ?? ''
const ANTHROPIC = process.env.ANTHROPIC_API_KEY ?? ''
const OPENAI = process.env.OPENAI_API_KEY ?? ''

describe.skipIf(!DG)('live: Deepgram', () => {
  it('accepts the key and returns a transcript object for one second of silence', async () => {
    const r = await transcribeDirect(new Uint8Array(32_000), DG)
    expect(r.ok, JSON.stringify(r)).toBe(true)
    if (r.ok) expect(typeof r.text).toBe('string')
  }, 30_000)
})

describe.skipIf(!ANTHROPIC && !OPENAI)('live: LLM', () => {
  it('returns numbered suggestions for a short transcript', async () => {
    const provider = ANTHROPIC ? 'anthropic' as const : 'openai' as const
    const r = await suggestDirect({
      provider, apiKey: ANTHROPIC || OPENAI,
      systemPrompt: buildSystemPrompt({ mode: 'listen' }),
      transcript: "I just don't feel like anyone at work listens to my ideas.",
    })
    expect(r.ok, JSON.stringify(r)).toBe(true)
    if (r.ok) { expect(r.suggestions.length).toBeGreaterThan(0); expect(r.suggestions[0]!.length).toBeGreaterThan(3) }
  }, 30_000)
})
