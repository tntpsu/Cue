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
