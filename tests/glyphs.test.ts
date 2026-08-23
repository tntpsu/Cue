// Every glyph Cue draws on the glasses must exist in the firmware font.
//
// The firmware font is proportional AND incomplete. getTextWidth returns 20 for
// a supported symbol and 4 for one the font lacks — 4 is the missing-glyph
// fallback, which draws as a box on real hardware while looking perfectly fine
// in the simulator and in any editor.
//
// This shipped twice in Cue: '⚡' as the Sting mode glyph, and '◉' in the
// `◉ live` indicator — the primary signal that a Worker is configured rather
// than mock mode. Both measured 4. Nothing caught it because a wrong glyph is
// not a crash, a console error, or a blank screen.

import { describe, expect, it } from 'vitest'
import { getTextWidth } from '@evenrealities/pretext'
import { MODES } from '../src/modes'

/** Width of a glyph the font actually has. */
const SUPPORTED_PX = 20
/** The font's missing-glyph fallback advance. */
const MISSING_PX = 4

describe('glasses glyphs exist in the firmware font', () => {
  for (const mode of MODES) {
    it(`mode "${mode.id}" glyph ${mode.glyph} renders`, () => {
      const w = getTextWidth(mode.glyph)
      expect(w, `${mode.glyph} measures ${w}px — ${w === MISSING_PX ? 'MISSING from the font, will draw as a box' : 'unexpected width'}`)
        .toBe(SUPPORTED_PX)
    })
  }

  it('mode glyphs are distinct, so the glasses indicator is unambiguous', () => {
    const glyphs = MODES.map(m => m.glyph)
    expect(new Set(glyphs).size).toBe(glyphs.length)
  })

  it('status indicators render', () => {
    // ◎ live / ◌ mock — the idle screen's Worker-configured signal.
    for (const g of ['◎', '◌']) expect(getTextWidth(g)).toBe(SUPPORTED_PX)
  })

  it('the known-broken glyphs are still broken (guards the rule itself)', () => {
    // If a future font update fixes these, this test fails and the rule above
    // needs revisiting rather than being quietly wrong.
    for (const g of ['⚡', '◉']) expect(getTextWidth(g)).toBe(MISSING_PX)
  })
})
