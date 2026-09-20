#!/usr/bin/env node
// Generate the tray icon as a PNG, with no image library and no binary asset checked
// in that nobody can regenerate. Vault 06: muddy olive + blood red, the ENW mark with
// a ZOMBIES foot — at 32 px that reduces to an olive plate with a blood bar.
//
//   node tools/make-icons.js
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'

const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'renderer', 'assets')

function png(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0 // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4)
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body) >>> 0)
    return Buffer.concat([len, body, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

let TABLE = null
function crc32(buf) {
  if (!TABLE) {
    TABLE = new Int32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      TABLE[n] = c
    }
  }
  let c = -1
  for (const b of buf) c = TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return c ^ -1
}

function icon(size) {
  const px = Buffer.alloc(size * size * 4)
  const set = (x, y, [r, g, b, a = 255]) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return
    const i = (y * size + x) * 4
    px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = a
  }
  const OLIVE = [74, 79, 55]
  const OLIVE_HI = [107, 113, 80]
  const BONE = [221, 217, 200]
  const BLOOD = [140, 44, 34]
  const pad = Math.max(1, Math.round(size * 0.06))
  const r = Math.max(2, Math.round(size * 0.18))

  // Rounded olive plate.
  for (let y = pad; y < size - pad; y++) {
    for (let x = pad; x < size - pad; x++) {
      const dx = Math.min(x - pad, size - pad - 1 - x)
      const dy = Math.min(y - pad, size - pad - 1 - y)
      if (dx < r && dy < r) {
        const d = Math.hypot(r - dx, r - dy)
        if (d > r) continue
      }
      set(x, y, y < size / 2 ? OLIVE_HI : OLIVE)
    }
  }
  // The bone "E" bar block — the mark reduced to a legible shape at 16 px.
  const bx = Math.round(size * 0.26)
  const bw = Math.round(size * 0.48)
  const bh = Math.max(1, Math.round(size * 0.09))
  const gap = Math.max(1, Math.round(size * 0.08))
  let y0 = Math.round(size * 0.26)
  for (let k = 0; k < 3; k++) {
    const w = k === 1 ? Math.round(bw * 0.72) : bw
    for (let y = y0; y < y0 + bh; y++) for (let x = bx; x < bx + w; x++) set(x, y, BONE)
    y0 += bh + gap
  }
  // Blood foot rule = the ZOMBIES wordmark.
  const fy = Math.round(size * 0.74)
  for (let y = fy; y < fy + Math.max(1, Math.round(size * 0.08)); y++) {
    for (let x = bx; x < bx + bw; x++) set(x, y, BLOOD)
  }
  return png(size, size, px)
}

fs.mkdirSync(OUT, { recursive: true })
for (const size of [16, 32, 64, 256]) {
  const f = path.join(OUT, size === 32 ? 'tray.png' : `icon-${size}.png`)
  fs.writeFileSync(f, icon(size))
  console.log(`wrote ${f} (${size}x${size})`)
}
