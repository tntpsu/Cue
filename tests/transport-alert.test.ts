// Failure visibility: a session that has stopped working must LOOK stopped.
//
// Per-chunk transport errors previously went only to console.warn, and the
// glasses `err:` line is gated behind the diagnostic overlay, which is off by
// default. So the likeliest real failure — a Deepgram quota running out mid
// conversation — was indistinguishable from nobody talking: every chunk 429s,
// the last suggestion stays on screen, and the wearer assumes it is quiet.
//
// These cover the classifier that turns a transport message into a
// glasses-sized label. The banner's render path is exercised in the JSDOM
// bridge tests.

import { describe, expect, it } from 'vitest'
import { getTextWidth } from '@evenrealities/pretext'

/** Mirrors shortTransportAlert in src/main.ts. Kept in sync deliberately:
 *  the function is module-private there, and the mapping is what matters. */
function shortTransportAlert(msg: string): string {
  const m = /HTTP (\d+)/.exec(msg)
  const status = m ? Number(m[1]) : null
  if (status === 401 || status === 403) return 'key rejected'
  if (status === 429) return 'rate limited'
  if (status === 404 || status === 405) return 'worker URL wrong'
  if (status !== null && status >= 500) return 'worker error'
  if (/network/i.test(msg)) return 'no connection'
  return 'transcribe failing'
}

describe('transport failure labels', () => {
  const cases: Array<[string, string]> = [
    ['transcribe HTTP 401: unauthorized', 'key rejected'],
    ['transcribe HTTP 403: forbidden', 'key rejected'],
    ['transcribe HTTP 429: too many requests', 'rate limited'],
    ['transcribe HTTP 404: no route', 'worker URL wrong'],
    ['transcribe HTTP 405: method not allowed', 'worker URL wrong'],
    ['transcribe HTTP 500: upstream boom', 'worker error'],
    ['transcribe HTTP 503: unavailable', 'worker error'],
    ['transcribe network error: Load failed', 'no connection'],
    ['something entirely unexpected', 'transcribe failing'],
  ]

  for (const [msg, expected] of cases) {
    it(`"${msg.slice(0, 34)}…" → ${expected}`, () => {
      expect(shortTransportAlert(msg)).toBe(expected)
    })
  }

  it('every label fits a glasses line and is plain ASCII', () => {
    // The banner renders as `ERR <label>`. ASCII on purpose: '⚠' (U+26A0)
    // measures 4px — missing from the firmware font — and would draw as a box,
    // which is exactly the failure this banner exists to surface.
    for (const [, label] of cases) {
      const line = `ERR ${label}`
      expect(line).toMatch(/^[\x20-\x7E]+$/)
      expect(getTextWidth(line)).toBeLessThan(576)
    }
  })

  it('a rate-limit label is distinguishable from an auth failure', () => {
    // The whole point: "quiet" and "broken" must not look the same, and the two
    // most common breakages need different remedies (wait vs fix your key).
    expect(shortTransportAlert('transcribe HTTP 429: x'))
      .not.toBe(shortTransportAlert('transcribe HTTP 401: x'))
  })
})
