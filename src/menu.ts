// Contextual menu (tap-and-hold on the glasses). Every entry is a one-shot
// command, so labels read as verbs. No exit item: the root-page double-tap
// contract stays the only way out, as store submission requires. The
// firmware caps a menu at 10 items; eight modes plus two commands fill it,
// so a ninth mode has to displace something (tests/menu.test.ts says so).

import { MODES, type ModeId } from './modes'

export interface MenuSpec {
  id: number
  label: string
}

export const MENU_MODE_BASE = 1
export const MENU_CALIBRATE = 20
export const MENU_TOPICS = 21

export const CUE_MENU: readonly MenuSpec[] = [
  ...MODES.map((m, i) => ({ id: MENU_MODE_BASE + i, label: `Switch to ${m.label}` })),
  { id: MENU_CALIBRATE, label: 'Calibrate me' },
  { id: MENU_TOPICS, label: 'Fresh topics' },
]

export type MenuAction =
  | { kind: 'mode'; mode: ModeId }
  | { kind: 'calibrate' }
  | { kind: 'topics' }

export function menuActionFor(itemID: number): MenuAction | null {
  if (itemID === MENU_CALIBRATE) return { kind: 'calibrate' }
  if (itemID === MENU_TOPICS) return { kind: 'topics' }
  const mode = MODES[itemID - MENU_MODE_BASE]
  return mode ? { kind: 'mode', mode: mode.id } : null
}
