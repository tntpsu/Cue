// Who said each Deepgram utterance, decided from the Even app's per-frame
// speakerRole tag rather than from Deepgram's speaker ids. Every 2.5 s
// chunk is its own batch request, so Deepgram numbers speakers from 0 in
// each chunk and "Speaker A" means whoever spoke first in that chunk, not
// a person. The role spans the transport records as frames arrive are the
// only cross-chunk identity we have.

import type { SpeakerRole } from './audio-role'

export interface RoleSpan {
  startMs: number
  endMs: number
  role: SpeakerRole
}

export interface TimedUtterance {
  startMs?: number
  endMs?: number
}

// Milliseconds of each role inside a window.
export interface RoleMix {
  self: number
  other: number
  unknown: number
}

export interface Attribution {
  // true = the wearer, false = someone else, null = no usable tag (phone
  // mic, untagged host, or too little tagged audio under the utterance).
  wearer: boolean | null
  mix: RoleMix
}

export interface AttributionConfig {
  // Tagged (self + other) ms required before the tag is trusted at all.
  minTaggedMs: number
  // Share of tagged ms that must be self for the utterance to be the wearer's.
  selfShare: number
}

export const DEFAULT_ATTRIBUTION: AttributionConfig = {
  minTaggedMs: 300,
  selfShare: 0.6,
}

export function mixOver(spans: readonly RoleSpan[], startMs: number, endMs: number): RoleMix {
  const mix: RoleMix = { self: 0, other: 0, unknown: 0 }
  if (!(endMs > startMs)) return mix
  for (const s of spans) {
    const overlap = Math.min(s.endMs, endMs) - Math.max(s.startMs, startMs)
    if (overlap > 0) mix[s.role] += overlap
  }
  return mix
}

// An utterance without timing (older Worker) is judged against the whole
// chunk, which is right whenever one person spoke for the whole 2.5 s and
// abstains (null) when the chunk is mixed.
export function attribute(
  utt: TimedUtterance,
  spans: readonly RoleSpan[],
  chunkMs: number,
  cfg: AttributionConfig = DEFAULT_ATTRIBUTION,
): Attribution {
  const timed = typeof utt.startMs === 'number' && typeof utt.endMs === 'number' && utt.endMs > utt.startMs
  const mix = timed ? mixOver(spans, utt.startMs!, utt.endMs!) : mixOver(spans, 0, chunkMs)
  const tagged = mix.self + mix.other
  if (tagged < cfg.minTaggedMs) return { wearer: null, mix }
  return { wearer: mix.self / tagged >= cfg.selfShare, mix }
}

// Overlay counters: how many utterances each verdict got this session.
export interface AttributionStats {
  you: number
  other: number
  untagged: number
}

export function emptyAttributionStats(): AttributionStats {
  return { you: 0, other: 0, untagged: 0 }
}

export function tallyAttribution(stats: AttributionStats, a: Attribution): void {
  if (a.wearer === true) stats.you += 1
  else if (a.wearer === false) stats.other += 1
  else stats.untagged += 1
}

export function summarizeAttribution(stats: AttributionStats): string {
  return `you=${stats.you} other=${stats.other} untagged=${stats.untagged}`
}
