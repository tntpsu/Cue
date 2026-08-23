#!/usr/bin/env node
// Upload an .ehpk to https://hub.evenrealities.com/hub/<package_id>.
// Reuses .hub-portal-session.json from inspect-hub.mjs (run that first
// to log in once).
//
// Generic by design — reads `package_id` from ./app.json and the .ehpk
// path from the first .ehpk in repo root (or --file). Same script works
// for Cue, Pulse, Glance, lyrics-glow, etc.
//
// Usage:
//   node scripts/upload-dev.mjs                 # uploads ./<one>.ehpk
//   node scripts/upload-dev.mjs path/to/x.ehpk  # explicit file
//   node scripts/upload-dev.mjs --headless      # CI-friendly (after first login)
//
// Selectors verified against the dev portal at hub.evenrealities.com on
// 2026-04-26 via scripts/inspect-hub-project.mjs. Update the SELECTOR
// comments if the SPA's DOM changes.

import { chromium } from 'playwright-core'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const HUB_BASE = 'https://hub.evenrealities.com/hub'
// Shared across repos — see inspect-hub.mjs for rationale.
const STORAGE_STATE = `${process.env.HOME}/.hub-portal-session.json`
const FAILURE_DUMP = '.upload-dev-failure.html'

const args = process.argv.slice(2)
const headless = args.includes('--headless')

// --manifest <path>  lets the script run from any directory (specifically,
// from Cue where playwright-core lives) and upload another repo's .ehpk.
// Without it, we look for ./app.json in cwd.
const manifestFlagIdx = args.findIndex(a => a === '--manifest' || a === '-m')
const manifestPath = manifestFlagIdx >= 0
  ? resolve(args[manifestFlagIdx + 1])
  : resolve('app.json')

// --changelog "<text>"  is the user-facing description posted to the
// dev portal's "Change log" textarea (max 500 chars). If omitted, we
// auto-derive from the most recent commit subject that mentions the
// version, falling back to a generic placeholder.
const changelogFlagIdx = args.findIndex(a => a === '--changelog' || a === '-c')
let changelog = changelogFlagIdx >= 0 ? args[changelogFlagIdx + 1] : null

if (!existsSync(manifestPath)) {
  console.error(`✗ Manifest not found: ${manifestPath}`)
  console.error('  Pass --manifest <path/to/app.json> or run from a repo containing app.json.')
  process.exit(1)
}
const appJson = JSON.parse(readFileSync(manifestPath, 'utf-8'))
const packageId = appJson.package_id
const appVersion = appJson.version
if (!packageId) {
  console.error(`✗ ${manifestPath} has no package_id.`)
  process.exit(1)
}

// .ehpk path: explicit arg first, then look in the manifest's directory.
const ehpkArg = args.find(a => a.endsWith('.ehpk'))
const manifestDir = dirname(manifestPath)
const ehpkPath = ehpkArg
  ? resolve(ehpkArg)
  : resolve(manifestDir, readdirSync(manifestDir).find(f => f.endsWith('.ehpk')) ?? 'unknown.ehpk')

if (!existsSync(ehpkPath)) {
  console.error(`✗ .ehpk not found: ${ehpkPath}`)
  console.error('  Run `npm run deploy` first, or pass an explicit path.')
  process.exit(1)
}

if (!existsSync(STORAGE_STATE)) {
  console.error(`✗ No saved session at ${STORAGE_STATE}.`)
  console.error('  Run scripts/inspect-hub.mjs once to log in and save the session.')
  process.exit(2)
}

async function dumpFailure(page, where, err) {
  try {
    const html = await page.content()
    writeFileSync(FAILURE_DUMP, `<!-- failed at: ${where} -->\n<!-- error: ${err?.message ?? err} -->\n${html}`)
    console.error(`  page HTML dumped to ${FAILURE_DUMP}`)
  } catch { /* ignore */ }
}

async function deriveChangelog() {
  if (changelog && changelog.trim()) return changelog.trim().slice(0, 500)
  // Fallback: try the most recent commit subject from the manifest's repo.
  // If git isn't available or no helpful commit, use a placeholder.
  try {
    const { execSync } = await import('node:child_process')
    const subject = execSync('git log -1 --pretty=%s', {
      cwd: dirname(manifestPath),
      encoding: 'utf-8',
    }).trim()
    if (subject) return subject.slice(0, 500)
  } catch { /* no git */ }
  return `v${appVersion} build`
}

async function main() {
  changelog = await deriveChangelog()
  console.log(`→ App      ${packageId} v${appVersion}`)
  console.log(`  File     ${ehpkPath}`)
  console.log(`  Changelog${changelog.length > 70 ? ':' : '   '} ${changelog.slice(0, 200)}${changelog.length > 200 ? '…' : ''}`)
  console.log(`  Mode     ${headless ? 'headless' : 'headed'}`)

  const browser = await chromium.launch({ headless })
  const context = await browser.newContext({ storageState: STORAGE_STATE })
  const page = await context.newPage()
  page.setDefaultTimeout(15_000)

  const projectUrl = `${HUB_BASE}/${packageId}`
  await page.goto(projectUrl, { waitUntil: 'networkidle' })
  await page.waitForTimeout(1_500)

  if (!page.url().includes(packageId)) {
    console.error(`✗ Could not navigate to ${projectUrl} — landed at ${page.url()}.`)
    console.error('  Check that the project exists in the dev portal.')
    await browser.close()
    process.exit(3)
  }

  // SELECTOR: top-right "Upload a build" button on the project detail page.
  // Distinct from "Upload package" on the list page (different copy).
  try {
    const uploadBtn = page.locator('button:has-text("Upload a build")').first()
    await uploadBtn.waitFor({ state: 'visible', timeout: 10_000 })
    await uploadBtn.click()
  } catch (err) {
    console.error('✗ Could not find "Upload a build" button.')
    await dumpFailure(page, 'upload-trigger', err)
    await browser.close()
    process.exit(4)
  }

  // SELECTOR: dialog containing the file input + drop zone.
  try {
    await page.waitForSelector('[role="dialog"][data-state="open"]', { timeout: 8_000 })
  } catch (err) {
    console.error('✗ Upload dialog did not open.')
    await dumpFailure(page, 'dialog-open', err)
    await browser.close()
    process.exit(5)
  }

  // SELECTOR: hidden <input type="file" accept=".ehpk"> inside the dialog.
  // Playwright can set files on a hidden input directly — no need to click
  // "Select file" (which would open the native OS file picker).
  try {
    const fileInput = page.locator('[role="dialog"] input[type="file"][accept=".ehpk"]').first()
    await fileInput.waitFor({ state: 'attached', timeout: 5_000 })
    await fileInput.setInputFiles(ehpkPath)
    console.log('  File set on hidden input.')
  } catch (err) {
    console.error('✗ Could not set file on hidden input.')
    await dumpFailure(page, 'set-file', err)
    await browser.close()
    process.exit(6)
  }

  // After setting the file, the dialog renders a Change log textarea +
  // Cancel/Add build buttons. The "v<existing>" version chip shown at
  // the top is the LAST uploaded version, NOT a success signal — don't
  // mistake it for confirmation (we did exactly that on the first run).
  await page.waitForTimeout(2_000)
  writeFileSync('.upload-dev-after-file.html', await page.content())

  // SELECTOR: change-log textarea inside the dialog.
  try {
    const changelogTa = page.locator('[role="dialog"] textarea[name="changelog"]').first()
    await changelogTa.waitFor({ state: 'visible', timeout: 5_000 })
    await changelogTa.fill(changelog)
    console.log(`  Changelog filled (${changelog.length} chars).`)
  } catch (err) {
    console.error('✗ Could not fill change-log textarea.')
    await dumpFailure(page, 'fill-changelog', err)
    await browser.close()
    process.exit(7)
  }

  // SELECTOR: dialog submit button. The portal calls it "Add build" or
  // "Add and replace" depending on whether the version is fresh or
  // overwriting an existing build (verified on 2026-04-29). Match either.
  try {
    const addBtn = page
      .locator('[role="dialog"] button')
      .filter({ hasText: /^(Add build|Add and replace)$/ })
      .first()
    await addBtn.waitFor({ state: 'visible', timeout: 5_000 })
    await addBtn.click()
    console.log('  Add build / replace clicked.')
  } catch (err) {
    console.error('✗ Could not find/click "Add build" / "Add and replace" button.')
    await dumpFailure(page, 'add-build', err)
    await browser.close()
    process.exit(8)
  }

  // Real success signal: dialog closes. Server-side processing can take
  // a few seconds for the build to actually appear in the list, so allow
  // up to 90s — packaging + virus scan + storage write happen here.
  let uploaded = false
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    await page.waitForTimeout(1_500)
    const dialogStillOpen = await page.locator('[role="dialog"][data-state="open"]').count()
    if (dialogStillOpen === 0) {
      uploaded = true
      console.log('  Dialog closed — build added.')
      break
    }
  }
  if (!uploaded) {
    console.warn('  Dialog stayed open >90s — capturing state for inspection.')
    writeFileSync('.upload-dev-final.html', await page.content())
  }

  // Verify the new version actually shows in the build list now (not
  // just in the dialog header). Sample the page after dialog close.
  if (uploaded) {
    await page.waitForTimeout(1_500)
    const versionInList = await page
      .locator(`text=v${appVersion}`)
      .count()
    if (versionInList > 0) {
      console.log(`  Verified v${appVersion} is in the build list.`)
    } else {
      console.warn(`  Dialog closed but v${appVersion} not visible in list — check the portal.`)
    }
  }

  console.log(`${uploaded ? '✓' : '⚠'} Upload flow ${uploaded ? 'completed' : 'incomplete'} for ${packageId} v${appVersion}.`)
  await context.storageState({ path: STORAGE_STATE })
  await browser.close()
}

main().catch(err => {
  console.error('✗ Upload failed:', err.message)
  process.exit(1)
})
