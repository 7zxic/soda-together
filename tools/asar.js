// Minimal asar reader/writer (no dependencies).
// Format: [u32 4][u32 headerPickleSize] [u32 payloadSize][u32 jsonLen][json + pad4] [file data...]
'use strict'
const fs = require('fs')
const crypto = require('crypto')

const BLOCK_SIZE = 4 * 1024 * 1024

function readAsar(file) {
  const buf = fs.readFileSync(file)
  const headerPickleSize = buf.readUInt32LE(4)
  const jsonLen = buf.readUInt32LE(12)
  const header = JSON.parse(buf.slice(16, 16 + jsonLen).toString('utf8'))
  const dataBase = 8 + headerPickleSize
  const files = new Map() // path -> { data?: Buffer, entry }
  ;(function walk(node, prefix) {
    for (const name of Object.keys(node.files)) {
      const e = node.files[name]
      const p = prefix ? prefix + '/' + name : name
      if (e.files) { walk(e, p); continue }
      if (e.link) { files.set(p, { entry: e }); continue }
      if (e.unpacked) { files.set(p, { entry: e }); continue }
      const off = dataBase + Number(e.offset)
      files.set(p, { entry: e, data: buf.slice(off, off + e.size) })
    }
  })(header, '')
  return { header, files }
}

function integrity(data) {
  const blocks = []
  for (let i = 0; i < data.length; i += BLOCK_SIZE) {
    blocks.push(crypto.createHash('sha256').update(data.slice(i, i + BLOCK_SIZE)).digest('hex'))
  }
  if (blocks.length === 0) blocks.push(crypto.createHash('sha256').update(Buffer.alloc(0)).digest('hex'))
  return {
    algorithm: 'SHA256',
    hash: crypto.createHash('sha256').update(data).digest('hex'),
    blockSize: BLOCK_SIZE,
    blocks,
  }
}

// files: Map<path, { entry, data? }>. Entries with data are re-laid out sequentially.
function writeAsar(file, files) {
  const root = { files: {} }
  const chunks = []
  let offset = 0
  for (const [p, f] of files) {
    const parts = p.split('/')
    let node = root
    for (const dir of parts.slice(0, -1)) {
      node.files[dir] = node.files[dir] || { files: {} }
      node = node.files[dir]
    }
    const name = parts[parts.length - 1]
    if (!f.data) { node.files[name] = f.entry; continue }
    const e = { ...f.entry, size: f.data.length, offset: String(offset), integrity: integrity(f.data) }
    delete e.unpacked
    node.files[name] = e
    chunks.push(f.data)
    offset += f.data.length
  }
  const json = Buffer.from(JSON.stringify(root), 'utf8')
  const pad = (4 - (json.length % 4)) % 4
  const headerPickle = Buffer.alloc(8 + json.length + pad)
  headerPickle.writeUInt32LE(4 + json.length + pad, 0)
  headerPickle.writeUInt32LE(json.length, 4)
  json.copy(headerPickle, 8)
  const sizePickle = Buffer.alloc(8)
  sizePickle.writeUInt32LE(4, 0)
  sizePickle.writeUInt32LE(headerPickle.length, 4)
  const tmp = file + '.tmp'
  const fd = fs.openSync(tmp, 'w')
  fs.writeSync(fd, sizePickle)
  fs.writeSync(fd, headerPickle)
  for (const c of chunks) fs.writeSync(fd, c)
  fs.closeSync(fd)
  fs.renameSync(tmp, file)
}

module.exports = { readAsar, writeAsar }
