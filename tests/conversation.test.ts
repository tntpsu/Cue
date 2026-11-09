// Tests for v0.4.0 conversation accumulation logic in utterance.ts.
// These cover the bug the user reported on hardware ("words show up
// then get overwritten by next chunk") and the speaker-labeling +
// pruning behavior.

import { describe, expect, it } from 'vitest'
import {
  appendTurn,
  pruneTurns,
  speakerLabel,
  type ConversationTurn,
} from '../src/utterance'

describe('appendTurn — same-speaker continuation', () => {
  it('first call seeds the buffer', () => {
    const buf: ConversationTurn[] = []
    appendTurn(buf, 0, 'hello', 1000)
    expect(buf).toHaveLength(1)
    expect(buf[0]).toMatchObject({ speaker: 0, text: 'hello', ts: 1000 })
  })

  it('same speaker → words append into the same turn (the v0.3 bug)', () => {
    const buf: ConversationTurn[] = []
    appendTurn(buf, 0, 'hello there', 1000)
    appendTurn(buf, 0, 'how are you', 1100)
    expect(buf).toHaveLength(1)
    expect(buf[0]!.text).toBe('hello there how are you')
    expect(buf[0]!.ts).toBe(1100) // updated to latest
  })

  it('speaker change → new turn', () => {
    const buf: ConversationTurn[] = []
    appendTurn(buf, 0, 'hi', 1000)
    appendTurn(buf, 1, 'hello back', 1100)
    expect(buf).toHaveLength(2)
    expect(buf[0]!.speaker).toBe(0)
    expect(buf[1]!.speaker).toBe(1)
  })

  it('speaker bounce → three turns even with same words', () => {
    const buf: ConversationTurn[] = []
    appendTurn(buf, 0, 'one', 1000)
    appendTurn(buf, 1, 'two', 1100)
    appendTurn(buf, 0, 'three', 1200)
    expect(buf).toHaveLength(3)
    expect(buf.map(t => t.text)).toEqual(['one', 'two', 'three'])
  })

  it('empty/whitespace text is a no-op', () => {
    const buf: ConversationTurn[] = []
    appendTurn(buf, 0, '', 1000)
    appendTurn(buf, 0, '   ', 1100)
    expect(buf).toHaveLength(0)
  })

  it('trims leading/trailing whitespace on new turns', () => {
    const buf: ConversationTurn[] = []
    appendTurn(buf, 0, '  padded  ', 1000)
    expect(buf[0]!.text).toBe('padded')
  })
})

describe('appendTurn — wearer verdict', () => {
  it('defaults to not-the-wearer and keeps the flag on the turn', () => {
    const buf: ConversationTurn[] = []
    appendTurn(buf, 0, 'hello', 1000)
    appendTurn(buf, 1, 'this is me', 1100, true)
    expect(buf.map(t => t.wearer)).toEqual([false, true])
  })

  it('does not merge same-speaker-id turns with different verdicts (ids restart every chunk)', () => {
    const buf: ConversationTurn[] = []
    appendTurn(buf, 0, 'how was your week', 1000, false)
    appendTurn(buf, 0, 'pretty good thanks', 1100, true)
    appendTurn(buf, 0, 'glad to hear', 1200, true)
    expect(buf).toHaveLength(2)
    expect(buf[1]!.text).toBe('pretty good thanks glad to hear')
    expect(buf[1]!.wearer).toBe(true)
  })
})

describe('pruneTurns', () => {
  it('drops turns older than scrollback window', () => {
    const buf: ConversationTurn[] = [
      { speaker: 0, text: 'old', ts: 0 },
      { speaker: 0, text: 'fresh', ts: 100_000 },
    ]
    // Default scrollback is 30s. now=130_000 → cutoff=100_000.
    pruneTurns(buf, 130_000)
    expect(buf).toHaveLength(1)
    expect(buf[0]!.text).toBe('fresh')
  })

  it('respects the hard cap even within window', () => {
    const buf: ConversationTurn[] = []
    for (let i = 0; i < 20; i++) {
      buf.push({ speaker: i % 2, text: `t${i}`, ts: 1000 + i })
    }
    pruneTurns(buf, 1100, { scrollbackMs: 1_000_000, hardCap: 5 })
    expect(buf).toHaveLength(5)
    // Newest survive — should be t15 onward
    expect(buf[0]!.text).toBe('t15')
    expect(buf[4]!.text).toBe('t19')
  })

  it('appendTurn calls pruneTurns automatically', () => {
    const buf: ConversationTurn[] = []
    for (let i = 0; i < 10; i++) {
      appendTurn(buf, i, `t${i}`, 1000 + i, false, { scrollbackMs: 60_000, hardCap: 3 })
    }
    expect(buf).toHaveLength(3)
  })
})

describe('speakerLabel', () => {
  it('maps small ints to A/B/C', () => {
    expect(speakerLabel(0)).toBe('A')
    expect(speakerLabel(1)).toBe('B')
    expect(speakerLabel(2)).toBe('C')
    expect(speakerLabel(25)).toBe('Z')
  })
  it('clamps negative + over-26', () => {
    expect(speakerLabel(-1)).toBe('A')
    expect(speakerLabel(100)).toBe('Z')
  })
})
