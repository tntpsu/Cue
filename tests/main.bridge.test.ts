// Mock-bridge JSDOM tests for the v0.3 state machine.
//
// The existing main.dom.test.ts covers the "no bridge" path (jsdom returns
// null from connectEvenRuntime, so micOn flows are unreachable). These
// tests mock src/even so connectEvenRuntime returns a controllable fake
// runtime, letting us exercise: tap → mic on, idle-auto-pause, battery
// header refresh, and mode cycling — flows that need bridge events to fire.
//
// Pattern: vi.doMock('../src/even') is set up in beforeEach with a fresh
// fakeBridge each time, then vi.resetModules + dynamic import so main.ts
// picks up the mock.

/// <reference types="vitest/globals" />
// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

interface FakeRuntime {
  render: (text: string) => Promise<void>
  onTap: (h: (src: string) => void) => void
  onSwipe: (h: (dir: string, src: string) => void) => void
  onDoubleTap: (h: (src: string) => void) => void
  onForeground: (h: () => void) => void
  startMic: (h: (frame: Uint8Array) => void) => Promise<boolean>
  stopMic: () => Promise<void>
  exitApp: () => Promise<void>
  getStorage: (k: string) => Promise<string>
  setStorage: (k: string, v: string) => Promise<boolean>
  getBatteryLevel: () => Promise<number | undefined>
}

interface FakeBridge {
  runtime: FakeRuntime
  // Captured handlers — call these from the test to simulate input.
  invokeTap: (src?: string) => void
  invokeDoubleTap: (src?: string) => void
  invokeForeground: () => void
  // State spies — reads what the runtime got asked to do.
  lastRender: () => string
  micActive: () => boolean
  // Mutators for test scenarios.
  setBattery: (n: number | undefined) => void
}

function createFakeBridge(initialBattery: number | undefined = 80): FakeBridge {
  let tapHandler: ((src: string) => void) | null = null
  let doubleTapHandler: ((src: string) => void) | null = null
  let foregroundHandler: (() => void) | null = null
  let lastRendered = ''
  let mic = false
  let battery = initialBattery
  const storage: Record<string, string> = {}

  const runtime: FakeRuntime = {
    render: async (text: string) => { lastRendered = text },
    onTap: h => { tapHandler = h },
    onSwipe: () => {},
    onDoubleTap: h => { doubleTapHandler = h },
    onForeground: h => { foregroundHandler = h },
    startMic: async () => { mic = true; return true },
    stopMic: async () => { mic = false },
    exitApp: async () => {},
    getStorage: async k => storage[k] ?? '',
    setStorage: async (k, v) => { storage[k] = v; return true },
    getBatteryLevel: async () => battery,
  }
  return {
    runtime,
    invokeTap: (src = 'glasses') => tapHandler?.(src),
    invokeDoubleTap: (src = 'glasses') => doubleTapHandler?.(src),
    invokeForeground: () => foregroundHandler?.(),
    lastRender: () => lastRendered,
    micActive: () => mic,
    setBattery: n => { battery = n },
  }
}

let fake: FakeBridge

async function bootMocked(initialStorage: Record<string, string> = {}) {
  vi.resetModules()
  fake = createFakeBridge()

  // Pre-populate the bridge-backed storage that main.ts will read on
  // bootstrap. setStorageBridge swaps the storage backend after bridge
  // init, but the privacy-agreed read happens BEFORE setStorageBridge —
  // that read goes through the localStorage fallback. So we populate
  // BOTH paths to keep tests robust to that ordering.
  for (const [k, v] of Object.entries(initialStorage)) {
    await fake.runtime.setStorage(k, v)
  }
  const lsStore = { ...initialStorage }
  globalThis.localStorage = {
    getItem: (k: string) => lsStore[k] ?? null,
    setItem: (k: string, v: string) => { lsStore[k] = v },
    removeItem: (k: string) => { delete lsStore[k] },
    clear: () => { for (const k of Object.keys(lsStore)) delete lsStore[k] },
    key: (i: number) => Object.keys(lsStore)[i] ?? null,
    get length() { return Object.keys(lsStore).length },
  } as Storage

  vi.doMock('../src/even', () => ({
    connectEvenRuntime: vi.fn(() => Promise.resolve(fake.runtime)),
  }))

  document.body.innerHTML = '<div id="app"></div>'
  // @ts-expect-error — define is normally injected by Vite at build time
  globalThis.__APP_VERSION__ = '0.0.0-test'

  await import('../src/main')
  // Bootstrap is async — give it room to finish.
  await new Promise(r => setTimeout(r, 60))
}

afterEach(() => {
  document.body.innerHTML = ''
  vi.doUnmock('../src/even')
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('Cue plugin with mocked bridge', () => {
  it('renders the idle screen with battery glyph after bootstrap', async () => {
    await bootMocked({ 'cue:privacy-agreed:v1': '1' })
    // Bootstrap finished and called even.render at least once with the
    // idle screen. Battery 80 → solid glyph + percent.
    expect(fake.lastRender()).toMatch(/■80%/)
    expect(fake.lastRender()).toMatch(/mic off/)
  })

  it('tap on glasses turns mic on (mock mode)', async () => {
    // Mock mode (no Worker URL+token) is the default in this test.
    // Mock mode does NOT call even.startMic — it drives suggestions on a
    // canned timer instead. So the right signal for "mic on" is the
    // rendered LIVE marker, not fake.micActive() (which only flips when
    // even.startMic is reached, i.e. real-mode startRealSession).
    await bootMocked({ 'cue:privacy-agreed:v1': '1' })
    expect(fake.lastRender()).toMatch(/mic off/)
    fake.invokeTap('glasses')
    await new Promise(r => setTimeout(r, 20))
    expect(fake.lastRender()).toMatch(/LIVE/)
  })

  it('idle auto-pause fires after the configured threshold', async () => {
    await bootMocked({
      'cue:privacy-agreed:v1': '1',
      'cue:idle-auto-pause-min:v1': '1', // 1 min for a quick test
    })

    // Install fake timers BEFORE tap so startMicTick's setInterval
    // registers against the fake clock. If we install after the tap, the
    // interval ends up on the real clock and advanceTimersByTimeAsync
    // can't fire it.
    vi.useFakeTimers({ now: Date.now() })

    fake.invokeTap('glasses')
    // Small advance flushes the toggleMic async chain (microtasks) so
    // startMicTick's setInterval is in place.
    await vi.advanceTimersByTimeAsync(20)
    expect(fake.lastRender()).toMatch(/LIVE/)

    // Past 1 minute. Mic-tick fires every 1s; idle threshold 1 min, so
    // by ~61s the tick should observe the timeout and auto-pause.
    await vi.advanceTimersByTimeAsync(70_000)

    expect(fake.lastRender()).toMatch(/Auto-paused/)
    expect(fake.lastRender()).toMatch(/mic off/)
  })

  it('idle auto-pause is skipped when set to 0', async () => {
    await bootMocked({
      'cue:privacy-agreed:v1': '1',
      'cue:idle-auto-pause-min:v1': '0', // disabled
    })
    vi.useFakeTimers({ now: Date.now() })
    fake.invokeTap('glasses')
    await vi.advanceTimersByTimeAsync(20)
    expect(fake.lastRender()).toMatch(/LIVE/)

    // Advance way past any reasonable threshold — should stay LIVE.
    await vi.advanceTimersByTimeAsync(20 * 60_000)
    expect(fake.lastRender()).toMatch(/LIVE/)
    expect(fake.lastRender()).not.toMatch(/Auto-paused/)
  })

  it('battery glyph in header reflects the cached level', async () => {
    fake = createFakeBridge(15) // low battery
    // Re-mock with the low-battery bridge before boot.
    vi.resetModules()
    vi.doMock('../src/even', () => ({
      connectEvenRuntime: vi.fn(() => Promise.resolve(fake.runtime)),
    }))
    const lsStore: Record<string, string> = { 'cue:privacy-agreed:v1': '1' }
    globalThis.localStorage = {
      getItem: k => lsStore[k] ?? null,
      setItem: (k, v) => { lsStore[k] = v },
      removeItem: k => { delete lsStore[k] },
      clear: () => { for (const k of Object.keys(lsStore)) delete lsStore[k] },
      key: i => Object.keys(lsStore)[i] ?? null,
      get length() { return Object.keys(lsStore).length },
    } as Storage
    await fake.runtime.setStorage('cue:privacy-agreed:v1', '1')
    document.body.innerHTML = '<div id="app"></div>'
    // @ts-expect-error
    globalThis.__APP_VERSION__ = '0.0.0-test'
    await import('../src/main')
    await new Promise(r => setTimeout(r, 60))

    // Below 20% → hollow ring glyph.
    expect(fake.lastRender()).toMatch(/○15%/)
  })

  it('double-tap on glasses while mic off cycles modes', async () => {
    await bootMocked({
      'cue:privacy-agreed:v1': '1',
      'cue:mode:v1': 'date',
    })
    expect(fake.lastRender()).toMatch(/DATE/)
    fake.invokeDoubleTap('glasses')
    await new Promise(r => setTimeout(r, 20))
    // Date is the first mode; cycling should land on Argue calm next.
    expect(fake.lastRender()).toMatch(/ARGUE CALM/)
  })

  it('foreground re-paints (covers the FOREGROUND_ENTER path)', async () => {
    await bootMocked({ 'cue:privacy-agreed:v1': '1' })
    const before = fake.lastRender()
    fake.invokeForeground()
    await new Promise(r => setTimeout(r, 20))
    // It re-renders the same content — render is idempotent on identical
    // text, but the handler should fire without throwing.
    expect(fake.lastRender()).toBe(before)
  })
})
