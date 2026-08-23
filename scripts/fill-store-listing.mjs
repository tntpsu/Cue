#!/usr/bin/env node
// Fill Even Hub store listing for an app. Drives the user's logged-in
// debug-Chrome via CDP on port 9222. Reads <app>/store-listing.json and
// ~/.even-developer-info.json. See ~/.claude/skills/fill-store-listing/
// SKILL.md for the recipe and observed selectors.

import { chromium } from 'playwright-core'
import { readFileSync, existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve, join } from 'node:path'
import { execSync } from 'node:child_process'

const HUB_BASE = 'https://hub.evenrealities.com/hub'
const CDP_URL = 'http://localhost:9222'

// 5×7 pixel font for icon text mode. Each glyph is rendered at 2× scale
// into the 24×24 grid; the editor's 2×2 brush mode then doubles again.
const FONT = {
  '0':['.###.','#...#','#...#','#...#','#...#','#...#','.###.'],'1':['..#..','.##..','..#..','..#..','..#..','..#..','.###.'],
  '2':['.###.','#...#','....#','...#.','..#..','.#...','#####'],'3':['.###.','#...#','....#','..##.','....#','#...#','.###.'],
  '4':['#...#','#...#','#...#','#####','....#','....#','....#'],'5':['#####','#....','####.','....#','....#','#...#','.###.'],
  '6':['.###.','#...#','#....','####.','#...#','#...#','.###.'],'7':['#####','....#','...#.','..#..','.#...','.#...','.#...'],
  '8':['.###.','#...#','#...#','.###.','#...#','#...#','.###.'],'9':['.###.','#...#','#...#','.####','....#','#...#','.###.'],
  'A':['.###.','#...#','#...#','#####','#...#','#...#','#...#'],'B':['####.','#...#','#...#','####.','#...#','#...#','####.'],
  'C':['.###.','#...#','#....','#....','#....','#...#','.###.'],'D':['####.','#...#','#...#','#...#','#...#','#...#','####.'],
  'E':['#####','#....','#....','####.','#....','#....','#####'],'F':['#####','#....','#....','####.','#....','#....','#....'],
  'G':['.###.','#...#','#....','#.###','#...#','#...#','.####'],'H':['#...#','#...#','#...#','#####','#...#','#...#','#...#'],
  'I':['.###.','..#..','..#..','..#..','..#..','..#..','.###.'],'J':['..###','...#.','...#.','...#.','...#.','#..#.','.##..'],
  'K':['#...#','#..#.','#.#..','##...','#.#..','#..#.','#...#'],'L':['#....','#....','#....','#....','#....','#....','#####'],
  'M':['#...#','##.##','#.#.#','#...#','#...#','#...#','#...#'],'N':['#...#','##..#','#.#.#','#..##','#...#','#...#','#...#'],
  'O':['.###.','#...#','#...#','#...#','#...#','#...#','.###.'],'P':['####.','#...#','#...#','####.','#....','#....','#....'],
  'Q':['.###.','#...#','#...#','#...#','#.#.#','#..##','.####'],'R':['####.','#...#','#...#','####.','#.#..','#..#.','#...#'],
  'S':['.####','#....','#....','.###.','....#','....#','####.'],'T':['#####','..#..','..#..','..#..','..#..','..#..','..#..'],
  'U':['#...#','#...#','#...#','#...#','#...#','#...#','.###.'],'V':['#...#','#...#','#...#','#...#','#...#','.#.#.','..#..'],
  'W':['#...#','#...#','#...#','#...#','#.#.#','##.##','#...#'],'X':['#...#','#...#','.#.#.','..#..','.#.#.','#...#','#...#'],
  'Y':['#...#','#...#','.#.#.','..#..','..#..','..#..','..#..'],'Z':['#####','....#','...#.','..#..','.#...','#....','#####'],
  ' ':['.....','.....','.....','.....','.....','.....','.....'],
}
function gridFromText(text) {
  const grid = Array.from({ length: 24 }, () => new Array(24).fill(0))
  const chars = text.toUpperCase().split('').slice(0, 3)
  const glyphW = 10, gap = 2, glyphH = 14
  const totalW = chars.length * glyphW + (chars.length - 1) * gap
  const startX = Math.floor((24 - totalW) / 2)
  const startY = Math.floor((24 - glyphH) / 2)
  for (let i = 0; i < chars.length; i++) {
    const g = FONT[chars[i]]
    if (!g) { console.error(`✗ no glyph for "${chars[i]}"`); process.exit(2) }
    const ox = startX + i * (glyphW + gap)
    for (let r = 0; r < 7; r++) for (let c = 0; c < 5; c++) {
      if (g[r][c] !== '#') continue
      for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
        const x = ox + c * 2 + dx, y = startY + r * 2 + dy
        if (x >= 0 && x < 24 && y >= 0 && y < 24) grid[y][x] = 1
      }
    }
  }
  return grid
}
function gridFromAscii(file) {
  const lines = readFileSync(file, 'utf8').replace(/\r/g, '').split('\n').filter(l => l.length > 0)
  if (lines.length !== 24) { console.error(`✗ ${file}: must have 24 non-empty lines (got ${lines.length})`); process.exit(3) }
  return lines.map((line, idx) => {
    if (line.length !== 24) { console.error(`✗ ${file}:${idx + 1}: must be 24 chars (got ${line.length})`); process.exit(4) }
    return line.split('').map(ch => (ch === '#' || ch === '1') ? 1 : 0)
  })
}

const appDir = process.argv[2]
if (!appDir) {
  console.error('usage: node fill-store-listing.mjs <app-dir>')
  process.exit(1)
}
const ABS_APP = resolve(appDir.replace(/^~/, homedir()))

// === Load + validate config ============================================

function dieIfMissing(path, hint) {
  if (!existsSync(path)) { console.error(`✗ ${path} not found.\n  ${hint}`); process.exit(2) }
}

dieIfMissing(`${ABS_APP}/app.json`, 'No app.json — is this a glasses app dir?')
dieIfMissing(`${ABS_APP}/store-listing.json`, 'Create one. See SKILL.md for schema.')
dieIfMissing(`${homedir()}/.even-developer-info.json`,
  'Copy ~/.even-developer-info.template.json and fill in your real info.')

const app = JSON.parse(readFileSync(`${ABS_APP}/app.json`, 'utf8'))
const cfg = JSON.parse(readFileSync(`${ABS_APP}/store-listing.json`, 'utf8'))
const dev = JSON.parse(readFileSync(`${homedir()}/.even-developer-info.json`, 'utf8'))

const requiredDev = ['developer_name', 'contact_email', 'contact_telephone', 'contact_address']
for (const k of requiredDev) {
  if (!dev[k] || String(dev[k]).trim() === '') {
    console.error(`✗ ~/.even-developer-info.json missing "${k}". Fill it in and re-run.`)
    process.exit(3)
  }
}

const packageId = app.package_id

// === Asset checks ======================================================

function pngDims(path) {
  const out = execSync(`file "${path}"`, { encoding: 'utf8' })
  const m = out.match(/(\d+)\s*x\s*(\d+)/)
  if (!m) throw new Error(`could not parse PNG dims from: ${out}`)
  return [Number(m[1]), Number(m[2])]
}

function checkAsset(rel, w, h, label) {
  const abs = join(ABS_APP, rel)
  if (!existsSync(abs)) { console.error(`✗ ${label} missing: ${abs}`); process.exit(4) }
  const [aw, ah] = pngDims(abs)
  if (aw !== w || ah !== h) {
    console.error(`✗ ${label} must be ${w}x${h} PNG, got ${aw}x${ah}: ${abs}`)
    process.exit(5)
  }
  return abs
}

// Icon: built from cfg.icon_text (1–3 chars, built-in font) OR
// cfg.icon_ascii_file (24-line bitmap). The icon is DRAWN INTO the portal's
// pixel editor cell-by-cell (clicks on a canvas), because the server
// validator rejects direct PNG uploads. Skipped when neither is provided.
const iconGrid = cfg.icon_text ? gridFromText(cfg.icon_text)
  : cfg.icon_ascii_file ? gridFromAscii(join(ABS_APP, cfg.icon_ascii_file))
  : null
const ssAbs = cfg.screenshots.map((rel, i) => checkAsset(rel, 576, 288, `screenshots[${i}]`))

if (typeof cfg.cover_screenshot_index !== 'number'
    || cfg.cover_screenshot_index < 0
    || cfg.cover_screenshot_index >= ssAbs.length) {
  console.error(`✗ cover_screenshot_index must be 0–${ssAbs.length - 1}`)
  process.exit(6)
}

// === CDP reachable? ====================================================

let cdpReady = false
try {
  const r = await fetch(`${CDP_URL}/json/version`)
  if (r.ok) { cdpReady = true; const v = await r.json(); console.log(`  CDP up: ${v.Browser}`) }
} catch {}
if (!cdpReady) {
  console.error('✗ CDP not reachable on :9222.')
  console.error('  Quit Chrome (⌘Q on every window), then run ~/launch-debug-chrome.sh')
  process.exit(7)
}

// === Connect ===========================================================

const browser = await chromium.connectOverCDP(CDP_URL)
const ctx = browser.contexts()[0]
let page = ctx.pages().find(p => p.url().includes(packageId)) || ctx.pages()[0]
if (!page) page = await ctx.newPage()
page.setDefaultTimeout(15_000)

const projectUrl = `${HUB_BASE}/${packageId}/store-listing`
await page.goto(projectUrl, { waitUntil: 'networkidle' })
await page.waitForTimeout(2000)
if (!page.url().includes(packageId)) {
  console.error(`✗ Could not reach ${projectUrl} — landed at ${page.url()}.`)
  console.error('  Are you logged into hub.evenrealities.com in this Chrome?')
  process.exit(8)
}
console.log(`→ ${packageId} (${app.name} v${app.version})`)

// === Helpers ===========================================================

const dlg = () => page.locator('[role="dialog"][data-state="open"]').first()
async function closeDialogIfOpen() {
  if (await dlg().isVisible().catch(() => false)) {
    await dlg().locator('button:has-text("Cancel")').first().click().catch(() => {})
    await page.waitForTimeout(800)
  }
}

// === Section 1: Edit basic info (icon, name, tagline) ==================

async function fillBasicInfo() {
  console.log('  basic info…')
  await page.getByText('Edit', { exact: true }).first().click()
  await dlg().waitFor({ state: 'visible' })
  // Name
  const nameInput = dlg().locator('input[name="name"]')
  await nameInput.fill(cfg.name.slice(0, 20))
  // Tagline
  await dlg().locator('input[name="tagline"]').fill(cfg.tagline.slice(0, 50))
  // Icon: drive the pixel editor by clicking cells on its <canvas>. Direct
  // PNG upload via the hidden file input fails server validation; the
  // editor's own canvas → PNG conversion is the only format the validator
  // accepts.
  if (iconGrid) {
    console.log('    drawing icon in pixel editor…')
    await dlg().locator('button:has-text("Create with a tool")').click()
    await page.waitForTimeout(1500)
    const editor = page.locator('[role="dialog"][data-state="open"]').last()
    const canvas = editor.locator('canvas').first()
    const box = await canvas.boundingBox()
    if (!box) throw new Error('pixel editor canvas not found')
    const cell = box.width / 24
    await editor.locator('button:has-text("Clear")').click()
    await page.waitForTimeout(400)
    await editor.locator('button:has-text("Draw")').click()
    await page.waitForTimeout(200)
    let clicked = 0
    for (let r = 0; r < 24; r++) for (let c = 0; c < 24; c++) {
      if (!iconGrid[r][c]) continue
      const x = box.x + c * cell + cell / 2, y = box.y + r * cell + cell / 2
      await page.mouse.click(x, y, { delay: 5 })
      clicked++
    }
    console.log(`    clicked ${clicked} cells`)
    await page.waitForTimeout(800)
    // Confirm pixel editor — returns to Edit basic info dialog
    await editor.locator('button:has-text("Confirm")').click()
    await page.waitForTimeout(1500)
  }
  // Confirm Edit basic info — commits name/tagline/icon
  await dlg().locator('button:has-text("Confirm")').click()
  await page.waitForTimeout(1500)
}

// === Section 2: Cover and screenshots ==================================

async function fillScreenshots() {
  console.log('  screenshots + cover…')
  // Trigger: 'Add screenshots' (first time) OR 'Edit' next to 'Cover and screenshots' (re-edit)
  const addBtn = page.locator('button:has-text("Add screenshots")')
  if (await addBtn.count() > 0) {
    await addBtn.first().click()
  } else {
    // Click the 'Edit' nearest to 'Cover and screenshots'
    await page.locator('text=Cover and screenshots').locator('..').locator('text=Edit').first().click()
      .catch(async () => {
        // Fallback: any visible Edit button after the Preview heading
        await page.getByText('Edit', { exact: true }).nth(1).click()
      })
  }
  await dlg().waitFor({ state: 'visible' })

  // Upload all screenshots in one shot
  const fileInput = dlg().locator('input[type="file"][accept="image/png"][multiple]').first()
  await fileInput.setInputFiles(ssAbs)
  await page.waitForTimeout(2000)  // give thumbnails time to render

  // Pick cover screenshot (click the thumbnail at cover_screenshot_index).
  // Thumbnails sit under the "Screenshots" heading. Force-click because each
  // thumbnail is overlaid by composited image elements that intercept clicks.
  const ssRow = dlg().locator('text=Screenshots').locator('..').locator('img')
  if (await ssRow.count() >= ssAbs.length) {
    await ssRow.nth(cfg.cover_screenshot_index).click({ force: true })
  } else {
    const thumbs = dlg().locator('img').filter({ hasNot: page.locator('[alt*="environment" i]') })
    await thumbs.nth(cfg.cover_screenshot_index).click({ force: true })
  }
  await page.waitForTimeout(800)

  // Pick environment (Home / Office / Store / Cafe / etc.)
  // The environment thumbnails are <img> overlaid with a text label; the text
  // node is found but clicking it is intercepted by the img on top. Force-click
  // bypasses the visibility overlay check.
  const env = dlg().locator(`text=${cfg.cover_environment}`).first()
  if (await env.count() > 0) {
    await env.click({ force: true })
    await page.waitForTimeout(800)
  } else {
    console.warn(`  (env "${cfg.cover_environment}" not found — leaving default)`)
  }

  await dlg().locator('button:has-text("Confirm")').click()
  await page.waitForTimeout(1500)
}

// === Section 3: Description ============================================

async function fillDescription() {
  console.log('  description…')
  const addBtn = page.locator('button:has-text("Add description")')
  if (await addBtn.count() > 0) {
    await addBtn.first().click()
  } else {
    await page.locator('text=Description').locator('..').locator('text=Edit').first().click()
      .catch(async () => {
        await page.getByText('Edit', { exact: true }).nth(2).click()
      })
  }
  await dlg().waitFor({ state: 'visible' })

  // Category — use the underlying <select> element directly. The visible
  // custom dropdown (button + popover) is scrollable; clicking visible items
  // is fragile because long lists scroll items off-screen. selectOption on
  // the hidden native <select> sets the value reliably and the visible UI
  // syncs from it.
  const select = dlg().locator('select').first()
  if (await select.count() > 0) {
    await select.selectOption(cfg.category)
  } else {
    // Fallback: open the custom dropdown and click the visible label
    await dlg().locator('button:has-text("Select category"), button:has-text("' + cfg.category + '")').first().click()
    await page.waitForTimeout(500)
    await page.getByRole('option', { name: cfg.category }).first().click({ force: true })
  }
  await page.waitForTimeout(500)

  // About
  const desc = cfg.description.slice(0, 2000)
  await dlg().locator('textarea[name="description"]').fill(desc)

  // Tags (optional)
  if (cfg.tags && cfg.tags.length > 0) {
    // Tags: only add if none exist yet. Tag pills are persistent across
    // re-opens of the dialog and there's no reliable selector for the
    // remove button. Each tag needs typing then Enter (not comma-split).
    // The visible tag input is hidden once any pill is present.
    const tagsContainer = dlg().locator('text=Tags').locator('..').locator('..')
    const existingPills = await tagsContainer.locator('[class*="pill"], [class*="chip"], [class*="tag"]').count().catch(() => 0)
    const tagsInput = tagsContainer.locator('input').first()
    const inputVisible = await tagsInput.isVisible().catch(() => false)
    if (existingPills > 0) {
      console.log(`    (${existingPills} existing tag pills — skipping tag fill)`)
    } else if (inputVisible) {
      for (const tag of cfg.tags.slice(0, 5)) {
        await tagsInput.click().catch(() => {})
        await tagsInput.fill(tag.slice(0, 20))
        await page.keyboard.press('Enter')
        await page.waitForTimeout(200)
      }
    } else {
      console.log('    (tag input not visible — skipping)')
    }
  }

  await dlg().locator('button:has-text("Confirm")').click()
  await page.waitForTimeout(1500)
  // Verify dialog closed; if not, log + bail rather than blunder into next step
  const stillOpen = await dlg().isVisible().catch(() => false)
  if (stillOpen) {
    const btnText = await dlg().locator('button').evaluateAll(els => els.map(e => e.innerText.trim()))
    throw new Error(`description dialog did not close after Confirm — buttons: ${btnText.join(', ')}`)
  }
}

// === Section 4: Privacy and terms wizard (4 steps) =====================

async function fillPrivacy() {
  console.log('  privacy/terms wizard…')
  // Skip if PDF already exists — privacy is already filled, no need to redo.
  const hasPdf = await page.locator('text=Privacy Policy and Terms & Conditions.pdf').count() > 0
  if (hasPdf) {
    console.log('    (PDF already generated — skipping)')
    return
  }
  // Trigger label is "Fill out privacy and terms" for first time, "Edit"
  // near the heading for re-edit. We only get here if PDF doesn't exist
  // (i.e. first time), so prefer the explicit button.
  const fillBtn = page.locator('button:has-text("Fill out privacy and terms")')
  if (await fillBtn.count() > 0) {
    await fillBtn.first().click()
  } else {
    await page.locator('text=Privacy and terms').locator('..').locator('text=Edit').first().click()
  }
  await dlg().waitFor({ state: 'visible' })

  // Step 1: Contact information
  await dlg().locator('input[name="developer_name"]').fill(dev.developer_name.slice(0, 25))
  await dlg().locator('input[name="contact_email"]').fill(dev.contact_email.slice(0, 50))
  await dlg().locator('input[name="contact_telephone"]').fill(dev.contact_telephone.slice(0, 20))
  await dlg().locator('input[name="contact_address"]').fill(dev.contact_address.slice(0, 100))
  await dlg().locator('button:has-text("Next")').click()
  await page.waitForTimeout(800)

  // Step 2: Access permissions
  const perms = cfg.permissions || {}
  const permLabels = {
    microphone: 'Microphone of Even Smart Glasses',
    location: 'Location',
    push_notifications: 'Push notifications',
    local_network: 'Local network',
    bluetooth: 'Bluetooth',
    background_services: 'Run background services',
  }
  for (const [key, label] of Object.entries(permLabels)) {
    if (perms[key]) {
      const row = dlg().locator(`text=${label}`).locator('..')
      const cb = row.locator('input[type="checkbox"], [role="checkbox"]').first()
      if (await cb.count() > 0) await cb.click().catch(() => {})
    }
  }
  await dlg().locator('button:has-text("Next")').click()
  await page.waitForTimeout(800)

  // Step 3: Data collection
  const dc = cfg.data_collection || {}
  if (dc.location_tracked) {
    await dlg().locator('text=Location tracked').locator('..').locator('input[type="checkbox"], [role="checkbox"]').first().click().catch(() => {})
  }
  if (dc.ai_used) {
    await dlg().locator('text=AI technology used').locator('..').locator('input[type="checkbox"], [role="checkbox"]').first().click().catch(() => {})
  }
  await dlg().locator('button:has-text("Next")').click()
  await page.waitForTimeout(800)

  // Step 4: Third-party services
  const tps = cfg.third_party_services || []
  if (tps.length > 0) {
    const inputs = dlg().locator('input[placeholder*="third-party"]')
    for (let i = 0; i < tps.length; i++) {
      const exists = await inputs.nth(i).count() > 0
      if (!exists) {
        // Click '+' to add another row
        await dlg().locator('button[aria-label*="add" i], button:has-text("+")').first().click().catch(() => {})
        await page.waitForTimeout(300)
      }
      await inputs.nth(i).fill(tps[i].slice(0, 50))
    }
  }
  await dlg().locator('button:has-text("Generate document")').click()
  // Generate takes ~5s server-side; poll for the wizard dialog to actually
  // close, up to 30s. If it doesn't close, the next section's selectors
  // get confused by the still-open dialog — better to fail loudly here.
  for (let i = 0; i < 30; i++) {
    await page.waitForTimeout(1000)
    const stillOpen = await dlg().isVisible().catch(() => false)
    if (!stillOpen) return
  }
  throw new Error('privacy wizard did not close 30s after Generate document — check the page')
}

// === Section 5: Select build ===========================================
// Attaches the .ehpk version matching app.json's `version` field to the
// listing. Without this, "Submit for review" stays disabled (or submits
// the wrong/no build).

async function selectBuild() {
  console.log('  select build…')
  // Re-navigate to a clean page state. After the privacy wizard, the page
  // often has lingering transition state that makes the Select build dialog
  // open against stale DOM, causing silent no-ops on the row click.
  await page.goto(projectUrl, { waitUntil: 'networkidle' })
  await page.waitForTimeout(2000)
  // "Select build" trigger isn't always a <button>; sometimes it's a styled
  // div or anchor in the right-panel "Publish to hub" section. Match on text.
  const trigger = page.locator('button:has-text("Select build"), a:has-text("Select build"), [role="button"]:has-text("Select build")').first()
  let opened = false
  if (await trigger.count() > 0) {
    await trigger.click().catch(() => {})
    opened = await dlg().isVisible({ timeout: 3000 }).catch(() => false)
  }
  if (!opened) {
    // Fallback: click on any element with "Select build" text in the right panel
    const text = page.locator('text=Select build').first()
    await text.click({ force: true }).catch(() => {})
    opened = await dlg().isVisible({ timeout: 3000 }).catch(() => false)
  }
  if (!opened) {
    console.log('    (could not open Select build dialog — skipping)')
    return
  }
  await page.waitForTimeout(800)
  const target = `v${app.version}`
  // The selectable row is a DIV with class "p-4 ... transition-color".
  // No <input>, button, or role attribute — the visible "checkbox" is
  // CSS-only. Playwright's `.click({ force: true })` bypasses pointer-event
  // checks but apparently doesn't trigger the row's click handler reliably
  // here. Direct DOM `el.click()` via evaluate works.
  const clicked = await dlg().evaluate((d, target) => {
    const rows = [...d.querySelectorAll('div')].filter(el =>
      el.className && typeof el.className === 'string' &&
      el.className.includes('p-4') && el.className.includes('transition') &&
      el.innerText && el.innerText.includes(target)
    )
    if (rows.length === 0) return false
    rows[0].click()
    return true
  }, target)
  if (!clicked) {
    throw new Error(`build "${target}" row not found in Select build dialog`)
  }
  await page.waitForTimeout(500)
  // DOM-click Confirm too — Playwright's .click() races the row state.
  await dlg().evaluate(d => {
    const btn = [...d.querySelectorAll('button')].find(b => b.innerText.trim() === 'Confirm')
    btn?.click()
  })
  await page.waitForTimeout(2500)
  // Verify the build actually got attached by checking the right-panel
  // "Current version" field. If it still shows "-" (or empty), the dialog
  // closed without saving — fail loudly.
  const currentVersion = await page.evaluate(() => {
    const labels = [...document.querySelectorAll('*')].filter(e => e.children.length === 0 && (e.innerText || '').trim() === 'Current version')
    if (labels.length === 0) return null
    // Sibling text typically holds the value
    const label = labels[0]
    const row = label.parentElement
    return row ? row.innerText.replace('Current version', '').trim() : null
  })
  console.log(`    Current version after attach: "${currentVersion}"`)
  if (!currentVersion || currentVersion === '-' || currentVersion === '') {
    throw new Error(`build attach didn't persist — Current version still "${currentVersion}". Try running select-build-only.mjs or attach manually.`)
  }
}

// === Run ===============================================================

try {
  await closeDialogIfOpen()
  await fillBasicInfo()
  await fillScreenshots()
  await fillDescription()
  await fillPrivacy()
  await selectBuild()
} catch (err) {
  console.error('\n✗ failed:', err.message)
  await page.screenshot({ path: '/tmp/fill-store-listing-failure.png' }).catch(() => {})
  console.error('  screenshot saved → /tmp/fill-store-listing-failure.png')
  await browser.close().catch(() => {})
  process.exit(9)
}

// === Verify Submit-for-review enabled ==================================

const submit = page.locator('button:has-text("Submit for review")').first()
const submitEnabled = await submit.evaluate(el => !el.disabled && getComputedStyle(el).opacity !== '0.5').catch(() => false)
console.log(`\n${submitEnabled ? '✓' : '⚠'} Submit for review is ${submitEnabled ? 'ENABLED' : 'still disabled'}`)
console.log(`  Listing: ${HUB_BASE}/${packageId}/store-listing`)
console.log('  (This skill does NOT click Submit — that is your call.)')

await browser.close()
