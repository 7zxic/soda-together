// 生成安装器图标 installer/icon.ico：深灰圆（头像）+ 汽水绿圆（加号），和插件里的入口一致。
// 纯 Node 实现（自己光栅化 + PNG 编码），不依赖任何图片库。用法: node tools/make-icon.js
'use strict'
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')

function render(size) {
  const SS = 4 // 超采样抗锯齿
  const N = size * SS
  const px = new Float32Array(size * size * 4)
  const R = N * 0.30, cy = N * 0.5
  const a = { x: N * 0.36, y: cy, r: R }          // 左：头像圆
  const b = { x: N * 0.64, y: cy, r: R }          // 右：绿色加号圆
  const gap = N * 0.035                            // 右圆外圈的透明缝
  const plusL = R * 0.42, plusW = R * 0.13
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const fx = x + 0.5, fy = y + 0.5
      let c = null
      const db = Math.hypot(fx - b.x, fy - b.y)
      const da = Math.hypot(fx - a.x, fy - a.y)
      if (db <= b.r) {
        const dx = Math.abs(fx - b.x), dy = Math.abs(fy - b.y)
        const plus = (dx <= plusL && dy <= plusW) || (dy <= plusL && dx <= plusW)
        c = plus ? [255, 255, 255] : [0, 203, 100]
      } else if (db <= b.r + gap) {
        c = null // 缝隙：透明
      } else if (da <= a.r) {
        const t = (fx - (a.x - a.r)) / (2 * a.r)
        const v = Math.round(78 - 26 * t)
        c = [v, v, v + 6]
      }
      if (!c) continue
      const i = (Math.floor(y / SS) * size + Math.floor(x / SS)) * 4
      px[i] += c[0]; px[i + 1] += c[1]; px[i + 2] += c[2]; px[i + 3] += 1
    }
  }
  const out = Buffer.alloc(size * size * 4)
  for (let i = 0; i < size * size; i++) {
    const n = px[i * 4 + 3]
    if (!n) continue
    out[i * 4] = Math.round(px[i * 4] / n)
    out[i * 4 + 1] = Math.round(px[i * 4 + 1] / n)
    out[i * 4 + 2] = Math.round(px[i * 4 + 2] / n)
    out[i * 4 + 3] = Math.round(255 * n / (SS * SS))
  }
  return out
}

const crcTable = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c })
const crc32 = b => { let c = -1; for (const x of b) c = crcTable[(c ^ x) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0 }
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type), data])
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}
function png(size, rgba) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8; ihdr[9] = 6 // 8bit RGBA
  const raw = Buffer.alloc((size * 4 + 1) * size)
  for (let y = 0; y < size; y++) rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4)
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))])
}

const sizes = [16, 24, 32, 48, 64, 128, 256]
const images = sizes.map(s => png(s, render(s)))
const header = Buffer.alloc(6); header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(sizes.length, 4)
let offset = 6 + 16 * sizes.length
const dir = sizes.map((s, i) => {
  const e = Buffer.alloc(16)
  e[0] = s === 256 ? 0 : s; e[1] = s === 256 ? 0 : s
  e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6)
  e.writeUInt32LE(images[i].length, 8); e.writeUInt32LE(offset, 12)
  offset += images[i].length
  return e
})
const out = path.join(__dirname, '..', 'installer', 'icon.ico')
fs.writeFileSync(out, Buffer.concat([header, ...dir, ...images]))
fs.writeFileSync(path.join(__dirname, '..', 'installer', 'icon-256.png'), images[images.length - 1])
console.log('icon written:', out)
