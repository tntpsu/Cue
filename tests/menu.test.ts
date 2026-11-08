// @vitest-environment jsdom
// A malformed menu makes the firmware reject the whole page, so the menu
// spec is checked against the SDK's own validator before it can ship.

import { describe, expect, it } from 'vitest'
import {
  MenuContainerProperty,
  MenuItemProperty,
  TextContainerProperty,
  isMenuNameWithinLimit,
  isValidMenuItemID,
  validateEvenHubPageContainerMenu,
} from '@evenrealities/even_hub_sdk'
import { CUE_MENU, MENU_CALIBRATE, MENU_TOPICS, menuActionFor } from '../src/menu'
import { MODES } from '../src/modes'

describe('CUE_MENU', () => {
  it('passes the SDK page-menu validator', () => {
    const page = {
      containerTotalNum: 1,
      textObject: [new TextContainerProperty({ containerID: 1, containerName: 'x', content: '' })],
      menuObject: new MenuContainerProperty({
        menuItems: CUE_MENU.map(m => new MenuItemProperty({ itemName: m.label, itemID: m.id })),
      }),
    }
    expect(validateEvenHubPageContainerMenu(page)).toEqual({ valid: true })
  })

  it('keeps every item within firmware limits (10 items, 32-byte labels, unique non-zero ids)', () => {
    expect(CUE_MENU.length).toBeLessThanOrEqual(10)
    const ids = new Set<number>()
    for (const m of CUE_MENU) {
      expect(isValidMenuItemID(m.id), m.label).toBe(true)
      expect(isMenuNameWithinLimit(m.label), m.label).toBe(true)
      expect(ids.has(m.id), m.label).toBe(false)
      ids.add(m.id)
    }
  })

  it('has one switch item per mode, in cycle order, plus Calibrate me and Fresh topics', () => {
    expect(CUE_MENU.slice(0, MODES.length).map(m => m.label)).toEqual(MODES.map(m => `Switch to ${m.label}`))
    expect(CUE_MENU.map(m => m.id)).toContain(MENU_CALIBRATE)
    expect(CUE_MENU.map(m => m.id)).toContain(MENU_TOPICS)
  })

  it('has no exit or close item, which store submission forbids', () => {
    // Word-bounded: "Sales close" is a mode, not a close command.
    for (const m of CUE_MENU) expect(m.label).not.toMatch(/^(exit|close|quit)\b/i)
  })
})

describe('menuActionFor', () => {
  it('maps every item to its action and unknown ids to null', () => {
    for (const [i, mode] of MODES.entries()) {
      expect(menuActionFor(CUE_MENU[i]!.id)).toEqual({ kind: 'mode', mode: mode.id })
    }
    expect(menuActionFor(MENU_CALIBRATE)).toEqual({ kind: 'calibrate' })
    expect(menuActionFor(MENU_TOPICS)).toEqual({ kind: 'topics' })
    expect(menuActionFor(0)).toBeNull()
    expect(menuActionFor(999)).toBeNull()
  })
})
