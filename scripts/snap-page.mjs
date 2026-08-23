import { chromium } from 'playwright-core'
const browser = await chromium.connectOverCDP('http://localhost:9222')
const ctx = browser.contexts()[0]
const page = ctx.pages().find(p => p.url().includes('euchre')) || ctx.pages()[0]
await page.reload({ waitUntil: 'networkidle' })
await page.waitForTimeout(2000)
await page.setViewportSize({ width: 1280, height: 1100 }).catch(() => {})
await page.screenshot({ path: '/tmp/euchre-final.png', clip: { x: 900, y: 0, width: 380, height: 700 } })
await browser.close().catch(() => {})
