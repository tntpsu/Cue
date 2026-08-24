#!/usr/bin/env node
// Refresh ~/.hub-portal-session.json from the PERSISTENT debug-Chrome instance
// on port 9222 — without touching, or quitting, your real Chrome.
//
// Why this exists: grab-from-chrome-copy.mjs copies your default Chrome profile
// and launches Playwright against the copy, because Chrome blocks remote
// debugging on the default profile. That copy is only trustworthy when Chrome
// is fully quit — Chrome holds localStorage (where the hub JWT lives) in memory
// and does not reliably flush it while running. Hence the recurring "please
// quit Chrome" dance, and a grab that once captured a logged-OUT stub and
// overwrote a working session with it.
//
// Debug Chrome sidesteps all of that: separate --user-data-dir, so remote
// debugging is permitted, and we read the live context rather than a snapshot
// off disk. Nothing needs to be closed.
//
// Setup (once):
//   ~/launch-debug-chrome.sh      # opens the hub; sign in there
// Then, any time the session expires:
//   node scripts/grab-from-debug-chrome.mjs

import { chromium } from 'playwright'
import { writeFileSync } from 'node:fs'

const CDP = 'http://127.0.0.1:9222'
const OUT = `${process.env.HOME}/.hub-portal-session.json`
const HUB = 'https://hub.evenrealities.com'

const ver = await fetch(`${CDP}/json/version`).catch(() => null)
if (!ver || !ver.ok) {
  console.error(`✗ No debug Chrome on ${CDP}.`)
  console.error('  Run ~/launch-debug-chrome.sh, sign in to the hub, then retry.')
  process.exit(2)
}

const browser = await chromium.connectOverCDP(CDP)
try {
  const ctx = browser.contexts()[0]
  if (!ctx) { console.error('✗ Debug Chrome has no browser context.'); process.exit(1) }

  // Use an existing hub tab if there is one; otherwise open one so the origin's
  // localStorage is actually loaded into the context before we snapshot it.
  let page = ctx.pages().find(p => p.url().startsWith(HUB))
  if (!page) {
    page = await ctx.newPage()
    await page.goto(`${HUB}/hub`, { waitUntil: 'domcontentloaded', timeout: 30_000 })
  } else {
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {})
  }
  await page.waitForTimeout(2500)

  if (page.url().includes('/login')) {
    console.error('✗ Debug Chrome is NOT signed in — it landed on /login.')
    console.error('  Sign in at https://hub.evenrealities.com in that window, then retry.')
    process.exit(3)
  }

  const state = await ctx.storageState()
  const hub = state.origins.find(o => o.origin.includes('evenrealities'))
  const auth = hub?.localStorage?.find(e => e.name === 'er_auth_state_store')

  // Guard against the exact failure that bit us: writing a logged-out stub over
  // a working session. A real token is hundreds of characters.
  if (!auth || auth.value.length < 200) {
    console.error(`✗ Refusing to write — er_auth_state_store is ${auth ? auth.value.length + ' chars' : 'absent'}.`)
    console.error('  That is a logged-out stub, not a session. Sign in and retry.')
    process.exit(4)
  }

  writeFileSync(OUT, JSON.stringify(state, null, 2))
  console.log(`✓ Saved → ${OUT}`)
  console.log(`  origin: ${hub.origin}`)
  console.log(`  er_auth_state_store: ${auth.value.length} chars`)
  console.log('  Your normal Chrome was never touched.')
} finally {
  // connectOverCDP: close() detaches the client, it does NOT kill the browser.
  await browser.close()
}
