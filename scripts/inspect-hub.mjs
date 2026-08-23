#!/usr/bin/env node
// Standalone Playwright-based inspector for the Even Hub developer portal
// at https://hub.evenrealities.com/hub. Replaces the CDP-attach approach
// (which required relaunching your normal Chrome with debug flags).
//
// Why this is the right tool:
//   - Launches Playwright's own bundled Chromium — your normal Chrome
//     stays untouched.
//   - Persistent storageState in .hub-portal-session.json — log in once,
//     all future runs are silent.
//   - On first run, leaves the window visible so you can log in by hand;
//     on subsequent runs it just navigates straight to the dev portal
//     and dumps the DOM.
//
// First run:
//   node scripts/inspect-hub.mjs
//   → window opens at https://hub.evenrealities.com/hub
//   → log in (Google / email / whatever the portal uses)
//   → once you're on the project list, return to the terminal and press Enter
//   → dump files written, browser closed
//
// Subsequent runs:
//   node scripts/inspect-hub.mjs            (uses saved session, no manual step)
//   node scripts/inspect-hub.mjs --headless (after the first login)
//
// Outputs:
//   inspect-hub.summary.txt   — URL, headings, every visible button/link
//                               with text + data-test attrs, project rows
//   inspect-hub.out           — full page HTML

import { chromium } from 'playwright-core'
import { existsSync, writeFileSync } from 'node:fs'

const HUB_URL = 'https://hub.evenrealities.com/hub'
// Session lives in $HOME so it's shared across all glasses-app repos
// (Cue, Glance, Pulse, lyrics-glow). Copying it cross-repo is blocked
// by sandbox defaults — keeping it in one canonical location avoids
// the propagation problem entirely.
const STORAGE_STATE = `${process.env.HOME}/.hub-portal-session.json`
const args = process.argv.slice(2)
const headless = args.includes('--headless')

async function main() {
  console.log(`→ Inspecting ${HUB_URL}`)
  console.log(`  Mode: ${headless ? 'headless' : 'headed'}`)
  console.log(`  Session: ${existsSync(STORAGE_STATE) ? 'reusing ' + STORAGE_STATE : 'first run — log in manually when window opens'}`)

  const browser = await chromium.launch({ headless })
  const context = existsSync(STORAGE_STATE)
    ? await browser.newContext({ storageState: STORAGE_STATE })
    : await browser.newContext()
  const page = await context.newPage()

  await page.goto(HUB_URL, { waitUntil: 'networkidle' }).catch(() => {})

  // If first run (no session), poll for login completion. We watch the
  // URL — when it lands back on /hub (or any hub.evenrealities.com path
  // that isn't a login/oauth page) AND the page has a project-list
  // indicator, we're in. 5-minute deadline.
  if (!existsSync(STORAGE_STATE)) {
    if (headless) {
      console.error('✗ --headless cannot be used for first login. Re-run without --headless.')
      await browser.close()
      process.exit(2)
    }
    console.log('')
    console.log('  Window opened. Log in via the browser — when you reach the')
    console.log('  project list page, this script auto-captures and exits.')
    console.log('  (5-minute deadline.)')
    console.log('')
    const deadline = Date.now() + 5 * 60_000
    let polledOnce = false
    while (Date.now() < deadline) {
      await page.waitForTimeout(2_000)
      const u = page.url()
      const onHub = u.startsWith('https://hub.evenrealities.com')
        && !u.includes('/login')
        && !u.includes('/oauth')
        && !u.includes('/auth')
      if (!onHub) continue
      // Detection: URL is on /hub (the post-login destination) AND no
      // password input is present. Earlier heuristic tripped on the login
      // page's UI panel classes ("card"), saving an empty STORAGE_STATE
      // before the user could finish logging in. A "Logout" affordance was
      // too strict — the portal hides it behind a profile menu.
      const loggedIn = await page.evaluate(() => {
        const urlOk = location.pathname.startsWith('/hub')
        const hasPasswordField = document.querySelector('input[type="password"]') !== null
        return urlOk && !hasPasswordField
      }).catch(() => false)
      if (loggedIn) break
      if (!polledOnce) {
        console.log(`  Polling… (last URL: ${u})`)
        polledOnce = true
      }
    }
    if (Date.now() >= deadline) {
      console.error('✗ Login deadline exceeded.')
      await browser.close()
      process.exit(3)
    }
    await context.storageState({ path: STORAGE_STATE })
    console.log(`  Session saved to ${STORAGE_STATE}`)
  }

  // Make sure we're on the hub URL after any post-login redirect.
  if (!page.url().startsWith('https://hub.evenrealities.com')) {
    await page.goto(HUB_URL, { waitUntil: 'networkidle' }).catch(() => {})
  }
  // Allow SPA hydration time.
  await page.waitForTimeout(2_000)

  const url = page.url()
  const title = await page.title()
  console.log(`  Captured URL:   ${url}`)
  console.log(`  Captured title: ${title}`)

  // Pull every visible interactive element.
  const visibleControls = await page.evaluate(() => {
    function trim(s) { return (s ?? '').replace(/\s+/g, ' ').trim() }
    function isVisible(el) {
      const r = el.getBoundingClientRect()
      const s = getComputedStyle(el)
      return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'
    }
    const out = []
    for (const el of document.querySelectorAll('button, a, [role="button"], input[type="submit"], input[type="file"], [class*="card" i], [class*="project" i], [class*="app" i]')) {
      if (!isVisible(el)) continue
      out.push({
        tag: el.tagName.toLowerCase(),
        type: el.getAttribute('type'),
        role: el.getAttribute('role'),
        text: trim(el.textContent ?? '').slice(0, 100),
        ariaLabel: el.getAttribute('aria-label'),
        dataTest: el.getAttribute('data-test') ?? el.getAttribute('data-testid'),
        href: el.getAttribute('href'),
        cls: (el.getAttribute('class') ?? '').slice(0, 80),
      })
    }
    return out
  })

  const headings = await page.evaluate(() => {
    const out = []
    for (const el of document.querySelectorAll('h1, h2, h3, h4, [role="heading"]')) {
      const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim()
      if (text) out.push({ tag: el.tagName.toLowerCase(), text: text.slice(0, 120) })
    }
    return out
  })

  const html = await page.content()

  const summary = [
    `URL:   ${url}`,
    `Title: ${title}`,
    '',
    '─── Headings ────────────────────────────',
    ...headings.map(h => `  <${h.tag}> ${h.text}`),
    '',
    `─── Visible buttons / links / cards (${visibleControls.length}) ───`,
    ...visibleControls.map(c => {
      const bits = [c.tag]
      if (c.type) bits.push(`type=${c.type}`)
      if (c.role) bits.push(`role=${c.role}`)
      if (c.dataTest) bits.push(`data-test=${c.dataTest}`)
      if (c.cls) bits.push(`class="${c.cls}"`)
      if (c.href) bits.push(`href=${c.href}`)
      const head = `  ${bits.join(' ')}`
      const txt = c.text ? `    text=${JSON.stringify(c.text)}` : ''
      return `${head}${txt ? '\n' + txt : ''}`
    }),
  ].join('\n')

  writeFileSync('inspect-hub.summary.txt', summary)
  writeFileSync('inspect-hub.out', html)

  console.log('')
  console.log(`✓ Wrote inspect-hub.summary.txt (${summary.length} chars)`)
  console.log(`✓ Wrote inspect-hub.out         (${(html.length / 1024).toFixed(0)} KB HTML)`)

  await context.storageState({ path: STORAGE_STATE })
  await browser.close()
}

function waitForEnter() {
  return new Promise(resolve => {
    process.stdin.once('data', () => resolve())
    process.stdout.write('  Press Enter when ready... ')
  })
}

main().catch(err => {
  console.error('✗ Inspector failed:', err.message)
  process.exit(1)
})
