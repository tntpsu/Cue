// @vitest-environment jsdom
// Pins the string literals in src/audio-role.ts to the SDK enum, so an
// SDK rename shows up here rather than as every frame silently reading
// as "unknown" on the glasses.

import { describe, expect, it } from 'vitest'
import { AudioSpeakerRole } from '@evenrealities/even_hub_sdk'
import { emptyAudioStats, shouldDeliver, speakerRoleOf, tallyFrame } from '../src/audio-role'

describe('speakerRoleOf', () => {
  it('maps every SDK role to its literal', () => {
    expect(speakerRoleOf(AudioSpeakerRole.Self)).toBe('self')
    expect(speakerRoleOf(AudioSpeakerRole.Other)).toBe('other')
    expect(speakerRoleOf(AudioSpeakerRole.Unknown)).toBe('unknown')
  })

  it('degrades anything else to unknown', () => {
    for (const raw of [undefined, null, 0, 1, 'SELF', 'me', {}, true]) {
      expect(speakerRoleOf(raw)).toBe('unknown')
    }
  })
})

describe('shouldDeliver', () => {
  it('drops only self, and only when asked', () => {
    expect(shouldDeliver('self', true)).toBe(false)
    expect(shouldDeliver('other', true)).toBe(true)
    expect(shouldDeliver('unknown', true)).toBe(true)
    expect(shouldDeliver('self', false)).toBe(true)
    expect(shouldDeliver('other', false)).toBe(true)
    expect(shouldDeliver('unknown', false)).toBe(true)
  })
})

describe('tallyFrame', () => {
  it('counts frames by role and dropped separately', () => {
    const s = emptyAudioStats()
    tallyFrame(s, 'self', false)
    tallyFrame(s, 'self', true)
    tallyFrame(s, 'other', true)
    tallyFrame(s, 'unknown', true)
    expect(s).toEqual({ frames: 4, self: 2, other: 1, unknown: 1, dropped: 1 })
  })
})
