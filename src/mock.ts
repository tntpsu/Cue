// Mock suggestion driver — generates fake transcript snippets and per-mode
// suggestions on a timer. Lets v0.1.0 ship a usable demo without requiring
// the user to deploy a Worker, supply API keys, or actually record audio.
//
// Real audio + STT + LLM pipeline lands in v0.2.0/v0.3.0 (see ROADMAP).

import type { ModeId } from './modes'

interface MockEntry {
  transcript: string // what "she" supposedly just said
  suggestionsByMode: Partial<Record<ModeId, string[]>>
}

// A small ring of plausible exchanges. Cycle on each tick. Designed to be
// mode-agnostic on the transcript side; the suggestions vary per mode. A
// mode that has its own lines on some entries (trivia, custom) cycles only
// those, so its demo never shows another mode's advice.
const SCRIPT: MockEntry[] = [
  {
    transcript: 'I started painting again last weekend after years off.',
    suggestionsByMode: {
      date: [
        'What pulled you back to it?',
        'Watercolor or oils these days?',
        'Where do you paint — a studio?',
      ],
      'argue-calm': [
        'I love that you found it again.',
        'That sounds like it meant a lot.',
      ],
      'sales-close': [
        'Has anything been getting in the way of more time on it?',
      ],
      sting: [
        'Welcome back to the canvas trenches.',
        'Bob Ross is shaking with pride.',
      ],
      listen: [
        'It sounds like you missed it.',
        'Tell me more about coming back to it.',
      ],
    },
  },
  {
    transcript: "I don't know, work has been really overwhelming lately.",
    suggestionsByMode: {
      date: [
        "What's been the toughest part?",
        'Have you had any chance to unwind?',
        'Is it project-driven or constant?',
      ],
      'argue-calm': [
        "That sounds heavy. What's weighing the most?",
        'I hear you. I want to help where I can.',
      ],
      'sales-close': [
        "I've worked with teams in similar spots — what tools are you using now?",
      ],
      sting: [
        'Have you tried turning the job off and on again?',
      ],
      listen: [
        "It sounds like work has been a lot lately.",
        'Tell me more about what overwhelming looks like.',
      ],
    },
  },
  {
    transcript: 'I think I want to take a sabbatical and travel for a few months.',
    suggestionsByMode: {
      date: [
        'Where would you go first?',
        'Have you been planning this for a while?',
        'What got you thinking about it now?',
      ],
      'argue-calm': [
        "That's a big step — what's drawing you to it?",
        'I want to understand what you need from this.',
      ],
      'sales-close': [
        "What would make this the right time vs. waiting?",
      ],
      sting: [
        'Bold move. Try not to come back with a tattoo of yourself.',
      ],
      listen: [
        'It sounds like you really need a break.',
        'Tell me more about what you imagine doing.',
      ],
    },
  },
  {
    transcript: "I can't believe it's already been six months.",
    suggestionsByMode: {
      date: [
        'What stands out most from these past months?',
        'Time flies when… well, when does it not?',
        "Where do you see things going from here?",
      ],
      'argue-calm': [
        'A lot has happened. How are you feeling about it?',
        "I've been thinking about that too.",
      ],
      'sales-close': [
        "Looking back at six months — what's worked, what hasn't?",
      ],
      sting: [
        'Time really doesn\'t care, does it.',
      ],
      listen: [
        'It sounds like a lot has happened in those months.',
        'Tell me more about what you mean by that.',
      ],
      // Custom mode demo — without this entry custom falls back to date-mode
      // suggestions, which is correct fallback but unhelpful for previewing
      // what custom-prompt output looks like at glance time.
      custom: [
        'Use your phone-side custom prompt to shape what shows here.',
      ],
    },
  },
  {
    // Longer suggestions deliberately exercise the v0.3.0 word-wrap path
    // (LINE_WIDTH = 38). Without an entry like this in mock mode, the wrap
    // helper only gets exercised in unit tests and never visually validated
    // during dev preview.
    transcript: 'I think the meeting tomorrow is the right time to bring it up.',
    suggestionsByMode: {
      date: [
        'What outcome would feel like a win for you?',
      ],
      'argue-calm': [
        'I want to support you — what would help most going in?',
        'It sounds like this has been on your mind for a while.',
      ],
      'sales-close': [
        'What objection do you expect, and how would you handle it?',
        'Could we do a quick dry-run together this evening?',
      ],
      sting: [
        'Bring snacks. Confidence loves a good blood-sugar baseline.',
      ],
      listen: [
        'What I hear is that tomorrow feels like the right window.',
        'Tell me more about why now feels different.',
      ],
      custom: [
        'Custom-mode suggestions follow your phone-side prompt verbatim.',
      ],
    },
  },
  {
    transcript: 'Question seven. Which planet in our solar system has the most known moons?',
    suggestionsByMode: {
      trivia: ['Saturn', 'Runner-up: Jupiter'],
    },
  },
  {
    transcript: 'Next one, for ten points. In what year did the Berlin Wall fall?',
    suggestionsByMode: {
      trivia: ['1989', 'November 9th, 1989'],
    },
  },
]

const PROACTIVE_TOPICS_BY_MODE: Partial<Record<ModeId, string[][]>> = {
  date: [
    [
      'Ask: a movie that surprised you lately?',
      'Ask: any travel coming up?',
      'Ask: what does your perfect Sunday look like?',
    ],
    [
      'Ask: best meal you\'ve had this year?',
      'Ask: ever picked up a weird hobby?',
      'Ask: childhood obsession that stuck around?',
    ],
  ],
  custom: [
    [
      'Ask the other person an open-ended question.',
      'Share a small detail from your day.',
    ],
  ],
}

let scriptIdx = 0
let proactiveIdx = 0

export function nextMockExchange(mode: ModeId): { transcript: string; suggestions: string[] } {
  const own = SCRIPT.filter(e => e.suggestionsByMode[mode])
  const pool = own.length > 0 ? own : SCRIPT
  const entry = pool[scriptIdx % pool.length]!
  scriptIdx += 1
  const suggestions =
    entry.suggestionsByMode[mode] ??
    entry.suggestionsByMode.date ?? // fall back to date-mode suggestions
    ['(no suggestions configured for this mode)']
  return { transcript: entry.transcript, suggestions }
}

export function nextMockProactiveTopics(mode: ModeId): string[] {
  const list = PROACTIVE_TOPICS_BY_MODE[mode]
  if (!list || list.length === 0) {
    return ['(proactive topics not available in this mode)']
  }
  const topics = list[proactiveIdx % list.length]!
  proactiveIdx += 1
  return topics
}

export function resetMock(): void {
  scriptIdx = 0
  proactiveIdx = 0
}
