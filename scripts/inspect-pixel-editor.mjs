import { chromium } from 'playwright-core'
const browser = await chromium.connectOverCDP('http://localhost:9222')
const ctx = browser.contexts()[0]
const page = ctx.pages().find(p => p.url().includes('hub.evenrealities.com')) || ctx.pages()[0]
const editor = page.locator('[role="dialog"][data-state="open"]').last()
const canvas = editor.locator('canvas').first()
const box = await canvas.boundingBox()
const dims = await canvas.evaluate(c => ({ width: c.width, height: c.height, clientW: c.clientWidth, clientH: c.clientHeight }))
console.log('canvas box:', JSON.stringify(box))
console.log('canvas dims:', JSON.stringify(dims))
console.log('cell size on screen:', box.width / 24, 'x', box.height / 24)
await browser.close().catch(() => {})
