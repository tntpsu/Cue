import { chromium } from 'playwright-core'
const browser = await chromium.connectOverCDP('http://localhost:9222')
const ctx = browser.contexts()[0]
const page = ctx.pages().find(p => p.url().includes('hearts')) || ctx.pages()[0]
page.on('request', r => {
  const u = r.url()
  if (u.includes('evenrealities') && r.method() !== 'GET') {
    console.log('  →', r.method(), u.replace(/.*evenrealities\.com/, ''))
  }
})
page.on('response', r => {
  const u = r.url()
  if (u.includes('evenrealities') && r.request().method() !== 'GET') {
    console.log('  ←', r.status(), u.replace(/.*evenrealities\.com/, ''))
  }
})
const dlg = page.locator('[role="dialog"][data-state="open"]').first()
const open = await dlg.isVisible().catch(() => false)
console.log('dialog open?', open)
await page.screenshot({ path: '/tmp/before-confirm-test.png' })
console.log('clicking Confirm…')
await dlg.locator('button:has-text("Confirm")').first().click({ delay: 80 })
await page.waitForTimeout(4000)
console.log('done.')
await browser.close().catch(() => {})
