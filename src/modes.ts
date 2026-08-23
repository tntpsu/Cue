// Cue mode registry. Each mode bundles a system prompt that shapes the LLM's
// suggestions, plus per-mode behavior flags (reactive vs proactive).
//
// Modes are exposed both on glasses (cycle via tap) and on the phone
// settings page (radio buttons). User can also write a fully custom prompt
// via the "custom" mode.

export type ModeId = 'date' | 'argue-calm' | 'sales-close' | 'sting' | 'listen' | 'interview' | 'custom'

export interface Mode {
  id: ModeId
  label: string // user-facing display name
  /** Single-char indicator drawn on the glasses.
   *
   *  MUST be a glyph the firmware font actually has. Measure with
   *  `getTextWidth` from `@evenrealities/pretext`: supported symbols return
   *  20, and anything returning 4 is the missing-glyph fallback and will draw
   *  as a box. Verified safe: ★ ◇ ▶ ● ◆ ▣ ■ ◈ ▲ ◌ ◎ ○.
   *  Verified BROKEN: ⚡ ◉ ◍ ✦ ♦. Checked by tests/glyphs.test.ts. */
  glyph: string
  description: string // shown in phone settings
  systemPrompt: string // sent to the LLM
  proactiveSupported: boolean // if true, ring-tap on silence asks for fresh topics
}

// Single pivot point — change here, propagate everywhere. Order matters:
// it's the cycle order on glasses (tap goes left → right, wraps).
export const MODES: Mode[] = [
  {
    id: 'date',
    label: 'Date',
    glyph: '★',
    description:
      'Curious, warm responses. Suggests questions and follow-ups; when conversation stalls, ring-tap for fresh topics.',
    systemPrompt:
      'You are a warm, curious conversation coach helping the wearer have a great date. Based on the recent conversation transcript, suggest 2-3 natural responses or questions the wearer could say next. Keep each suggestion under 12 words. Avoid pickup-artist tropes; aim for genuine interest. Format as a numbered list, one suggestion per line, no preamble.',
    proactiveSupported: true,
  },
  {
    id: 'argue-calm',
    label: 'Argue calm',
    glyph: '◇',
    description:
      'Validating, deescalating responses for tense conversations. Detects "always/never" framing.',
    systemPrompt:
      'You are a couples therapist helping the wearer respond calmly during a tense conversation. Based on the transcript, suggest 2-3 short responses that validate the other person\'s feelings without conceding factual ground. Avoid "but", "you should", or any phrasing that escalates. Each suggestion under 12 words. Numbered list, no preamble.',
    proactiveSupported: false,
  },
  {
    id: 'sales-close',
    label: 'Sales close',
    glyph: '▶',
    description:
      'Listens for objections and suggests handlers. Tracks topics already covered to avoid loops.',
    systemPrompt:
      'You are an experienced sales coach. Based on the recent conversation, identify any objection the prospect just raised and suggest 2-3 short responses that acknowledge it without dismissing. If no objection was raised, suggest a single forward-moving question. Each under 14 words. Numbered list, no preamble.',
    proactiveSupported: false,
  },
  {
    id: 'sting',
    label: 'Sting',
    // ▲ not ⚡: getTextWidth('⚡') is 4, the firmware font's "glyph missing"
    // fallback width, so it rendered as a box on real glasses. See the
    // verified-safe list in this file's header comment.
    glyph: '▲',
    description: 'Sharp, witty comebacks. For low-stakes banter.',
    systemPrompt:
      'You are a quick-witted friend helping the wearer with banter. Suggest 2-3 sharp but friendly comebacks based on what was just said. Under 12 words each. No mean-spirited or genuinely hurtful options. Numbered list, no preamble.',
    proactiveSupported: false,
  },
  {
    id: 'listen',
    label: 'Listen well',
    glyph: '●',
    description:
      'Reflective listening prompts ("what I hear is...", "tell me more"). For when you need to slow down.',
    systemPrompt:
      'You are coaching the wearer in reflective listening. Based on the transcript, suggest 2-3 short prompts that mirror what the other person said and invite them to elaborate. Use phrasings like "what I hear is...", "tell me more about...", "it sounds like...". Under 14 words each. Numbered list, no preamble.',
    proactiveSupported: false,
  },
  {
    id: 'interview',
    label: 'Interview',
    glyph: '▣',
    description:
      'Crisp, structured answers for being interviewed. Uses STAR-shaped framing, leads with the headline.',
    systemPrompt:
      'You are coaching the wearer through being interviewed. Based on the interviewer\'s most recent question or statement, suggest 2-3 short, structured answers (under 20 words each). Lead with the headline; use Situation-Task-Action-Result framing only when it fits naturally. Avoid hedging language ("I think", "maybe"). Numbered list, no preamble.',
    proactiveSupported: false,
  },
  {
    id: 'custom',
    label: 'Custom',
    glyph: '◆',
    description:
      'Use your own system prompt (set in phone settings). Power-user escape hatch — write the coach you want.',
    systemPrompt: '', // user-supplied; falls back to a generic "be helpful" if empty
    proactiveSupported: true,
  },
]

export function modeById(id: ModeId): Mode {
  const m = MODES.find(x => x.id === id)
  if (!m) throw new Error(`unknown mode: ${id}`)
  return m
}

// Cycle helper for tap-to-switch on glasses.
export function nextMode(current: ModeId): ModeId {
  const idx = MODES.findIndex(m => m.id === current)
  const next = (idx + 1) % MODES.length
  return MODES[next]!.id
}

export const DEFAULT_MODE: ModeId = 'date'
