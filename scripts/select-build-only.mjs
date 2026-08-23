// Standalone: just attach the version from app.json to a listing.
import { chromium } from 'playwright-core'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { homedir } from 'os'

const appDir = process.argv[2]
if (!appDir) { console.error('usage: select-build-only.mjs <app-dir>'); process.exit(1) }
const ABS = resolve(appDir.replace(/^~/, homedir()))
const app = JSON.parse(readFileSync(`${ABS}/app.json`, 'utf8'))

const browser = await chromium.connectOverCDP('http://localhost:9222')
const ctx = browser.contexts()[0]
const page = ctx.pages().find(p => p.url().includes(app.package_id)) || ctx.pages()[0]
await page.goto(`https://hub.evenrealities.com/hub/${app.package_id}/store-listing`, { waitUntil: 'networkidle' })
await page.waitForTimeout(2000)

const dlg = () => page.locator('[role="dialog"][data-state="open"]').first()
console.log(`attaching v${app.version} to ${app.package_id}…`)

await page.locator('text=Select build').first().click({ force: true })
await dlg().waitFor({ state: 'visible' })
await page.waitForTimeout(800)

const target = `v${app.version}`
// Direct DOM .click() via evaluate — Playwright's force-click bypasses
// pointer-event guards but doesn't fire the row's actual click handler.
const clicked = await dlg().evaluate((d, t) => {
  const rows = [...d.querySelectorAll('div')].filter(el =>
    el.className && typeof el.className === 'string' &&
    el.className.includes('p-4') && el.className.includes('transition') &&
    el.innerText && el.innerText.includes(t)
  )
  if (rows.length === 0) return false
  rows[0].click()
  return true
}, target)
if (!clicked) { console.error(`✗ build "${target}" row not found`); process.exit(1) }
await page.waitForTimeout(500)
await dlg().evaluate(d => {
  const btn = [...d.querySelectorAll('button')].find(b => b.innerText.trim() === 'Confirm')
  btn?.click()
})
await page.waitForTimeout(2500)

const currentVersion = await page.evaluate(() => {
  const labels = [...document.querySelectorAll('*')].filter(e => e.children.length === 0 && (e.innerText || '').trim() === 'Current version')
  if (labels.length === 0) return null
  return labels[0].parentElement?.innerText.replace('Current version', '').trim()
})
if (!currentVersion || currentVersion === '-' || currentVersion === '') {
  console.error(`✗ build attach didn't persist — Current version: "${currentVersion}"`)
  process.exit(1)
}
console.log(`✓ build attached (Current version: ${currentVersion})`)
await browser.close()
