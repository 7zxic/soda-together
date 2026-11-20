// 测试用：模拟一个好友通过公共 MQTT 通道加入房间，打印收到的同步状态，并按脚本操作。
// 用法: node fake-friend.js <房间码> [--listen] [--emoji]
//       node fake-friend.js new [--emoji]      由模拟好友建房，打印房间码
//   --listen 只听不操作   --emoji 每隔一段时间发一个表情
//   环境变量: STAY_MS 停留时长, NAME 显示名称, BROKER 指定服务器
'use strict'
const WebSocket = require('ws')
const { webcrypto: crypto } = require('crypto')

const hostMode = process.argv[2] === 'new'
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const code = hostMode
  ? [...require('crypto').randomBytes(12)].map(b => CODE_CHARS[b & 31]).join('')
  : (process.argv[2] || '').toUpperCase().replace(/[^A-Z0-9]/g, '')
const listenOnly = hostMode || process.argv.includes('--listen')
const emojiMode = process.argv.includes('--emoji')
const NAME = process.env.NAME || '测试好友'
const STAY = Number(process.env.STAY_MS) || 30000
if (!code) { console.log('用法: node fake-friend.js <房间码> [--listen]'); process.exit(1) }
const BROKERS = process.env.BROKER ? [process.env.BROKER] : ['wss://broker-cn.emqx.io:8084/mqtt', 'wss://broker.emqx.io:8084/mqtt', 'wss://broker.hivemq.com:8884/mqtt']

const enc = new TextEncoder(), dec = new TextDecoder()
const cat = (...p) => Buffer.concat(p.map(x => Buffer.from(x)))
const u16 = n => Buffer.from([(n >> 8) & 255, n & 255])
const mstr = s => { const b = Buffer.from(typeof s === 'string' ? enc.encode(s) : s); return cat(u16(b.length), b) }
const varint = n => { const o = []; do { let d = n % 128; n = Math.floor(n / 128); if (n > 0) d |= 128; o.push(d) } while (n > 0); return Buffer.from(o) }
const packet = (h, ...parts) => { const b = cat(...parts); return cat([h], varint(b.length), b) }
const ts = () => new Date().toISOString().slice(11, 23)

async function roomCrypto(code) {
  const pw = await crypto.subtle.importKey('raw', enc.encode(code), 'PBKDF2', false, ['deriveBits'])
  const bits = new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode('soda-together/v2'), iterations: 300000 }, pw, 384))
  const key = await crypto.subtle.importKey('raw', bits.slice(0, 32), 'AES-GCM', false, ['encrypt', 'decrypt'])
  const base = 'sodatogether/v2/' + Buffer.from(bits.slice(32, 48)).toString('hex')
  const ad = enc.encode(base)
  return {
    base,
    async seal(o) { const iv = crypto.getRandomValues(new Uint8Array(12)); return cat(iv, new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: ad }, key, enc.encode(JSON.stringify(o))))) },
    async open(b) { if (!b || b.length < 29) return null; try { return JSON.parse(dec.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b.slice(0, 12), additionalData: ad }, key, b.slice(12)))) } catch { return null } },
  }
}

function connect(url, clientId, will) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, ['mqtt'], { handshakeTimeout: 7000 })
    let buf = Buffer.alloc(0)
    const c = {
      onMessage: null,
      sub(f) { ws.send(packet(0x82, u16(1), mstr(f), [0])) },
      pub(t, p, r) { ws.send(packet(0x30 | (r ? 1 : 0), mstr(t), p)) },
      close() { try { ws.send(Buffer.from([0xe0, 0])); ws.close() } catch {} },
    }
    ws.on('open', () => ws.send(packet(0x10, mstr('MQTT'), [4, 0x02 | 0x04 | 0x20], u16(120), mstr(clientId), mstr(will.topic), mstr(will.payload))))
    ws.on('message', d => {
      buf = cat(buf, d)
      for (;;) {
        if (buf.length < 2) return
        let len = 0, mul = 1, i = 1, b
        do { if (i >= buf.length) return; b = buf[i++]; len += (b & 127) * mul; mul *= 128 } while (b & 128)
        if (buf.length < i + len) return
        const type = buf[0] >> 4, flags = buf[0] & 15, body = buf.slice(i, i + len)
        buf = buf.slice(i + len)
        if (type === 2) body[1] === 0 ? resolve(c) : reject(new Error('rc ' + body[1]))
        if (type === 3) { const tl = (body[0] << 8) | body[1]; c.onMessage && c.onMessage(body.slice(2, 2 + tl).toString(), body.slice(2 + tl + (((flags >> 1) & 3) ? 2 : 0))) }
      }
    })
    ws.on('error', reject)
    setInterval(() => { try { ws.send(Buffer.from([0xc0, 0])) } catch {} }, 40000).unref()
  })
}

;(async () => {
  const cr = await roomCrypto(code)
  const you = 'fake' + Math.random().toString(36).slice(2, 8)
  const peers = new Map(), clocks = new Map()
  let state = null, client = null
  const off = id => (clocks.get(id) || { off: 0 }).off
  const expected = s => s.pos + (s.playing ? (Date.now() - (s.at - off(s.by))) / 1000 : 0)
  const show = (tag, s) => console.log(ts(), tag, s && s.track ? `《${s.track.name}》 ${s.playing ? '播放' : '暂停'} @${expected(s).toFixed(1)}s reason=${s.reason} cover=${s.track.cover ? 'ok' : 'none'}` : '')
  let seq = 0, evt = 0
  const send = async (sub, o, r) => client.pub(cr.base + '/' + sub, await cr.seal(o), r)
  const ev = o => send('e', { ...o, v: 2, from: you, n: ++evt, at: Date.now() })

  for (const url of BROKERS) {
    try { client = await connect(url, 'st-' + you, { topic: cr.base + '/m/' + you, payload: Buffer.alloc(0) }) } catch (e) { console.log('broker fail', url, e.message); continue }
    client.onMessage = async (topic, payload) => {
      const sub = topic.slice(cr.base.length + 1)
      if (sub.startsWith('m/')) {
        const id = sub.slice(2); if (id === you) return
        if (!payload.length) { peers.delete(id); console.log(ts(), '成员离开', id); return }
        const p = await cr.open(payload); if (!p) return
        if (!peers.has(id)) { console.log(ts(), '发现成员', p.name, id); for (let i = 0; i < 3; i++) setTimeout(() => ev({ t: 'ping', to: id, c: Date.now() }), i * 400) }
        peers.set(id, p); return
      }
      if (!payload.length) return
      const m = await cr.open(payload); if (!m) return
      if (sub === 's' && m.by !== you) {
        state = m; show('收到状态', m)
        // 建房模式下跟随对方：以自己的名义把同样的进度发回去，对方就处于「跟随好友」的状态
        if (hostMode) setTimeout(() => { if (state === m) act('跟随', { playing: m.playing, pos: expected(m), reason: 'seek' }) }, 1500)
      }
      if (sub === 'e' && m.from !== you) {
        if (m.t === 'ping' && m.to === you) ev({ t: 'pong', to: m.from, c: m.c, s: Date.now() })
        if (m.t === 'pong' && m.to === you) { const now = Date.now(), rtt = now - m.c; const c0 = clocks.get(m.from); if (!c0 || rtt <= c0.rtt) clocks.set(m.from, { off: m.s - (m.c + now) / 2, rtt }); }
        if (m.t === 'chat') console.log(ts(), '聊天', m.text)
      }
    }
    client.sub(cr.base + '/#')
    const t0 = Date.now()
    if (hostMode) { console.log(ts(), '已建房 @', url); console.log('\n  房间码：' + code.match(/.{4}/g).join('-') + '\n'); break }
    while (!peers.size && Date.now() - t0 < 2500) await new Promise(r => setTimeout(r, 100))
    if (peers.size) { console.log(ts(), '找到房间 @', url); break }
    console.log('这个通道上没有房间', url); client.close(); client = null
  }
  if (!client) { console.log('没找到房间'); process.exit(1) }
  const joinedAt = Date.now()
  const presence = () => send('m/' + you, { v: 2, id: you, name: NAME, avatar: '', joinedAt, ts: Date.now() }, true)
  await presence()
  setInterval(presence, 30000) // 在线心跳，否则对方 2.5 分钟后会认为已掉线
  if (emojiMode) {
    const list = ['❤️', '🎵', '👍']
    let i = 0
    setInterval(() => { if (peers.size) { const e = list[i++ % list.length]; console.log(ts(), '>> 发表情', e); ev({ t: 'chat', text: e }) } }, 20000)
  }

  const act = async (label, patch) => {
    if (!state) return
    state = { ...state, ...patch, at: Date.now(), by: you, seq: ++seq, v: 2 }
    show('>> ' + label, state)
    await send('s', state, true)
  }
  if (!listenOnly) {
    setTimeout(() => act('好友暂停', { playing: false, pos: expected(state), reason: 'pause' }), 6000)
    setTimeout(() => act('好友跳到 60 秒并播放', { playing: true, pos: 60, reason: 'seek' }), 10000)
    // 切到一首对方队列里可能没有的歌：只发 ID，测试对方用 GetTrackV2 自己取歌曲详情
    const SWITCH_ID = process.env.SWITCH_ID || '7703854342906169345'
    setTimeout(() => act('好友切歌（只发 ID）', { track: { id: SWITCH_ID, key: 'track-' + SWITCH_ID, name: '(由对方自己查询)', artist: '', cover: '', duration: 0 }, playing: true, pos: 5, reason: 'switch' }), 16000)
    setTimeout(() => { console.log('>> 好友发 ❤️'); ev({ t: 'chat', text: '❤️' }) }, 13000)
  }
  setTimeout(async () => {
    console.log(ts(), '>> 好友离开', 'clock', JSON.stringify([...clocks.values()]))
    client.pub(cr.base + '/m/' + you, Buffer.alloc(0), true)
    if (hostMode && !peers.size) client.pub(cr.base + '/s', Buffer.alloc(0), true)
    setTimeout(() => process.exit(0), 500)
  }, STAY)
})()
