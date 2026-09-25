#!/usr/bin/env node
// Capture store-listing screenshots from the simulator's glasses display,
// one live session per mode, into store-assets/. The hub wants exactly
// 576×288 PNGs, which is the glasses resolution, so no scaling is involved.
//
// Prereq (one terminal):   npm run dev        # Vite on :5176
// Then:                    node scripts/capture-store-shots.mjs
//
// Drives ONE simulator session: from idle, double-tap cycles modes until the
// `[cue:state] mode=<id>` marker reports the target, tap turns the mic on,
// the mock driver populates suggestions, screenshot, tap turns the mic off.
// Idle screens are not captured: they say "mock ready", which is honest in
// the simulator and wrong in a store.

import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PORT = 9897
const SIM_BASE = `http://127.0.0.1:${PORT}`
const DEV_URL = 'http://localhost:5176'
const HERE = dirname(fileURLToPath(import.meta.url))
const OUT_DIR = join(HERE, '..', 'store-assets')
const NATIVE = join(HERE, '..', 'node_modules', '@evenrealities', `sim-${process.platform}-${process.arch}`, 'bin', 'evenhub-simulator')
const SIM_CMD = existsSync(NATIVE)
  ? { bin: NATIVE, args: [] }
  : { bin: process.execPath, args: [join(HERE, '..', 'node_modules', '@evenrealities', 'evenhub-simulator', 'bin', 'index.js')] }

// Mode ids in cycle order (src/modes.ts) and which ones make good shots.
const CYCLE = ['date', 'argue-calm', 'sales-close', 'sting', 'listen', 'interview', 'custom']
// Interview and Custom have no mock lines of their own (they fall back to Date's),
// so a shot of them would misrepresent the mode. Sting has its own.
const TARGETS = ['date', 'argue-calm', 'sales-close', 'sting', 'listen']

const sleep = ms => new Promise(r => setTimeout(r, ms))
async function ping() { const r = await fetch(`${SIM_BASE}/api/ping`).catch(() => null); return !!(r && r.ok) }
async function input(action) {
  const r = await fetch(`${SIM_BASE}/api/input`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action }) })
  if (!r.ok) throw new Error(`/api/input ${action} → ${r.status}`)
}
async function latestState() {
  const r = await fetch(`${SIM_BASE}/api/console`).catch(() => null)
  if (!r || !r.ok) return null
  const entries = (await r.json()).entries ?? []
  for (let i = entries.length - 1; i >= 0; i--) {
    const m = entries[i].message
    if (typeof m === 'string' && m.includes('[cue:state]')) {
      const kv = Object.fromEntries([...m.matchAll(/(\w+)=([^\s]+)/g)].map(x => [x[1], x[2]]))
      return kv
    }
  }
  return null
}
async function waitFor(pred, timeoutMs, label) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    const st = await latestState()
    if (st && pred(st)) return st
    await sleep(250)
  }
  throw new Error(`timed out: ${label}`)
}
async function shot() {
  const r = await fetch(`${SIM_BASE}/api/screenshot/glasses`)
  if (!r.ok) throw new Error(`screenshot → ${r.status}`)
  const buf = Buffer.from(await r.arrayBuffer())
  const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20)
  if (w !== 576 || h !== 288) throw new Error(`screenshot is ${w}×${h}, hub needs 576×288`)
  return buf
}

async function main() {
  if (await ping()) {
    console.error(`✗ a simulator is already listening on ${PORT}; stop it (pkill -f evenhub-simulator) - this script spawns its own`)
    process.exit(2)
  }
  if (!(await fetch(DEV_URL).then(r => r.ok).catch(() => false))) {
    console.error(`✗ dev server not reachable at ${DEV_URL}; run npm run dev first`)
    process.exit(2)
  }
  const child = spawn(SIM_CMD.bin, [...SIM_CMD.args, '--automation-port', String(PORT), DEV_URL], { stdio: 'ignore' })
  try {
    const t0 = Date.now()
    while (!(await ping())) { if (Date.now() - t0 > 20_000) throw new Error('simulator did not come up'); await sleep(400) }
    await sleep(6000) // bridge + first paint
    await waitFor(s => s.stage === 'idle', 10_000, 'idle')
    await mkdir(OUT_DIR, { recursive: true })
    const written = []
    for (let i = 0; i < TARGETS.length; i++) {
      const target = TARGETS[i]
      // Cycle to the target mode (bounded: at most one full lap).
      for (let step = 0; step <= CYCLE.length; step++) {
        const st = await latestState()
        if (st?.mode === target) break
        await input('double_click'); await sleep(500)
        if (step === CYCLE.length) throw new Error(`never reached mode=${target}`)
      }
      await input('click')
      // Some mock entries carry a single suggestion (sales-close), so wait for one, not two.
      await waitFor(s => s.mode === target && s.mic === 'on' && Number(s.suggestions) >= 1, 20_000, `${target}: suggestions`)
      await sleep(600) // let the last render commit
      const buf = await shot()
      const name = `${String(i + 1).padStart(2, '0')}-${target}.png`
      await writeFile(join(OUT_DIR, name), buf)
      written.push(name)
      console.log(`  ${target.padEnd(12)} ✓ ${name} (${buf.byteLength} bytes)`)
      await input('click')
      await waitFor(s => s.mic === 'off', 8_000, `${target}: mic off`)
      await sleep(400)
    }
    console.log(`\nWrote ${written.length} screenshot(s) to store-assets/`)
  } finally {
    try { child.kill('SIGKILL') } catch { /* gone */ }
  }
}

main().catch(err => { console.error('✗', err.message); process.exit(1) })
