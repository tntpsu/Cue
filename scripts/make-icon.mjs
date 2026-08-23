#!/usr/bin/env node
// Generate a 24×24 monochrome PNG icon for an Even Hub plugin.
//
// Two input modes:
//   text:   1–3 chars centered using a built-in 5×7 bitmap font, x2 scaled
//           node make-icon.mjs --text "BJ" --out icon-24.png
//   ascii:  24-line ASCII bitmap in a file (`#` = white pixel, `.` = off)
//           node make-icon.mjs --ascii icon.txt --out icon-24.png
//
// Output: 24×24 8-bit grayscale + alpha PNG. White pixels (255) on transparent.

import { writeFileSync, readFileSync } from 'node:fs'
import { deflateSync } from 'node:zlib'

// ── 5×7 pixel font ────────────────────────────────────────────────────
// Each glyph is 5 columns × 7 rows, encoded as 7 strings of 5 chars
// (`#` = on, `.` = off). Top row is row 0.

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
  '?': ['.###.','#...#','....#','...#.','..#..','.....','..#..'],
  '!': ['..#..','..#..','..#..','..#..','..#..','.....','..#..'],
  '.': ['.....','.....','.....','.....','.....','.....','..#..'],
  '-': ['.....','.....','.....','#####','.....','.....','.....'],
  ' ': ['.....','.....','.....','.....','.....','.....','.....'],
}

// ── Args ──────────────────────────────────────────────────────────────

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, arr) => {
  if (v.startsWith('--')) a.push([v.slice(2), arr[i + 1]])
  return a
}, []))
const out = args.out || 'icon-24.png'
const text = args.text
const asciiFile = args.ascii

if (!text && !asciiFile) {
  console.error('usage: make-icon.mjs --text "BJ" --out icon-24.png')
  console.error('       make-icon.mjs --ascii icon.txt --out icon-24.png')
  process.exit(1)
}

// ── Build the 24×24 pixel grid ────────────────────────────────────────

const grid = Array.from({ length: 24 }, () => new Array(24).fill(0))

if (text) {
  // Render 1–3 chars at 2× scale (each glyph cell becomes 2×2 px)
  // Glyph: 5×7 → scaled: 10×14. Put 2 glyphs side-by-side (10+2+10 = 22, centered).
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
      // 2× scale
      for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
        const x = ox + c * 2 + dx, y = startY + r * 2 + dy
        if (x >= 0 && x < 24 && y >= 0 && y < 24) grid[y][x] = 1
      }
    }
  })
} else {
  // ASCII bitmap mode: 24 lines of `#`/`.`
  const raw = readFileSync(asciiFile, 'utf8').replace(/\r/g, '').split('\n').filter(l => l.length > 0)
  if (raw.length !== 24) { console.error(`✗ ascii file must have exactly 24 non-empty lines (got ${raw.length})`); process.exit(3) }
  for (let r = 0; r < 24; r++) {
    const line = raw[r]
    if (line.length !== 24) { console.error(`✗ line ${r + 1} must be 24 chars (got ${line.length})`); process.exit(4) }
    for (let c = 0; c < 24; c++) grid[r][c] = (line[c] === '#' || line[c] === '1') ? 1 : 0
  }
}

// ── Encode as PNG ─────────────────────────────────────────────────────
// PNG = magic + IHDR + IDAT + IEND. Use 8-bit grayscale + alpha so
// "off" pixels are fully transparent and "on" pixels are pure white.

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i]
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
  }
  return (c ^ 0xffffffff) >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0)
  const t = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0)
  return Buffer.concat([len, t, data, crc])
}

const W = 24, H = 24
// RGBA (color type 6, bit depth 8) — what HTML canvas's toBlob produces.
// On pixels: rgba(255,255,255,255). Off pixels: rgba(0,0,0,0) — transparent.
// Portal validator iterates pixels; it rejects anything that's not one of
// these two exact states.
const raw = Buffer.alloc(H * (1 + W * 4))
let i = 0
for (let r = 0; r < H; r++) {
  raw[i++] = 0
  for (let c = 0; c < W; c++) {
    if (grid[r][c]) { raw[i++] = 255; raw[i++] = 255; raw[i++] = 255; raw[i++] = 255 }
    else            { raw[i++] = 0;   raw[i++] = 0;   raw[i++] = 0;   raw[i++] = 0   }
  }
}

const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4)
ihdr[8] = 8        // bit depth: 8
ihdr[9] = 6        // color type 6 = RGBA
ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0

const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw)),
  chunk('IEND', Buffer.alloc(0)),
])

writeFileSync(out, png)
console.log(`✓ wrote ${out} (${W}×${H}, ${png.length} bytes)`)
