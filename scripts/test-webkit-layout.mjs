#!/usr/bin/env node
// Phone-WebView LAYOUT check in Playwright/WebKit — the engine family iOS
// WKWebView is built on. Distinct from scripts/test-webkit.mjs, which exercises
// the network transport against a live Worker.
//
// Why this exists: hub reviewers drive the PHONE panel, and layout that
// overflows the screen is a hard reject — confirmed on Euchre v0.3.0 and Hearts
// v0.1.5. Two causes, both WebKit intrinsic-sizing behaviours Chromium does not
// model: a native <select> sizes to its LONGEST option rather than its
// container, and a wrapper without overflow-x has no last line of defence.
//
// Cue's settings page is far denser than the card games' — Worker URL, token,
// mode radios, a speaker selector, calibrate, idle timeout, session history —
// so it has more ways to overflow, not fewer.
//
// Prereq (one terminal):
//   npm run dev        # Vite on http://localhost:5176
// Then:
//   npm run test:webkit:layout

import { webkit } from 'playwright'

const URL = process.env.CUE_URL || 'http://localhost:5176'

const VIEWPORTS = [
  { name: 'iPhone SE', width: 320, height: 568 },
  { name: 'iPhone 14', width: 390, height: 844 },
  { name: 'iPhone 14 Pro Max', width: 430, height: 932 },
]

let pass = 0
let fail = 0
const failures = []
const ok = (l, d = '') => { pass++; console.log(`  ✓ ${l}${d ? ` — ${d}` : ''}`) }
const bad = (l, d = '') => { fail++; failures.push(l); console.log(`  ✗ ${l}${d ? ` — ${d}` : ''}`) }
const check = (l, c, d = '') => (c ? ok(l, d) : bad(l, d))

const browser = await webkit.launch({ headless: true })

try {
  for (const vp of VIEWPORTS) {
    console.log(`\n=== ${vp.name} (${vp.width}×${vp.height}) ===`)
    const ctx = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      deviceScaleFactor: 3,
      isMobile: true,
      hasTouch: true,
    })
    const page = await ctx.newPage()
    const errors = []
    page.on('pageerror', e => errors.push(e.message))

    try {
      await page.goto(URL, { waitUntil: 'load', timeout: 20_000 })
    } catch (err) {
      bad(`${vp.name}: page loads`, `${err.message.split('\n')[0]} (is \`npm run dev\` running?)`)
      await ctx.close()
      continue
    }
    await page.waitForSelector('main', { timeout: 10_000 }).catch(() => {})

    const m = await page.evaluate(() => {
      const doc = document.documentElement
      const main = document.querySelector('main')
      // Every control that can size itself past its container.
      const controls = Array.from(document.querySelectorAll('select, input, textarea, button'))
      const offenders = []
      for (const el of controls) {
        const r = el.getBoundingClientRect()
        if (r.width === 0 && r.height === 0) continue
        if (r.right > doc.clientWidth + 1) {
          offenders.push(`<${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}> to ${Math.round(r.right)}px`)
        }
      }
      // Widest element of any kind poking out, for a useful message.
      let widest = null
      for (const el of Array.from(document.body.querySelectorAll('*'))) {
        const r = el.getBoundingClientRect()
        if (r.width === 0 && r.height === 0) continue
        if (r.right > doc.clientWidth + 1 && (!widest || r.right > widest.right)) {
          widest = { tag: el.tagName.toLowerCase(), id: el.id, right: Math.round(r.right) }
        }
      }
      const sel = document.querySelector('select')
      return {
        title: document.title,
        scrollWidth: doc.scrollWidth,
        clientWidth: doc.clientWidth,
        mainOverflowX: main ? getComputedStyle(main).overflowX : null,
        selMaxWidth: sel ? getComputedStyle(sel).maxWidth : null,
        selBoxSizing: sel ? getComputedStyle(sel).boxSizing : null,
        hasMain: !!main,
        offenders,
        widest,
      }
    })

    check(`${vp.name}: phone panel rendered`, m.hasMain)

    check(
      `${vp.name}: no horizontal overflow`,
      m.scrollWidth <= m.clientWidth + 1,
      m.scrollWidth <= m.clientWidth + 1
        ? `${m.scrollWidth}px within ${m.clientWidth}px`
        : `scrollWidth ${m.scrollWidth} > ${m.clientWidth}` +
          (m.widest ? ` — widest <${m.widest.tag}${m.widest.id ? '#' + m.widest.id : ''}> to ${m.widest.right}px` : ''),
    )

    check(
      `${vp.name}: every form control stays in the viewport`,
      m.offenders.length === 0,
      m.offenders.length ? m.offenders.join(', ') : `${m.clientWidth}px`,
    )

    check(`${vp.name}: <main> keeps overflow-x hidden`, m.mainOverflowX === 'hidden', String(m.mainOverflowX))
    check(`${vp.name}: <select> constrained (max-width + border-box)`,
      m.selMaxWidth === '100%' && m.selBoxSizing === 'border-box',
      `max-width:${m.selMaxWidth} box-sizing:${m.selBoxSizing}`)
    check(`${vp.name}: no uncaught page errors`, errors.length === 0,
      errors.length ? errors[0].slice(0, 90) : 'clean')

    await ctx.close()
  }
} finally {
  await browser.close()
}

console.log(`\nResult: ${pass} passed, ${fail} failed`)
if (fail) {
  for (const f of failures) console.log(`  - ${f}`)
  process.exit(1)
}
