// Storage layer. Wraps the SDK's native bridge.setLocalStorage with
// browser-localStorage fallback for the dev preview. Same pattern as Glance.

import type { ModeId } from './modes'

interface BridgeStorageLike {
  getStorage: (key: string) => Promise<string>
  setStorage: (key: string, value: string) => Promise<boolean>
}

let bridge: BridgeStorageLike | null = null

export function setStorageBridge(b: BridgeStorageLike | null): void {
  bridge = b
}

async function readRaw(key: string): Promise<string | null> {
  try {
    if (bridge) {
      const v = await bridge.getStorage(key)
      return v || null
    }
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

async function writeRaw(key: string, value: string): Promise<void> {
  try {
    if (bridge) {
      await bridge.setStorage(key, value)
      return
    }
    window.localStorage.setItem(key, value)
  } catch {
    /* swallow — settings will degrade to in-memory for the session */
  }
}

const KEY_AGREED = 'cue:privacy-agreed:v1'
const KEY_MODE = 'cue:mode:v1'
const KEY_CUSTOM_PROMPT = 'cue:custom-prompt:v1'
const KEY_WORKER_URL = 'cue:worker-url:v1'
const KEY_WORKER_TOKEN = 'cue:worker-token:v1'
const KEY_IDLE_AUTO_PAUSE_MIN = 'cue:idle-auto-pause-min:v1'
// v0.4.0: show the diagnostic stats line on glasses (audio frames /
// chunks / errors). Default OFF — only meant for active debugging.
const KEY_SHOW_DEBUG_OVERLAY = 'cue:show-debug-overlay:v1'
// v0.4.0: which Deepgram-assigned speaker is the wearer. -1 = none /
// auto-detect (don't filter from suggestion context). 0/1/... = anchor
// that speaker as wearer; suggestions exclude their lines.
const KEY_WEARER_SPEAKER_ID = 'cue:wearer-speaker-id:v1'
// v0.5.0: bring-your-own keys for the direct-to-provider path. Stored in the
// same per-app bridge storage as the Worker secret: on the phone, nowhere else.
const KEY_DEEPGRAM_KEY = 'cue:deepgram-key:v1'
const KEY_LLM_PROVIDER = 'cue:llm-provider:v1'
const KEY_LLM_KEY = 'cue:llm-key:v1'

export const DEFAULT_IDLE_AUTO_PAUSE_MIN = 5
export const DEFAULT_WEARER_SPEAKER_ID = -1

export async function hasAgreedToPrivacy(): Promise<boolean> {
  const raw = await readRaw(KEY_AGREED)
  return raw === '1'
}

export async function setPrivacyAgreed(): Promise<void> {
  await writeRaw(KEY_AGREED, '1')
}

export async function getMode(): Promise<ModeId | null> {
  const raw = await readRaw(KEY_MODE)
  return (raw as ModeId) || null
}

export async function setMode(mode: ModeId): Promise<void> {
  await writeRaw(KEY_MODE, mode)
}

export async function getCustomPrompt(): Promise<string> {
  return (await readRaw(KEY_CUSTOM_PROMPT)) ?? ''
}

export async function setCustomPrompt(prompt: string): Promise<void> {
  await writeRaw(KEY_CUSTOM_PROMPT, prompt)
}

export async function getWorkerUrl(): Promise<string> {
  return (await readRaw(KEY_WORKER_URL)) ?? ''
}

export async function setWorkerUrl(url: string): Promise<void> {
  await writeRaw(KEY_WORKER_URL, url.trim())
}

export async function getWorkerToken(): Promise<string> {
  return (await readRaw(KEY_WORKER_TOKEN)) ?? ''
}

export async function setWorkerToken(token: string): Promise<void> {
  await writeRaw(KEY_WORKER_TOKEN, token.trim())
}

// Idle auto-pause threshold in minutes. Stored as a small int string. 0 = disable.
// Negative or non-numeric input falls back to the default — defensive because the
// phone-side textbox can't be locked down from accepting garbage input.
export async function getIdleAutoPauseMin(): Promise<number> {
  const raw = await readRaw(KEY_IDLE_AUTO_PAUSE_MIN)
  if (raw === null) return DEFAULT_IDLE_AUTO_PAUSE_MIN
  const n = Number.parseInt(raw, 10)
  if (!Number.isFinite(n) || n < 0) return DEFAULT_IDLE_AUTO_PAUSE_MIN
  return n
}

export async function setIdleAutoPauseMin(min: number): Promise<void> {
  const n = Math.max(0, Math.floor(min))
  await writeRaw(KEY_IDLE_AUTO_PAUSE_MIN, String(n))
}

export async function getShowDebugOverlay(): Promise<boolean> {
  return (await readRaw(KEY_SHOW_DEBUG_OVERLAY)) === '1'
}

export async function setShowDebugOverlay(on: boolean): Promise<void> {
  await writeRaw(KEY_SHOW_DEBUG_OVERLAY, on ? '1' : '0')
}

// Wearer speaker id: -1 = none / auto-detect (no filter), 0+ = anchor.
export async function getWearerSpeakerId(): Promise<number> {
  const raw = await readRaw(KEY_WEARER_SPEAKER_ID)
  if (raw === null) return DEFAULT_WEARER_SPEAKER_ID
  const n = Number.parseInt(raw, 10)
  if (!Number.isFinite(n)) return DEFAULT_WEARER_SPEAKER_ID
  return n
}

export async function setWearerSpeakerId(id: number): Promise<void> {
  await writeRaw(KEY_WEARER_SPEAKER_ID, String(Math.floor(id)))
}

// v0.4.2: one-shot flag set by phone-side "Calibrate me" button. Plugin
// reads + clears on the next non-empty utterance, anchoring that
// speaker as the wearer. Replaces the manual "Speaker A is me" dropdown
// for users who'd rather just press a button + say their name.
const KEY_CALIBRATING = 'cue:calibrating:v1'
export async function getCalibrating(): Promise<boolean> {
  return (await readRaw(KEY_CALIBRATING)) === '1'
}
export async function setCalibrating(on: boolean): Promise<void> {
  await writeRaw(KEY_CALIBRATING, on ? '1' : '0')
}

// v0.4.3: per-session transcript persistence. Cue saves each mic session
// as a record so the user can review past conversations on phone-side
// settings. Capped at SESSION_HISTORY_CAP entries (newest first); older
// roll off. NOT a transcript of every chunk — just one record per
// mic-on / mic-off pair with the assembled transcript + suggestions.
const KEY_SESSION_HISTORY = 'cue:session-history:v1'
export const SESSION_HISTORY_CAP = 50

export interface SessionRecord {
  startedAt: number      // Date.now() at mic-on
  endedAt: number        // Date.now() at mic-off
  mode: string           // ModeId at session start
  transcript: string     // accumulated other-speakers' transcript (no wearer)
  suggestionCount: number  // total /suggest calls made
}

export async function loadSessionHistory(): Promise<SessionRecord[]> {
  const raw = await readRaw(KEY_SESSION_HISTORY)
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as SessionRecord[]
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export async function appendSessionRecord(rec: SessionRecord): Promise<void> {
  const list = await loadSessionHistory()
  list.unshift(rec)
  while (list.length > SESSION_HISTORY_CAP) list.pop()
  await writeRaw(KEY_SESSION_HISTORY, JSON.stringify(list))
}

export async function clearSessionHistory(): Promise<void> {
  await writeRaw(KEY_SESSION_HISTORY, JSON.stringify([]))
}

export type StoredLlmProvider = 'anthropic' | 'openai'
export const DEFAULT_LLM_PROVIDER: StoredLlmProvider = 'anthropic'

export interface StoredDirectKeys {
  deepgramKey: string
  llmProvider: StoredLlmProvider
  llmKey: string
}

export async function getDirectKeys(): Promise<StoredDirectKeys> {
  const provider = await readRaw(KEY_LLM_PROVIDER)
  return {
    deepgramKey: (await readRaw(KEY_DEEPGRAM_KEY)) ?? '',
    llmProvider: provider === 'openai' ? 'openai' : DEFAULT_LLM_PROVIDER,
    llmKey: (await readRaw(KEY_LLM_KEY)) ?? '',
  }
}

export async function setDirectKeys(keys: StoredDirectKeys): Promise<void> {
  await writeRaw(KEY_DEEPGRAM_KEY, keys.deepgramKey.trim())
  await writeRaw(KEY_LLM_PROVIDER, keys.llmProvider)
  await writeRaw(KEY_LLM_KEY, keys.llmKey.trim())
}
