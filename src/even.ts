// Glasses bridge wrapper for Cue. Single full-screen text container —
// transcript area on top, suggestions below, mode + mic indicator at the
// header. Mirrors the Glance pattern (BLE-write serialization, structured
// state logs for the regression harness).

import {
  AudioInputSource,
  CreateStartUpPageContainer,
  EventSourceType,
  MenuContainerProperty,
  MenuItemProperty,
  OsEventTypeList,
  TextContainerProperty,
  TextContainerUpgrade,
  isMenuNameWithinLimit,
  isValidMenuItemID,
  waitForEvenAppBridge,
} from '@evenrealities/even_hub_sdk'
import {
  type AudioFrameStats,
  type DirectionStats,
  directionKeyOf,
  emptyAudioStats,
  shouldDeliver,
  speakerRoleOf,
  tallyDirection,
  tallyFrame,
} from './audio-role'
import type { MenuSpec } from './menu'

// Audio frame from the SDK's mic capture. Per the SDK README, audio comes
// as PCM bytes — assumed 16kHz mono 16-bit little-endian (industry-standard
// BLE voice format). Verify on real glasses; if it differs, adjust the
// Deepgram URL in worker-template/index.ts.
export type AudioFrame = Uint8Array

const MAIN_ID = 1
const MAIN_NAME = 'main'
const BRIDGE_TIMEOUT_MS = 4000
const WIDTH = 576
const HEIGHT = 288

export type InputSource = 'glasses' | 'ring' | 'unknown'
export type SwipeDir = 'up' | 'down'
export type MicSource = 'glasses' | 'phone'

export interface MicOptions {
  // Drop frames the Even app tagged as the wearer before they reach STT.
  dropSelf?: boolean
}

export interface EvenRuntime {
  render: (text: string) => Promise<void>
  onTap: (handler: (source: InputSource) => void) => void
  onSwipe: (handler: (dir: SwipeDir, source: InputSource) => void) => void
  onDoubleTap: (handler: (source: InputSource) => void) => void
  onForeground: (handler: () => void) => void
  // Contextual menu (tap-and-hold) selection, by the MenuSpec id passed to
  // connectEvenRuntime.
  onMenuSelect: (handler: (itemID: number) => void) => void
  // Mic capture. Calling startMic emits PCM frames to the registered handler
  // until stopMic. Caller is responsible for routing frames to STT.
  startMic: (handler: (frame: AudioFrame) => void, opts?: MicOptions) => Promise<boolean>
  stopMic: () => Promise<void>
  // Which mic the last startMic opened, null until one succeeds.
  getMicSource: () => MicSource | null
  // Per-session frame tally by speaker role, reset on every startMic.
  getAudioStats: () => AudioFrameStats
  // Per-session raw direction tag × role tally, reset on every startMic.
  getDirectionStats: () => DirectionStats
  exitApp: () => Promise<void>
  getStorage: (key: string) => Promise<string>
  setStorage: (key: string, value: string) => Promise<boolean>
  // Battery level 0-100, or undefined if the device hasn't reported it yet.
  // Cheap to call repeatedly — uses the latest cached push value when
  // available, falls back to a synchronous getDeviceInfo poll otherwise.
  getBatteryLevel: () => Promise<number | undefined>
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(
      () => reject(new Error('Timed out waiting for the Even bridge')),
      timeoutMs,
    )
    promise.then(
      v => { window.clearTimeout(timer); resolve(v) },
      e => { window.clearTimeout(timer); reject(e) },
    )
  })
}

export async function connectEvenRuntime(
  initial: string,
  menu: readonly MenuSpec[] = [],
): Promise<EvenRuntime | null> {
  let bridge: Awaited<ReturnType<typeof waitForEvenAppBridge>>
  try {
    bridge = await withTimeout(waitForEvenAppBridge(), BRIDGE_TIMEOUT_MS)
  } catch {
    return null
  }

  // A malformed menu makes the firmware reject the whole page, so entries
  // are filtered through the SDK's own predicates before they are sent.
  const seen = new Set<number>()
  const menuItems = menu.filter(m => {
    const ok = isValidMenuItemID(m.id) && isMenuNameWithinLimit(m.label) && !seen.has(m.id)
    seen.add(m.id)
    return ok
  })
  const menuObject = menuItems.length > 0
    ? new MenuContainerProperty({
      menuItems: menuItems.map(m => new MenuItemProperty({ itemName: m.label, itemID: m.id })),
    })
    : undefined

  const main = new TextContainerProperty({
    xPosition: 0,
    yPosition: 0,
    width: WIDTH,
    height: HEIGHT,
    borderWidth: 0,
    borderColor: 5,
    paddingLength: 6,
    containerID: MAIN_ID,
    containerName: MAIN_NAME,
    content: initial,
    isEventCapture: 1,
  })

  const created = await bridge.createStartUpPageContainer(
    new CreateStartUpPageContainer({ containerTotalNum: 1, textObject: [main], menuObject }),
  )
  if (created !== 0) return null

  let lastSent = initial
  let lastLen = initial.length

  let busy: Promise<unknown> = Promise.resolve()
  function enqueue<T>(work: () => Promise<T>): Promise<T> {
    const next = busy.then(work, work) as Promise<T>
    busy = next.then(() => undefined, () => undefined)
    return next
  }

  let tapHandler: ((source: InputSource) => void) | null = null
  let swipeHandler: ((dir: SwipeDir, source: InputSource) => void) | null = null
  let doubleTapHandler: ((source: InputSource) => void) | null = null
  let foregroundHandler: (() => void) | null = null
  let menuHandler: ((itemID: number) => void) | null = null
  let audioHandler: ((frame: AudioFrame) => void) | null = null
  let dropSelf = false
  let micSource: MicSource | null = null
  let audioStats = emptyAudioStats()
  let directionStats: DirectionStats = new Map()
  // Latest battery push from onDeviceStatusChanged. Push beats poll for
  // freshness and avoids hitting BLE on every tick.
  let cachedBattery: number | undefined
  try {
    const maybeOn = (bridge as unknown as {
      onDeviceStatusChanged?: (cb: (s: { batteryLevel?: number }) => void) => () => void
    }).onDeviceStatusChanged
    if (typeof maybeOn === 'function') {
      maybeOn(s => {
        if (typeof s.batteryLevel === 'number') cachedBattery = s.batteryLevel
      })
    }
  } catch { /* push not supported on this SDK build — fall back to poll */ }

  function classifySource(src: number | undefined): InputSource {
    if (src === EventSourceType.TOUCH_EVENT_FROM_RING) return 'ring'
    if (
      src === EventSourceType.TOUCH_EVENT_FROM_GLASSES_L ||
      src === EventSourceType.TOUCH_EVENT_FROM_GLASSES_R
    ) {
      return 'glasses'
    }
    return 'unknown'
  }

  bridge.onEvenHubEvent(event => {
    // Audio frames are pushed via the same onEvenHubEvent channel as
    // `audioEvent.audioPcm: Uint8Array`, tagged with the Even app's
    // speaker-role guess. Raw bytes go to the registered handler; the
    // transport layer shapes them into Deepgram's expected encoding.
    const audioEvent = (event as {
      audioEvent?: { audioPcm?: Uint8Array; speakerRole?: unknown; direction?: unknown }
    }).audioEvent
    if (audioEvent?.audioPcm) {
      const role = speakerRoleOf(audioEvent.speakerRole)
      const deliver = shouldDeliver(role, dropSelf)
      tallyFrame(audioStats, role, deliver)
      tallyDirection(directionStats, directionKeyOf(audioEvent.direction), role)
      if (deliver && audioHandler) audioHandler(audioEvent.audioPcm)
      return
    }
    const menuClick = (event as { menuItemClickEvent?: { itemID?: unknown } }).menuItemClickEvent
    if (menuClick) {
      if (typeof menuClick.itemID === 'number') menuHandler?.(menuClick.itemID)
      return
    }
    if (event.textEvent) {
      const t = event.textEvent.eventType ?? 0
      if (t === OsEventTypeList.SCROLL_TOP_EVENT) swipeHandler?.('up', 'unknown')
      else if (t === OsEventTypeList.SCROLL_BOTTOM_EVENT) swipeHandler?.('down', 'unknown')
      return
    }
    if (event.sysEvent) {
      const t = event.sysEvent.eventType ?? 0
      const src = classifySource(event.sysEvent.eventSource)
      if (t === 0) { tapHandler?.(src); return }
      if (t === OsEventTypeList.DOUBLE_CLICK_EVENT) { doubleTapHandler?.(src); return }
      if (t === OsEventTypeList.FOREGROUND_ENTER_EVENT) { foregroundHandler?.(); return }
    }
  })

  return {
    async render(text: string): Promise<void> {
      if (text === lastSent) return
      await enqueue(async () => {
        await bridge.textContainerUpgrade(
          new TextContainerUpgrade({
            containerID: MAIN_ID,
            containerName: MAIN_NAME,
            contentOffset: 0,
            contentLength: Math.max(lastLen, text.length),
            content: text,
          }),
        )
        lastSent = text
        lastLen = text.length
      })
    },
    onTap(h) { tapHandler = h },
    onSwipe(h) { swipeHandler = h },
    onDoubleTap(h) { doubleTapHandler = h },
    onForeground(h) { foregroundHandler = h },
    onMenuSelect(h) { menuHandler = h },
    async startMic(handler, opts) {
      audioHandler = handler
      dropSelf = opts?.dropSelf ?? false
      audioStats = emptyAudioStats()
      directionStats = new Map()
      micSource = null
      // The glasses mic is the default. A false return there (glasses not
      // connected) falls back to the phone mic, which has no speaker tags.
      try {
        if (await bridge.audioControl(true, AudioInputSource.Glasses)) {
          micSource = 'glasses'
          return true
        }
      } catch { /* try the phone mic below */ }
      try {
        if (await bridge.audioControl(true, AudioInputSource.Phone)) {
          micSource = 'phone'
          return true
        }
      } catch { /* both refused */ }
      audioHandler = null
      return false
    },
    async stopMic() {
      audioHandler = null
      micSource = null
      try { await bridge.audioControl(false) } catch { /* ignore */ }
    },
    getMicSource() { return micSource },
    getAudioStats() { return { ...audioStats } },
    getDirectionStats() { return directionStats },
    async exitApp(): Promise<void> { await bridge.shutDownPageContainer(1) },
    async getStorage(key) {
      try { return await bridge.getLocalStorage(key) } catch { return '' }
    },
    async setStorage(key, value) {
      try { return await bridge.setLocalStorage(key, value) } catch { return false }
    },
    async getBatteryLevel() {
      if (typeof cachedBattery === 'number') return cachedBattery
      try {
        const info = (await bridge.getDeviceInfo()) as { batteryLevel?: number } | null
        const lvl = info?.batteryLevel
        if (typeof lvl === 'number') cachedBattery = lvl
        return lvl
      } catch {
        return undefined
      }
    },
  }
}
