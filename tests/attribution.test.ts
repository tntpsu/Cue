// Who spoke each Deepgram utterance, decided from the Even speaker-role
// spans the transport records per chunk (src/attribution.ts). Deepgram
// numbers speakers afresh in every chunk, so this is the only identity
// that survives a chunk boundary.

import { describe, expect, it } from 'vitest'
import {
  attribute,
  emptyAttributionStats,
  mixOver,
  summarizeAttribution,
  tallyAttribution,
  type RoleSpan,
} from '../src/attribution'

const spans: RoleSpan[] = [
  { startMs: 0, endMs: 1000, role: 'self' },
  { startMs: 1000, endMs: 1200, role: 'unknown' },
  { startMs: 1200, endMs: 2500, role: 'other' },
]

describe('mixOver', () => {
  it('sums the overlap of each role inside the window', () => {
    expect(mixOver(spans, 0, 2500)).toEqual({ self: 1000, other: 1300, unknown: 200 })
    expect(mixOver(spans, 500, 1500)).toEqual({ self: 500, other: 300, unknown: 200 })
  })

  it('is zero outside the spans or for an empty window', () => {
    expect(mixOver(spans, 3000, 4000)).toEqual({ self: 0, other: 0, unknown: 0 })
    expect(mixOver(spans, 1000, 1000)).toEqual({ self: 0, other: 0, unknown: 0 })
    expect(mixOver(spans, 1500, 1000)).toEqual({ self: 0, other: 0, unknown: 0 })
  })
})

describe('attribute', () => {
  it('calls a self-dominated utterance the wearer and an other-dominated one someone else', () => {
    expect(attribute({ startMs: 0, endMs: 900 }, spans, 2500).wearer).toBe(true)
    expect(attribute({ startMs: 1300, endMs: 2500 }, spans, 2500).wearer).toBe(false)
  })

  it('abstains when the tagged audio under the utterance is too short', () => {
    expect(attribute({ startMs: 1000, endMs: 1200 }, spans, 2500).wearer).toBeNull()
    expect(attribute({ startMs: 900, endMs: 1250 }, spans, 2500).wearer).toBeNull()
  })

  it('abstains on the phone mic, where every frame is unknown', () => {
    const phone: RoleSpan[] = [{ startMs: 0, endMs: 2500, role: 'unknown' }]
    expect(attribute({ startMs: 0, endMs: 2500 }, phone, 2500).wearer).toBeNull()
    expect(attribute({}, phone, 2500).wearer).toBeNull()
  })

  it('abstains with no spans at all (older host without the tag)', () => {
    expect(attribute({ startMs: 0, endMs: 2500 }, [], 2500).wearer).toBeNull()
  })

  it('judges an untimed utterance against the whole chunk', () => {
    const selfChunk: RoleSpan[] = [{ startMs: 0, endMs: 2500, role: 'self' }]
    expect(attribute({}, selfChunk, 2500).wearer).toBe(true)
    // Mixed chunk, no timing: self is 1000 of 2300 tagged ms, under the 60% bar.
    expect(attribute({}, spans, 2500).wearer).toBe(false)
    const even: RoleSpan[] = [
      { startMs: 0, endMs: 1250, role: 'self' },
      { startMs: 1250, endMs: 2500, role: 'other' },
    ]
    expect(attribute({}, even, 2500).wearer).toBe(false)
  })

  it('treats a reversed or missing end as untimed', () => {
    const selfChunk: RoleSpan[] = [{ startMs: 0, endMs: 2500, role: 'self' }]
    expect(attribute({ startMs: 900, endMs: 100 }, selfChunk, 2500).wearer).toBe(true)
    expect(attribute({ startMs: 900 }, selfChunk, 2500).wearer).toBe(true)
  })

  it('honours the share threshold exactly at the boundary', () => {
    const sixty: RoleSpan[] = [
      { startMs: 0, endMs: 600, role: 'self' },
      { startMs: 600, endMs: 1000, role: 'other' },
    ]
    expect(attribute({ startMs: 0, endMs: 1000 }, sixty, 1000).wearer).toBe(true)
    expect(attribute({ startMs: 0, endMs: 1000 }, sixty, 1000, { minTaggedMs: 300, selfShare: 0.61 }).wearer).toBe(false)
  })
})

describe('attribution stats', () => {
  it('counts each verdict and prints the overlay line', () => {
    const stats = emptyAttributionStats()
    tallyAttribution(stats, { wearer: true, mix: { self: 1, other: 0, unknown: 0 } })
    tallyAttribution(stats, { wearer: false, mix: { self: 0, other: 1, unknown: 0 } })
    tallyAttribution(stats, { wearer: false, mix: { self: 0, other: 1, unknown: 0 } })
    tallyAttribution(stats, { wearer: null, mix: { self: 0, other: 0, unknown: 1 } })
    expect(stats).toEqual({ you: 1, other: 2, untagged: 1 })
    expect(summarizeAttribution(stats)).toBe('you=1 other=2 untagged=1')
    expect(summarizeAttribution(emptyAttributionStats())).toBe('you=0 other=0 untagged=0')
  })
})
