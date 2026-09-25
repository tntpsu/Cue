// Guards store-listing.json against drifting from the build it describes.
// Card Pack's listing sat for months saying seven games and citing three
// missing screenshots; this is the same guard, for Cue's modes and pipeline.

import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { MODES } from '../src/modes'
import { PROVIDER_ORIGINS } from '../src/providers'

const ROOT = resolve(__dirname, '..')
const listing = JSON.parse(readFileSync(resolve(ROOT, 'store-listing.json'), 'utf8'))
const appJson = JSON.parse(readFileSync(resolve(ROOT, 'app.json'), 'utf8'))
const CATEGORIES = ['AI', 'Lifestyle', 'Productivity', 'Health', 'Entertainment', 'Education', 'Music', 'Travel', 'Utilities']

function pngSize(path: string): { w: number; h: number } {
  const b = readFileSync(path)
  expect(b.subarray(0, 8).toString('hex'), `${path} is not a PNG`).toBe('89504e470d0a1a0a')
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) }
}

describe('store-listing.json matches the build', () => {
  it('names every mode in the description', () => {
    const desc = listing.description.toLowerCase()
    const missing = MODES.map(m => m.label).filter(l => !desc.includes(l.toLowerCase()))
    expect(missing, 'modes in modes.ts the description never mentions').toEqual([])
  })

  it('discloses the same providers the whitelist allows, and the mic', () => {
    const text = (listing.description + ' ' + listing.third_party_services.join(' ')).toLowerCase()
    for (const name of ['deepgram', 'anthropic', 'openai']) expect(text, name).toContain(name)
    expect(listing.permissions.microphone).toBe(true)
    expect(listing.data_collection.ai_used).toBe(true)
    const whitelist: string[] = appJson.permissions.find((p: { name: string }) => p.name === 'network').whitelist
    for (const origin of PROVIDER_ORIGINS) expect(whitelist, origin).toContain(origin)
  })

  it('states the Even App floor the manifest declares', () => {
    expect(listing.description).toContain(`Even app ${appJson.min_app_version} or newer`)
  })

  it('stays inside the portal field limits, plain text only', () => {
    expect(listing.name.length).toBeLessThanOrEqual(20)
    expect(listing.tagline.length).toBeLessThanOrEqual(50)
    expect(listing.description.length).toBeLessThanOrEqual(2000)
    expect(listing.tags.length).toBeLessThanOrEqual(5)
    for (const t of listing.tags) expect(t.length, `tag "${t}"`).toBeLessThanOrEqual(20)
    expect(CATEGORIES).toContain(listing.category)
    expect(listing.description).not.toMatch(/\*\*|^- /m)
    expect(listing.icon_text.length).toBeLessThanOrEqual(3)
    // The privacy wizard's free-text rows are cut at 50 by the driver; a
    // longer entry ships truncated mid-word into the generated PDF.
    for (const e of [...listing.third_party_services, ...listing.data_collection.other]) expect(e.length, e).toBeLessThanOrEqual(50)
  })

  it('cites screenshots that exist and are exactly 576x288', () => {
    expect(listing.screenshots.length).toBeGreaterThan(0)
    for (const rel of listing.screenshots) {
      const p = resolve(ROOT, rel)
      expect(existsSync(p), `${rel} is listed but missing`).toBe(true)
      expect(pngSize(p), rel).toEqual({ w: 576, h: 288 })
    }
    expect(listing.cover_screenshot_index).toBeGreaterThanOrEqual(0)
    expect(listing.cover_screenshot_index).toBeLessThan(listing.screenshots.length)
  })
})
