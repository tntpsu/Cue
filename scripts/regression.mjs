#!/usr/bin/env node
// End-to-end regression test for Cue via the Even Hub simulator HTTP API.
// Verifies the UX flow only — privacy gate, mode cycle, mic toggle, mock
// suggestion ticks. Real audio capture / STT / LLM cannot be exercised in
// the simulator (no audio input injection); that path is tested via the
// offline Worker round-trip (scripts/worker-test.mjs) and manually on
// real glasses with a deployed Worker.
//
// Prereqs (run manually first):
//   1. cd ~/Documents/Cue && npm run dev          # Vite on :5176
//   2. npm run sim                                 # simulator on :9897
//
// Then: npm run test:e2e

import { writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SIM_BASE = 'http://127.0.0.1:9897'
const HERE = dirname(fileURLToPath(import.meta.url))
const OUT_DIR = join(HERE, '..', 'tests', 'screenshots-regression')

let lastConsoleId = -1
let pass = 0
let fail = 0
const failures = []

async function ping() {
  const r = await fetch(`${SIM_BASE}/api/ping`)
  if (!r.ok) throw new Error(`simulator not reachable on ${SIM_BASE}`)
}
async function input(action) {
  const r = await fetch(`${SIM_BASE}/api/input`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action }),
  })
  if (!r.ok) throw new Error(`input ${action} failed: ${r.status}`)
}
async function fetchConsoleEntries() {
  const r = await fetch(`${SIM_BASE}/api/console`)
  const body = await r.json()
  return body.entries ?? []
}
async function waitForState(predicate, { timeoutMs = 15_000, label } = {}) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const entries = await fetchConsoleEntries()
    const fresh = entries.filter(e => e.id > lastConsoleId)
    for (const e of fresh) {
      if (typeof e.message === 'string' && e.message.includes('[cue:state]') && predicate(e.message)) {
        lastConsoleId = e.id
        return e
      }
      if (e.id > lastConsoleId) lastConsoleId = e.id
    }
    await new Promise(r => setTimeout(r, 200))
  }
  throw new Error(`timed out waiting for state: ${label ?? '(unlabeled)'}`)
}
// Sample over `durationMs`, return count of [cue:state] logs that
// appeared during the window. Lets us catch the silent-render-loop
// regression where the app emits the right state once and then stops.
// Pattern lifted from lyrics-glow (which has the most fragile render
// cadence of the four apps).
async function countStateLogs(durationMs) {
  const before = await fetchConsoleEntries()
  const startId = before.length > 0 ? before[before.length - 1].id : -1
  await new Promise(r => setTimeout(r, durationMs))
  const after = await fetchConsoleEntries()
  const fresh = after.filter(e => e.id > startId && typeof e.message === 'string' && e.message.includes('[cue:state]'))
  if (fresh.length > 0) lastConsoleId = Math.max(lastConsoleId, fresh[fresh.length - 1].id)
  return fresh.length
}

async function screenshot(name) {
  await mkdir(OUT_DIR, { recursive: true })
  const r = await fetch(`${SIM_BASE}/api/screenshot/glasses`)
  const buf = Buffer.from(await r.arrayBuffer())
  await writeFile(join(OUT_DIR, `${name}.png`), buf)
}
function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`)
    pass += 1
  } else {
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`)
    failures.push(label)
    fail += 1
  }
}

async function main() {
  console.log('Cue regression test')
  console.log(`  simulator: ${SIM_BASE}`)
  console.log()

  await ping()
  const initial = await fetchConsoleEntries()
  if (initial.length > 0) lastConsoleId = initial[initial.length - 1].id

  // The privacy gate is the first visible state. To progress past it
  // automatically we'd need to drive the phone-side accept button; the
  // simulator API only injects glasses input. So this test assumes the
  // user has already accepted privacy on a previous run (storage
  // persists across simulator restarts in the local dev preview).
  console.log('1. Initial idle view (mic off)')
  await screenshot('01-initial')
  // Trigger any state log so we have a baseline.
  await input('double_click')
  const cycled = await waitForState(
    m => m.includes('mode=') && m.includes('mic=off'),
    { label: 'mode cycled while mic off' },
  )
  check('double-tap cycles mode in idle state', cycled.message.includes('mic=off'), cycled.message)
  await screenshot('02-mode-cycled')

  console.log('2. Tap to start mock session')
  await input('click')
  const live = await waitForState(
    m => m.includes('mic=on') && m.includes('stage=live'),
    { label: 'mic-on live state', timeoutMs: 4_000 },
  )
  check('tap turns mic on (mock mode)', live.message.includes('mic=on'), live.message)
  await screenshot('03-live')

  console.log('3. Wait for mock suggestions to populate')
  // Mock driver fires immediately on session start; suggestions go from 0 → 3.
  const withSuggestions = await waitForState(
    m => m.includes('mic=on') && m.includes('suggestions=') && !m.includes('suggestions=0'),
    { label: 'mock suggestions populated', timeoutMs: 4_000 },
  )
  const sm = withSuggestions.message.match(/suggestions=(\d+)/)
  const suggCount = sm ? parseInt(sm[1], 10) : 0
  check('mock driver populates suggestions on tick', suggCount > 0, `${suggCount} suggestions`)
  await screenshot('04-suggestions')

  console.log('4. Tap again to stop mic')
  await input('click')
  const idleAgain = await waitForState(
    m => m.includes('mic=off'),
    { label: 'back to idle', timeoutMs: 3_000 },
  )
  check('tap again turns mic off', idleAgain.message.includes('mic=off'), idleAgain.message)
  await screenshot('05-back-to-idle')

  console.log('5. Render loop liveness (3s sample, mic on)')
  // Re-tap to start a mock session, then sample state-log frequency.
  // Mock-tick fires every 8s; mic-tick fires every 1s. Expect at least
  // 2 state logs in a 3s window — catches "loop died after first render".
  await input('click')
  await waitForState(m => m.includes('mic=on'), { label: 'mic on for liveness sample', timeoutMs: 3_000 })
  const ticks = await countStateLogs(3_000)
  check('render loop emits state logs while mic on', ticks >= 2, `${ticks} state logs in 3s`)
  await input('click') // back to idle
  await waitForState(m => m.includes('mic=off'), { label: 'mic off after liveness', timeoutMs: 3_000 })

  console.log()
  console.log(`Result: ${pass} passed, ${fail} failed`)
  if (fail > 0) {
    console.log('Failures:')
    for (const f of failures) console.log(`  - ${f}`)
    process.exit(1)
  }
}

main().catch(err => {
  console.error('FATAL:', err.message)
  process.exit(1)
})
