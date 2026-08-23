// Pure helpers for end-of-utterance detection, transcript trimming, and
// glasses line wrapping. No side effects, no SDK imports — kept here so
// the wiring in main.ts stays small and the heuristics are unit-testable
// in isolation.

// --- end-of-utterance detection ---

// Sentence-final punctuation, including common Unicode punctuation that
// Deepgram emits (it normalizes some, but not all, depending on language).
const SENTENCE_FINAL_RE = /[.!?…。！？]\s*$/

export function endsOnSentenceFinalPunct(text: string): boolean {
  return SENTENCE_FINAL_RE.test(text.trim())
}

export interface UtteranceSignal {
  // Last non-empty transcript chunk's text — used to detect sentence-final.
  lastChunkText: string
  // Wall-clock time (ms) of the last non-empty chunk arriving.
  lastChunkAt: number
  // Wall-clock time (ms) of the most recent suggestion request fire.
  lastSuggestionAt: number
  // Whether a /suggest call is currently in flight — never fire while one is.
  inFlight: boolean
  // Total chars in the live transcript window — too short = skip.
  transcriptLen: number
}

export interface UtteranceTriggerConfig {
  /** Don't fire a /suggest call closer than this to the previous one (ms). */
  minDebounceMs: number
  /** Maximum we'll wait for "natural" pause; fire anyway after this (ms). */
  maxWaitMs: number
  /** Silence between final chunks long enough to count as end-of-utterance (ms). */
  silenceGapMs: number
  /** Skip if the rolling transcript is shorter than this (chars). */
  minTranscriptChars: number
}

export const DEFAULT_TRIGGER: UtteranceTriggerConfig = {
  minDebounceMs: 3_000,
  maxWaitMs: 12_000,
  silenceGapMs: 1_500,
  minTranscriptChars: 16,
}

/**
 * Decide whether to fire a /suggest call right now. Replaces the old
 * fixed-6s debounce. Returns true on:
 *   - sentence-final punctuation in the latest chunk (after minDebounce), or
 *   - silence gap exceeded (no new chunk for `silenceGapMs`), or
 *   - max-wait exceeded since last suggestion.
 *
 * Always blocked by: `inFlight`, transcript too short, or below minDebounce.
 */
export function shouldRequestSuggestion(
  state: UtteranceSignal,
  now: number,
  cfg: UtteranceTriggerConfig = DEFAULT_TRIGGER,
): boolean {
  if (state.inFlight) return false
  if (state.transcriptLen < cfg.minTranscriptChars) return false
  const sinceLastSuggestion = now - state.lastSuggestionAt
  if (sinceLastSuggestion < cfg.minDebounceMs) return false
  if (sinceLastSuggestion >= cfg.maxWaitMs) return true
  if (endsOnSentenceFinalPunct(state.lastChunkText)) return true
  const sinceLastChunk = now - state.lastChunkAt
  if (sinceLastChunk >= cfg.silenceGapMs) return true
  return false
}

// --- transcript trimming (sentence-aware) ---

// Split on sentence boundaries while preserving the punctuation. We split
// AFTER terminal punctuation followed by whitespace, so "A. B!" → ["A.", "B!"].
const SENTENCE_SPLIT_RE = /(?<=[.!?…。！？])\s+/

/**
 * Trim a rolling transcript to fit within a soft char budget while
 * respecting sentence boundaries. Drops whole leading sentences until
 * the result fits; if a single sentence is longer than the budget, the
 * tail of that sentence is returned (graceful degrade — better to
 * truncate mid-sentence than emit nothing).
 */
export function trimToSentences(text: string, maxChars: number): string {
  const trimmed = text.trim()
  if (trimmed.length <= maxChars) return trimmed
  const sentences = trimmed.split(SENTENCE_SPLIT_RE)
  // Drop from the front until we fit.
  let candidate = sentences.join(' ')
  while (sentences.length > 1 && candidate.length > maxChars) {
    sentences.shift()
    candidate = sentences.join(' ')
  }
  if (candidate.length <= maxChars) return candidate
  // Single sentence still too long — fall back to char-tail.
  return candidate.slice(-maxChars)
}

// --- glasses line wrapping (word-boundary, multi-line) ---

/**
 * Wrap a single suggestion line to multiple lines on word boundaries.
 * `width` is the max characters per line; `maxLines` caps the total
 * lines emitted (extra is collapsed with an ellipsis on the last line).
 * Returns each output line as a separate string in the array.
 */
export function wrapWords(text: string, width: number, maxLines: number): string[] {
  if (width <= 0 || maxLines <= 0) return []
  const out: string[] = []
  const words = text.trim().split(/\s+/)
  let line = ''
  for (const word of words) {
    if (line.length === 0) {
      // First word on line — break a too-long word at width.
      if (word.length > width) {
        line = word.slice(0, width)
        if (out.length === maxLines - 1) {
          out.push(`${line.slice(0, Math.max(0, width - 1))}…`)
          return out
        }
        out.push(line)
        line = word.slice(width)
        continue
      }
      line = word
      continue
    }
    if (line.length + 1 + word.length <= width) {
      line = `${line} ${word}`
    } else {
      if (out.length === maxLines - 1) {
        // Last allowed line — squeeze what's left in with an ellipsis.
        const remaining = words.slice(words.indexOf(word)).join(' ')
        const room = Math.max(0, width - line.length - 2) // ' …' or ' ...'
        if (remaining.length <= room) {
          line = `${line} ${remaining}`
        } else {
          line = `${line} …`
        }
        out.push(line)
        return out
      }
      out.push(line)
      line = word
    }
  }
  if (line.length > 0) out.push(line)
  return out
}

// --- conversation accumulation (v0.4.0) ---
//
// Per-speaker rolling buffer for transcript display. Same-speaker turns
// merge so words stream in until the speaker actually changes (fixes
// the v0.3 bug where each 2.5s chunk overwrote the previous one).
// Old turns age out of the window so the buffer doesn't grow unbounded.

export interface ConversationTurn {
  speaker: number
  text: string
  ts: number
}

export interface ConversationConfig {
  /** How long a turn stays in the buffer (ms). */
  scrollbackMs: number
  /** Hard cap on buffer length so a non-stop speaker can't grow it. */
  hardCap: number
}

export const DEFAULT_CONVERSATION: ConversationConfig = {
  scrollbackMs: 30_000,
  hardCap: 8,
}

/**
 * Append a new utterance to the buffer, merging into the last turn if
 * it's the same speaker. Returns the (mutated) buffer for chaining.
 */
export function appendTurn(
  buffer: ConversationTurn[],
  speaker: number,
  text: string,
  now: number,
  cfg: ConversationConfig = DEFAULT_CONVERSATION,
): ConversationTurn[] {
  if (text.trim().length === 0) return buffer
  const last = buffer[buffer.length - 1]
  if (last && last.speaker === speaker) {
    last.text = `${last.text} ${text}`.trim()
    last.ts = now
  } else {
    buffer.push({ speaker, text: text.trim(), ts: now })
  }
  return pruneTurns(buffer, now, cfg)
}

export function pruneTurns(
  buffer: ConversationTurn[],
  now: number,
  cfg: ConversationConfig = DEFAULT_CONVERSATION,
): ConversationTurn[] {
  const cutoff = now - cfg.scrollbackMs
  while (buffer.length > 0 && buffer[0]!.ts < cutoff) buffer.shift()
  while (buffer.length > cfg.hardCap) buffer.shift()
  return buffer
}

/** 0 → "A", 1 → "B", ..., 25 → "Z". Clamps out-of-range. */
export function speakerLabel(id: number): string {
  return String.fromCharCode(65 + Math.max(0, Math.min(25, id)))
}

// --- battery glyph for header ---

/**
 * Render a battery glyph + percent suffix for the glasses header.
 *
 * Both glyphs are MEASURED safe, not assumed: getTextWidth returns 20 for a
 * glyph the firmware font has and 4 for the missing-glyph fallback. This
 * previously used ◼ (U+25FC), which measures 4 — so the battery indicator drew
 * as a box for any charge above 20%, i.e. almost always. ■ (U+25A0) is the
 * filled square the font actually has. Guarded by tests/glyphs.test.ts.
 */
export function batteryHeaderSuffix(level: number | undefined): string {
  if (typeof level !== 'number' || !Number.isFinite(level)) return ''
  const pct = Math.max(0, Math.min(100, Math.round(level)))
  // Solid block when above 20%, hollow ring under 20% as a visual warning.
  const glyph = pct < 20 ? '○' : '■'
  return `${glyph}${pct}%`
}
