#!/usr/bin/env node
// Grab the hub session by copying Chrome's profile to a temp location,
// then running Playwright against the COPY. Chrome blocks remote-debugging
// on the user's default user-data-dir, so we have to point Playwright at
// a different path. Cookies + localStorage come along in the copy.
//
// Caveats:
//   - Cookies are encrypted with a keychain key tied to com.google.Chrome.
//     Playwright launches Chrome with --password-store=basic, so cookies
//     in the copy may NOT decrypt cleanly. localStorage is unencrypted on
//     macOS and travels fine.
//   - Real Chrome must be QUIT before running (file locks).
//   - The copy is left in /tmp; can be deleted after.

import { chromium } from 'playwright-core'
import { existsSync, statSync, cpSync, rmSync, mkdirSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

const STORAGE_STATE = `${homedir()}/.hub-portal-session.json`
const REAL_USER_DATA = `${homedir()}/Library/Application Support/Google/Chrome`
const TEMP_USER_DATA = join(tmpdir(), 'chrome-grab-profile')
const CHROME_BIN = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const HUB_URL = 'https://hub.evenrealities.com/hub'

if (!existsSync(REAL_USER_DATA)) {
  console.error(`✗ Chrome user-data-dir not found at ${REAL_USER_DATA}`)
  process.exit(2)
}

// Refuse to run if Chrome still appears live — copying open SQLite/LevelDB
// files can corrupt the originals.
const lock = join(REAL_USER_DATA, 'SingletonLock')
let lockExists = false
try { statSync(lock); lockExists = true } catch {}
if (lockExists) {
  console.error('✗ Chrome SingletonLock present — quit Chrome first.')
  process.exit(3)
}

console.log(`  Copying profile → ${TEMP_USER_DATA}`)
console.log('  (large copy, ~minute)')

// Clean any prior temp profile.
try { rmSync(TEMP_USER_DATA, { recursive: true, force: true }) } catch {}
mkdirSync(TEMP_USER_DATA, { recursive: true })

// Copy just what's needed for the auth handshake. Skipping caches /
// extensions / history to keep the copy small and fast.
const wanted = [
  'Local State',
  'Default/Local Storage',
  'Default/Session Storage',
  'Default/Cookies',
  'Default/Cookies-journal',
  'Default/Preferences',
  'Default/Secure Preferences',
  'Default/Network/Cookies',
  'Default/Network/Cookies-journal',
]
for (const rel of wanted) {
  const src = join(REAL_USER_DATA, rel)
  const dst = join(TEMP_USER_DATA, rel)
  try {
    if (!existsSync(src)) continue
    mkdirSync(join(dst, '..'), { recursive: true })
    cpSync(src, dst, { recursive: true, force: true })
  } catch (e) {
    console.warn(`  (skip ${rel}: ${e.message})`)
  }
}

console.log('  Launching Chrome against the copy...')
const context = await chromium.launchPersistentContext(TEMP_USER_DATA, {
  executablePath: CHROME_BIN,
  headless: false,
  timeout: 90_000,
  args: [
    '--profile-directory=Default',
    // Prefer keychain so cookies might still decrypt against
    // com.google.Chrome's saved key. Last value wins on duplicate args.
    '--password-store=keychain',
  ],
})

let page = context.pages()[0]
if (!page) page = await context.newPage()
await page.goto(HUB_URL, { waitUntil: 'networkidle' }).catch(() => {})
await page.waitForTimeout(3_000)

const state = await context.storageState({ path: STORAGE_STATE })
const cookieCount = state.cookies?.length ?? 0
const lsTotal = state.origins?.reduce((n, o) => n + (o.localStorage?.length ?? 0), 0) ?? 0
const hubOrigin = state.origins?.find(o => (o.origin || '').includes('hub.evenrealities.com'))
const hubLsCount = hubOrigin?.localStorage?.length ?? 0

console.log(`  ✓ Saved → ${STORAGE_STATE}`)
console.log(`    cookies (total): ${cookieCount}`)
console.log(`    localStorage entries (total): ${lsTotal}`)
console.log(`    localStorage entries (hub.evenrealities.com): ${hubLsCount}`)
if (hubOrigin && hubLsCount > 0) {
  console.log('    hub localStorage keys:')
  for (const e of hubOrigin.localStorage ?? []) {
    console.log(`      - ${e.name} (${e.value?.length ?? 0} chars)`)
  }
}

await context.close()
console.log('  Done. You can reopen Chrome.')
