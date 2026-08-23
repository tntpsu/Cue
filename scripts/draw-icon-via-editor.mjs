#!/usr/bin/env node
// Draw a 24×24 icon by clicking cells in the portal's pixel editor canvas.
// Bypasses the failing direct-PNG-upload path. Uses the editor's own
// canvas → PNG conversion, which the validator accepts (since that's what
// the pixel editor itself produces).
//
// Prereq: the pixel editor (Edit basic info → Create with a tool) is OPEN
// in the user's debug Chrome (port 9222), and on a clean grid. The script
// will click Clear first to be safe.
//
// Usage:
//   node draw-icon-via-editor.mjs --text "BJ"
//   node draw-icon-via-editor.mjs --ascii path/to/icon.txt

import { chromium } from 'playwright-core'
import { readFileSync } from 'node:fs'

const FONT = {
  '0': ['.###.','#...#','#...#','#...#','#...#','#...#','.###.'],
  '1': ['..#..','.##..','..#..','..#..','..#..','..#..','.###.'],
  '2': ['.###.','#...#','....#','...#.','..#..','.#...','#####'],
  '3': ['.###.','#...#','....#','..##.','....#','#...#','.###.'],
  '4': ['#...#','#...#','#...#','#####','....#','....#','....#'],
  '5': ['#####','#....','####.','....#','....#','#...#','.###.'],
  '6': ['.###.','#...#','#....','####.','#...#','#...#','.###.'],
  '7': ['#####','....#','...#.','..#..','.#...','.#...','.#...'],
  '8': ['.###.','#...#','#...#','.###.','#...#','#...#','.###.'],
  '9': ['.###.','#...#','#...#','.####','....#','#...#','.###.'],
  'A': ['.###.','#...#','#...#','#####','#...#','#...#','#...#'],
  'B': ['####.','#...#','#...#','####.','#...#','#...#','####.'],
  'C': ['.###.','#...#','#....','#....','#....','#...#','.###.'],
  'D': ['####.','#...#','#...#','#...#','#...#','#...#','####.'],
  'E': ['#####','#....','#....','####.','#....','#....','#####'],
  'F': ['#####','#....','#....','####.','#....','#....','#....'],
  'G': ['.###.','#...#','#....','#.###','#...#','#...#','.####'],
  'H': ['#...#','#...#','#...#','#####','#...#','#...#','#...#'],
  'I': ['.###.','..#..','..#..','..#..','..#..','..#..','.###.'],
  'J': ['..###','...#.','...#.','...#.','...#.','#..#.','.##..'],
  'K': ['#...#','#..#.','#.#..','##...','#.#..','#..#.','#...#'],
  'L': ['#....','#....','#....','#....','#....','#....','#####'],
  'M': ['#...#','##.##','#.#.#','#...#','#...#','#...#','#...#'],
  'N': ['#...#','##..#','#.#.#','#..##','#...#','#...#','#...#'],
  'O': ['.###.','#...#','#...#','#...#','#...#','#...#','.###.'],
  'P': ['####.','#...#','#...#','####.','#....','#....','#....'],
  'Q': ['.###.','#...#','#...#','#...#','#.#.#','#..##','.####'],
  'R': ['####.','#...#','#...#','####.','#.#..','#..#.','#...#'],
  'S': ['.####','#....','#....','.###.','....#','....#','####.'],
  'T': ['#####','..#..','..#..','..#..','..#..','..#..','..#..'],
  'U': ['#...#','#...#','#...#','#...#','#...#','#...#','.###.'],
  'V': ['#...#','#...#','#...#','#...#','#...#','.#.#.','..#..'],
  'W': ['#...#','#...#','#...#','#...#','#.#.#','##.##','#...#'],
  'X': ['#...#','#...#','.#.#.','..#..','.#.#.','#...#','#...#'],
  'Y': ['#...#','#...#','.#.#.','..#..','..#..','..#..','..#..'],
  'Z': ['#####','....#','...#.','..#..','.#...','#....','#####'],
  ' ': ['.....','.....','.....','.....','.....','.....','.....'],
}

function gridFromText(text) {
  const grid = Array.from({ length: 24 }, () => new Array(24).fill(0))
  const chars = text.toUpperCase().split('').slice(0, 3)
  const glyphW = 10, gap = 2, glyphH = 14
  const totalW = chars.length * glyphW + (chars.length - 1) * gap
  const startX = Math.floor((24 - totalW) / 2)
  const startY = Math.floor((24 - glyphH) / 2)
  chars.forEach((ch, idx) => {
    const g = FONT[ch]
    if (!g) { console.error(`✗ no glyph for "${ch}"`); process.exit(2) }
    const ox = startX + idx * (glyphW + gap)
    for (let r = 0; r < 7; r++) for (let c = 0; c < 5; c++) {
      if (g[r][c] !== '#') continue
      for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
        const x = ox + c * 2 + dx, y = startY + r * 2 + dy
        if (x >= 0 && x < 24 && y >= 0 && y < 24) grid[y][x] = 1
      }
    }
  })
  return grid
}

function gridFromAscii(file) {
  const lines = readFileSync(file, 'utf8').replace(/\r/g, '').split('\n').filter(l => l.length > 0)
  if (lines.length !== 24) { console.error(`✗ ascii must have 24 lines (got ${lines.length})`); process.exit(3) }
  return lines.map(line => {
    if (line.length !== 24) { console.error(`✗ each line must be 24 chars (got ${line.length})`); process.exit(4) }
    return line.split('').map(ch => (ch === '#' || ch === '1') ? 1 : 0)
  })
}

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, arr) => {
  if (v.startsWith('--')) a.push([v.slice(2), arr[i + 1]])
  return a
}, []))

let grid
if (args.text) grid = gridFromText(args.text)
else if (args.ascii) grid = gridFromAscii(args.ascii)
else { console.error('usage: --text "BJ"  or  --ascii path/to/file'); process.exit(1) }

const onCount = grid.flat().filter(x => x === 1).length
console.log(`will click ${onCount} cells`)

const browser = await chromium.connectOverCDP('http://localhost:9222')
const ctx = browser.contexts()[0]
const page = ctx.pages().find(p => p.url().includes('hub.evenrealities.com')) || ctx.pages()[0]

const editor = page.locator('[role="dialog"][data-state="open"]').last()
const canvas = editor.locator('canvas').first()
const box = await canvas.boundingBox()
if (!box) { console.error('✗ canvas not found — is the pixel editor open?'); process.exit(5) }
const cell = box.width / 24
console.log(`canvas at (${box.x}, ${box.y}), ${box.width}x${box.height}, cell=${cell}`)

// 1) Clear
console.log('clicking Clear…')
await editor.locator('button:has-text("Clear")').click()
await page.waitForTimeout(500)

// 2) Make sure Draw is active. The button list is [Clear, 2x2, Draw, Erase, Cancel, Confirm].
//    "2x2" toggles brush size; we want 1x1 (default after Clear, hopefully).
//    "Draw" mode (vs Erase). After Clear, Draw should be active. Click it to be safe.
console.log('clicking Draw to ensure paint mode…')
await editor.locator('button:has-text("Draw")').click()
await page.waitForTimeout(300)

// 3) Click every "on" cell. Click center of cell.
let clicked = 0
for (let r = 0; r < 24; r++) {
  for (let c = 0; c < 24; c++) {
    if (!grid[r][c]) continue
    const x = box.x + c * cell + cell / 2
    const y = box.y + r * cell + cell / 2
    await page.mouse.click(x, y, { delay: 5 })
    clicked++
    if (clicked % 30 === 0) {
      console.log(`  ${clicked}/${onCount}…`)
      await page.waitForTimeout(50)
    }
  }
}
console.log(`clicked ${clicked} cells. Pausing 1s before screenshot…`)
await page.waitForTimeout(1000)

await page.screenshot({ path: '/tmp/editor-painted.png' })
console.log('screenshot saved → /tmp/editor-painted.png')
console.log('NOT clicking Confirm yet — review the screenshot, then click Confirm manually.')

await browser.close().catch(() => {})
