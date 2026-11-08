// Speaker-role gate for glasses audio frames. SDK 0.0.16 tags every PCM
// frame with `speakerRole`, computed by the Even app from the glasses'
// direction sensor. It is a heuristic, not a firmware identity, so the
// gate only ever drops frames tagged `self`, and only when asked to.

export type SpeakerRole = 'self' | 'other' | 'unknown'

export interface AudioFrameStats {
  frames: number
  self: number
  other: number
  unknown: number
  dropped: number
}

// String literals rather than the SDK enum so this module stays
// importable without a window; tests/audio-role.test.ts pins the two
// to each other.
export function speakerRoleOf(raw: unknown): SpeakerRole {
  if (raw === 'self') return 'self'
  if (raw === 'other') return 'other'
  return 'unknown'
}

export function shouldDeliver(role: SpeakerRole, dropSelf: boolean): boolean {
  return !(dropSelf && role === 'self')
}

export function emptyAudioStats(): AudioFrameStats {
  return { frames: 0, self: 0, other: 0, unknown: 0, dropped: 0 }
}

export function tallyFrame(stats: AudioFrameStats, role: SpeakerRole, delivered: boolean): void {
  stats.frames += 1
  stats[role] += 1
  if (!delivered) stats.dropped += 1
}

// Raw glasses direction tag per frame (null on the phone mic and older
// hosts), tallied against the role the app derived from it. Field data
// for judging the heuristic; nothing is gated on it.
export type DirectionKey = number | 'none'
export type DirectionTally = Record<SpeakerRole, number>
export type DirectionStats = Map<DirectionKey, DirectionTally>

export function directionKeyOf(raw: unknown): DirectionKey {
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : 'none'
}

export function tallyDirection(stats: DirectionStats, key: DirectionKey, role: SpeakerRole): void {
  const t = stats.get(key) ?? { self: 0, other: 0, unknown: 0 }
  t[role] += 1
  stats.set(key, t)
}

// "d0:s12/o3/u0 d1:s0/o40/u2", busiest directions first, capped so the
// line fits the overlay. Empty tally reads "none".
export function summarizeDirections(stats: DirectionStats, max = 3): string {
  const total = (t: DirectionTally) => t.self + t.other + t.unknown
  const rows = [...stats.entries()].sort((a, b) => total(b[1]) - total(a[1])).slice(0, max)
  if (rows.length === 0) return 'none'
  return rows.map(([k, t]) => `d${k === 'none' ? '?' : k}:s${t.self}/o${t.other}/u${t.unknown}`).join(' ')
}
