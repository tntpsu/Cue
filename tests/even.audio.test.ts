// @vitest-environment jsdom
// Drives connectEvenRuntime against a fake bridge: the speaker-role gate
// on incoming audio events, the glasses-then-phone mic fallback, and the
// per-session role tally the diagnostic overlay prints.

import { describe, expect, it, vi } from 'vitest'

const hoisted = vi.hoisted(() => ({ bridge: null as unknown }))

vi.mock('@evenrealities/even_hub_sdk', async importOriginal => {
  const real = await importOriginal<typeof import('@evenrealities/even_hub_sdk')>()
  return { ...real, waitForEvenAppBridge: () => Promise.resolve(hoisted.bridge) }
})

import { connectEvenRuntime } from '../src/even'

interface BridgeOpts {
  glasses?: boolean | 'throw'
  phone?: boolean | 'throw'
}

function installBridge(opts: BridgeOpts = {}) {
  let listener: ((ev: unknown) => void) | null = null
  const calls: Array<[boolean, string | undefined]> = []
  const answer = (v: boolean | 'throw' | undefined) => {
    if (v === 'throw') throw new Error('refused')
    return v ?? true
  }
  hoisted.bridge = {
    createStartUpPageContainer: async () => 0,
    onEvenHubEvent: (cb: (ev: unknown) => void) => { listener = cb },
    audioControl: async (open: boolean, source?: string) => {
      calls.push([open, source])
      if (!open) return true
      return answer(source === 'phone' ? opts.phone : opts.glasses)
    },
    textContainerUpgrade: async () => 0,
    shutDownPageContainer: async () => 0,
    getLocalStorage: async () => '',
    setLocalStorage: async () => true,
    getDeviceInfo: async () => null,
  }
  return {
    calls,
    emit: (speakerRole?: unknown, direction?: unknown) => {
      const audioEvent: Record<string, unknown> = { audioPcm: new Uint8Array([1, 2, 3]) }
      if (speakerRole !== undefined) audioEvent.speakerRole = speakerRole
      if (direction !== undefined) audioEvent.direction = direction
      listener?.({ audioEvent })
    },
    clickMenu: (itemID: unknown) => { listener?.({ menuItemClickEvent: { itemID } }) },
  }
}

async function boot(opts?: BridgeOpts) {
  const fake = installBridge(opts)
  const runtime = await connectEvenRuntime('hello')
  if (!runtime) throw new Error('runtime did not connect')
  return { fake, runtime }
}

describe('speaker-role gate', () => {
  it('delivers every role when dropSelf is off', async () => {
    const { fake, runtime } = await boot()
    const got: number[] = []
    await runtime.startMic(() => { got.push(1) })
    fake.emit('self'); fake.emit('other'); fake.emit('unknown')
    expect(got).toHaveLength(3)
    expect(runtime.getAudioStats()).toEqual({ frames: 3, self: 1, other: 1, unknown: 1, dropped: 0 })
  })

  it('drops self frames only, when dropSelf is on', async () => {
    const { fake, runtime } = await boot()
    const got: number[] = []
    await runtime.startMic(() => { got.push(1) }, { dropSelf: true })
    fake.emit('self'); fake.emit('other'); fake.emit('unknown'); fake.emit('self')
    expect(got).toHaveLength(2)
    expect(runtime.getAudioStats()).toEqual({ frames: 4, self: 2, other: 1, unknown: 1, dropped: 2 })
  })

  it('treats an untagged frame as unknown and delivers it even with dropSelf', async () => {
    const { fake, runtime } = await boot()
    const got: number[] = []
    await runtime.startMic(() => { got.push(1) }, { dropSelf: true })
    fake.emit()
    fake.emit('something-new')
    expect(got).toHaveLength(2)
    expect(runtime.getAudioStats().unknown).toBe(2)
  })

  it('resets the tally on the next startMic', async () => {
    const { fake, runtime } = await boot()
    await runtime.startMic(() => {})
    fake.emit('other')
    await runtime.stopMic()
    await runtime.startMic(() => {})
    expect(runtime.getAudioStats().frames).toBe(0)
  })
})

describe('mic source fallback', () => {
  it('opens the glasses mic first', async () => {
    const { fake, runtime } = await boot()
    expect(await runtime.startMic(() => {})).toBe(true)
    expect(runtime.getMicSource()).toBe('glasses')
    expect(fake.calls).toEqual([[true, 'glasses']])
  })

  it('falls back to the phone mic when the glasses mic returns false', async () => {
    const { fake, runtime } = await boot({ glasses: false })
    expect(await runtime.startMic(() => {})).toBe(true)
    expect(runtime.getMicSource()).toBe('phone')
    expect(fake.calls).toEqual([[true, 'glasses'], [true, 'phone']])
  })

  it('falls back to the phone mic when the glasses mic throws', async () => {
    const { runtime } = await boot({ glasses: 'throw' })
    expect(await runtime.startMic(() => {})).toBe(true)
    expect(runtime.getMicSource()).toBe('phone')
  })

  it('reports failure and delivers nothing when both mics refuse', async () => {
    const { fake, runtime } = await boot({ glasses: false, phone: 'throw' })
    const got: number[] = []
    expect(await runtime.startMic(() => { got.push(1) })).toBe(false)
    expect(runtime.getMicSource()).toBeNull()
    fake.emit('other')
    expect(got).toHaveLength(0)
  })

  it('stopMic closes the mic and clears the source', async () => {
    const { fake, runtime } = await boot()
    await runtime.startMic(() => {})
    await runtime.stopMic()
    expect(runtime.getMicSource()).toBeNull()
    expect(fake.calls.at(-1)).toEqual([false, undefined])
  })
})

describe('direction tally', () => {
  it('counts role per raw direction, folds phone-mic null into none, resets on startMic', async () => {
    const { fake, runtime } = await boot()
    await runtime.startMic(() => {})
    fake.emit('other', 1); fake.emit('other', 1); fake.emit('self', 0); fake.emit('unknown', null); fake.emit()
    expect(runtime.getDirectionStats().get(1)).toEqual({ self: 0, other: 2, unknown: 0 })
    expect(runtime.getDirectionStats().get(0)).toEqual({ self: 1, other: 0, unknown: 0 })
    expect(runtime.getDirectionStats().get('none')).toEqual({ self: 0, other: 0, unknown: 2 })
    await runtime.stopMic()
    await runtime.startMic(() => {})
    expect(runtime.getDirectionStats().size).toBe(0)
  })
})

describe('contextual menu', () => {
  it('passes the menu to the startup page and dispatches numeric item clicks', async () => {
    let page: unknown
    const fake = installBridge()
    ;(hoisted.bridge as { createStartUpPageContainer: unknown }).createStartUpPageContainer = async (p: unknown) => { page = p; return 0 }
    const runtime = await connectEvenRuntime('hello', [{ id: 7, label: 'Switch to Date' }, { id: 0, label: 'bad id' }])
    if (!runtime) throw new Error('runtime did not connect')
    const menu = (page as { menuObject?: { menuItems: Array<{ itemID: number; itemName: string }> } }).menuObject
    expect(menu?.menuItems.map(m => [m.itemID, m.itemName])).toEqual([[7, 'Switch to Date']])
    const got: number[] = []
    runtime.onMenuSelect(id => { got.push(id) })
    fake.clickMenu(7); fake.clickMenu('7'); fake.clickMenu(undefined)
    expect(got).toEqual([7])
  })

  it('sends no menuObject when every item is invalid or the list is empty', async () => {
    let page: unknown
    installBridge()
    ;(hoisted.bridge as { createStartUpPageContainer: unknown }).createStartUpPageContainer = async (p: unknown) => { page = p; return 0 }
    await connectEvenRuntime('hello', [{ id: 0, label: 'bad' }])
    expect((page as { menuObject?: unknown }).menuObject).toBeUndefined()
  })
})
