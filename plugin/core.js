// 一起听 - 核心逻辑（同步 + 界面）。依赖 together.js 提供的 window.__sodaTogether
;(function (ST) {
  if (!ST) return
  installAudioTap(ST)
  // 打包进汽水时，本文件比汽水自己的服务先执行，所以等界面挂载好再启动
  ST.whenAppReady ? ST.whenAppReady().then(() => boot(ST)) : boot(ST)
})(window.__sodaTogether)

// 在汽水的音频源上并联一个频谱分析器（取音量调节之前的信号），供音柱跟着音乐跳动。
// 汽水每次切歌都会重新 connect 音频源，所以拦截 connect 就能接上。
function installAudioTap(ST) {
  if (ST.audioTap) return
  const tap = ST.audioTap = { analyser: null, ctx: null, data: null }
  const origConnect = AudioNode.prototype.connect
  AudioNode.prototype.connect = function (dest, ...rest) {
    const ret = origConnect.call(this, dest, ...rest)
    try {
      if (typeof MediaElementAudioSourceNode !== 'undefined' && this instanceof MediaElementAudioSourceNode && dest !== tap.analyser) {
        if (!tap.analyser || tap.ctx !== this.context) {
          tap.ctx = this.context
          tap.analyser = this.context.createAnalyser()
          tap.analyser.fftSize = 256
          tap.analyser.smoothingTimeConstant = 0.6
          tap.data = new Uint8Array(tap.analyser.frequencyBinCount)
        }
        origConnect.call(this, tap.analyser)
        tap.media = this.mediaElement || null
      }
    } catch (e) {}
    return ret
  }
}

function boot(ST) {
  if (ST.core && ST.core.dispose) { try { ST.core.dispose() } catch (e) { ST.log('dispose err', String(e)) } }

  const core = { disposers: [] }
  ST.core = core
  const onDispose = fn => core.disposers.push(fn)
  core.dispose = () => { core.disposers.splice(0).reverse().forEach(fn => { try { fn() } catch {} }) }
  const every = (fn, ms) => { const id = setInterval(fn, ms); onDispose(() => clearInterval(id)) }
  const sleep = ms => new Promise(r => setTimeout(r, ms))
  const log = (...a) => ST.log(...a)

  // ---------------- 配置 ----------------
  const LS = {
    get(k, d) { try { const v = localStorage.getItem("sodaTogether." + k); return v === null ? d : v } catch { return d } },
    set(k, v) { try { localStorage.setItem("sodaTogether." + k, v) } catch {} },
  }

  // 调试框只在开发时有内容
  Object.keys(ST.results).forEach(k => delete ST.results[k])

  // ---------------- 本地播放器状态 ----------------
  const local = { mediaId: null, isPlaying: false, isLoading: false, pos: 0, duration: 0, t: Date.now() }
  const localPos = () => local.pos + (local.isPlaying && !local.isLoading ? (Date.now() - local.t) / 1000 : 0)
  let playerHandler = null
  const waiters = new Set()
  core.onPlayer = v => {
    playerHandler && playerHandler(v)
    waiters.forEach(w => { if (w.cond()) { waiters.delete(w); w.resolve(true) } })
  }
  // 等到播放器状态满足条件（由状态推送驱动，窗口最小化时也不会被定时器限速拖慢）
  function waitFor(cond, ms) {
    if (cond()) return Promise.resolve(true)
    return new Promise(resolve => {
      const w = { cond, resolve }
      waiters.add(w)
      setTimeout(() => { if (waiters.delete(w)) resolve(cond()) }, ms)
    })
  }
  onDispose(() => waiters.forEach(w => w.resolve(false)))
  // sharedState 订阅无法取消，所以只订阅一次，通过 ST.core.onPlayer 分发给当前实例
  if (!ST.__playerSubscribed) {
    ST.__playerSubscribed = true
    ST.invoke('sharedState', 'onUpdate', ['player', (v) => { ST.core && ST.core.onPlayer && ST.core.onPlayer(v) }, true]).catch(e => { ST.__playerSubscribed = false; log('subscribe err', e.message) })
  } else {
    ST.invoke('sharedState', 'get', ['player']).then(v => core.onPlayer(v)).catch(() => {})
  }

  // 汽水的图片地址是拆开存的（前缀 + uri + 模板），按它自己的 getImageUrl 规则拼起来
  function imageUrl(u, size = 120) {
    if (!u) return ''
    if (typeof u === 'string') return u
    const base = u.urls && u.urls[0]
    if (u.uri && base) return `${base}${u.uri}~${u.template_prefix ? `${u.template_prefix}-crop-center:${size}:${size}.jpg` : `c5_${size}x${size}.jpg`}`
    return base || ''
  }
  const coverOf = p => imageUrl(p.cover_url || (p.track && p.track.album && p.track.album.url_cover) || (p.album && p.album.url_cover))

  async function currentPlayable() {
    const q = await ST.invoke('sharedState', 'get', ['queue'])
    const cur = q && q.queue && q.queue.currentPlayable
    if (!cur || !cur.key) return null
    return q.queue.playables.byKey[cur.key] || null
  }

  async function myProfile() {
    try {
      const u = await ST.invoke('sharedState', 'get', ['user'])
      const mi = u && u.info && u.info.my_info
      if (mi) {
        const pick = (...ks) => { for (const k of ks) { const v = mi[k]; if (typeof v === 'string' && v) return v; if (v && Array.isArray(v.urls) && v.urls[0]) return v.urls[0]; if (v && v.url_list && v.url_list[0]) return v.url_list[0] } return '' }
        return { name: pick('nickname', 'name', 'user_name') || '汽水用户', avatar: pick('medium_avatar_url', 'avatar_url', 'avatar_thumb', 'avatar', 'avatar_medium', 'thumb_url') }
      }
    } catch {}
    return { name: '汽水用户', avatar: '' }
  }

  // ---------------- 网络 ----------------
  const DEFAULT_BROKERS = [
    'wss://broker-cn.emqx.io:8084/mqtt',
    'wss://broker.emqx.io:8084/mqtt',
    'wss://broker.hivemq.com:8884/mqtt',
  ]
  // 高级设置里可以填自己的服务器（MQTT over WebSocket），双方填同一个地址即可
  const customBroker = () => LS.get('broker', '')
  const brokers = () => customBroker() ? [customBroker()] : DEFAULT_BROKERS
  const enc = new TextEncoder(), dec = new TextDecoder()
  const cat = (...parts) => {
    const arrs = parts.map(p => p instanceof Uint8Array ? p : Uint8Array.from(p))
    const out = new Uint8Array(arrs.reduce((n, a) => n + a.length, 0))
    let o = 0
    for (const a of arrs) { out.set(a, o); o += a.length }
    return out
  }
  const u16 = n => Uint8Array.from([(n >> 8) & 255, n & 255])
  const mstr = s => { const b = typeof s === 'string' ? enc.encode(s) : s; return cat(u16(b.length), b) }
  const varint = n => { const out = []; do { let d = n % 128; n = Math.floor(n / 128); if (n > 0) d |= 128; out.push(d) } while (n > 0); return out }
  const packet = (h, ...parts) => { const body = cat(...parts); return cat([h], varint(body.length), body) }

  // 极简 MQTT 3.1.1 客户端（只用 QoS 0）
  function mqttConnect(url, clientId, will) {
    return new Promise((resolve, reject) => {
      let ws
      try { ws = new WebSocket(url, ['mqtt']) } catch (e) { return reject(e) }
      ws.binaryType = 'arraybuffer'
      let buf = new Uint8Array(0), done = false, pid = 1, pinger = null, lastRx = Date.now()
      const client = {
        url, onMessage: null, onClose: null,
        send(b) { if (ws.readyState === 1) ws.send(b) },
        subscribe(filter) { pid = (pid % 65535) + 1; client.send(packet(0x82, u16(pid), mstr(filter), [0])) },
        publish(topic, payload, retain) { client.send(packet(0x30 | (retain ? 1 : 0), mstr(topic), payload)) },
        close() { try { client.send(Uint8Array.from([0xe0, 0])) } catch {} try { ws.close() } catch {} },
      }
      const timer = setTimeout(() => { if (!done) { done = true; reject(new Error('连接超时')); try { ws.close() } catch {} } }, 7000)
      ws.onopen = () => {
        let flags = 0x02
        let payload = mstr(clientId)
        if (will) { flags |= 0x04 | 0x20; payload = cat(payload, mstr(will.topic), mstr(will.payload)) }
        client.send(packet(0x10, mstr('MQTT'), [4, flags], u16(120), payload))
      }
      ws.onmessage = (ev) => {
        lastRx = Date.now()
        buf = cat(buf, new Uint8Array(ev.data))
        for (;;) {
          if (buf.length < 2) break
          let len = 0, mul = 1, i = 1, byte
          do { if (i >= buf.length) return; byte = buf[i++]; len += (byte & 127) * mul; mul *= 128 } while (byte & 128)
          if (buf.length < i + len) break
          const type = buf[0] >> 4, flags = buf[0] & 15, body = buf.slice(i, i + len)
          buf = buf.slice(i + len)
          if (type === 2) {
            clearTimeout(timer)
            if (body[1] === 0) {
              done = true
              pinger = setInterval(() => {
                if (Date.now() - lastRx > 60000) { try { ws.close() } catch {} return }
                client.send(Uint8Array.from([0xc0, 0]))
              }, 20000)
              resolve(client)
            } else if (!done) { done = true; reject(new Error('服务器拒绝连接 ' + body[1])); ws.close() }
          } else if (type === 3) {
            const tl = (body[0] << 8) | body[1]
            const topic = dec.decode(body.slice(2, 2 + tl))
            const off = 2 + tl + (((flags >> 1) & 3) > 0 ? 2 : 0)
            try { client.onMessage && client.onMessage(topic, body.slice(off), !!(flags & 1)) } catch (e) { log('mqtt msg err', String(e)) }
          }
        }
      }
      ws.onerror = () => {}
      ws.onclose = () => {
        clearTimeout(timer); clearInterval(pinger)
        if (!done) { done = true; reject(new Error('无法连接')) }
        client.onClose && client.onClose()
      }
    })
  }

  // ---------------- 房间通道 ----------------
  const PROTOCOL = 2
  const hex = b => [...b].map(x => x.toString(16).padStart(2, '0')).join('')
  async function roomCrypto(code) {
    const pw = await crypto.subtle.importKey('raw', enc.encode(code), 'PBKDF2', false, ['deriveBits'])
    const bits = new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode('soda-together/v2'), iterations: 300000 }, pw, 384))
    const key = await crypto.subtle.importKey('raw', bits.slice(0, 32), 'AES-GCM', false, ['encrypt', 'decrypt'])
    const base = 'sodatogether/v2/' + hex(bits.slice(32, 48))
    return {
      base,
      async seal(obj) {
        const iv = crypto.getRandomValues(new Uint8Array(12))
        const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(base) }, key, enc.encode(JSON.stringify(obj))))
        return cat(iv, ct)
      },
      async open(bytes) {
        if (!bytes || bytes.length < 29) return null
        try {
          const v = JSON.parse(dec.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12), additionalData: enc.encode(base) }, key, bytes.slice(12))))
          return v && typeof v === 'object' && !Array.isArray(v) ? v : null
        } catch { return null }
      },
    }
  }

  // ---------------- 消息格式 ----------------
  const MAX_BYTES = { m: 2048, s: 4096, e: 1024 }
  const ID_RE = /^[a-z0-9]{6,16}$/
  const TRACK_ID_RE = /^\d{1,25}$/
  const REASONS = new Set(['create', 'switch', 'next', 'play', 'pause', 'seek'])
  const IMG_HOST_RE = /(^|\.)(douyinpic\.com|byteimg\.com|douyinstatic\.com|pstatp\.com|bytecdn\.cn|byteacctimg\.com)$/i
  const isNum = (v, lo, hi) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi
  const cleanStr = (v, max) => typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '').trim().slice(0, max) : ''
  function safeImg(u) {
    if (typeof u !== 'string' || u.length > 1500) return ''
    try { const x = new URL(u); return x.protocol === 'https:' && IMG_HOST_RE.test(x.hostname) ? x.href : '' } catch { return '' }
  }
  const nearNow = (t, id, slackMs) => isNum(t, 0, 1e14) && Math.abs(Date.now() - (t - offOf(id))) < slackMs

  function checkPresence(p, id) {
    if (!p || p.v !== PROTOCOL || p.id !== id || !ID_RE.test(id)) return null
    if (!isNum(p.joinedAt, 0, 1e14) || !nearNow(p.ts, id, 24 * 3600e3)) return null
    return { id, name: cleanStr(p.name, 32) || '好友', avatar: safeImg(p.avatar), joinedAt: p.joinedAt, ts: p.ts }
  }
  function checkState(m) {
    if (!m || m.v !== PROTOCOL || !ID_RE.test(m.by || '') || !REASONS.has(m.reason)) return null
    const t = m.track
    if (!t || typeof t !== 'object' || !TRACK_ID_RE.test(t.id || '')) return null
    if (typeof m.playing !== 'boolean' || !isNum(m.pos, 0, 36000) || !isNum(m.seq, 1, 1e12)) return null
    if (!isNum(m.at, 0, 1e14)) return null
    return {
      v: PROTOCOL, by: m.by, seq: m.seq, reason: m.reason, playing: m.playing, pos: m.pos, at: m.at,
      track: { id: t.id, key: 'track-' + t.id, name: cleanStr(t.name, 200), artist: cleanStr(t.artist, 200), cover: safeImg(t.cover), duration: isNum(t.duration, 0, 36000) ? t.duration : 0 },
    }
  }

  const limits = new Map() // id -> { tokens, t, lastSeq, lastEvt }
  function allow(id, cost = 1) {
    const now = Date.now()
    let l = limits.get(id)
    if (!l) limits.set(id, l = { tokens: 20, t: now, lastSeq: 0, lastEvt: 0 })
    l.tokens = Math.min(20, l.tokens + (now - l.t) / 500) // 每秒恢复 2 个，最多攒 20 个
    l.t = now
    if (l.tokens < cost) return false
    l.tokens -= cost
    return true
  }

  // ---------------- 房间 / 成员 / 时钟同步 ----------------
  const conn = { client: null, open: false, rtt: 0, broker: '' }
  const room = { code: null, you: null, hostId: null, members: [], state: null, stateAt: 0, crypto: null, joinedAt: 0 }
  const peers = new Map()   // id -> { id, name, avatar, joinedAt, ts }
  const clocks = new Map()  // id -> { off: 对方时钟-我的时钟, rtt }
  const offOf = id => (id && id !== room.you && clocks.get(id)) ? clocks.get(id).off : 0
  const isHost = () => room.code && room.you === room.hostId
  const otherIds = () => [...peers.keys()].filter(id => id !== room.you)
  let profileCache = null
  const profile = async () => profileCache || (profileCache = await myProfile())
  let quietUntil = 0 // 刚加入时不弹「xx 加入了」
  let mySeq = 0, myEvt = 0

  async function publish(sub, obj, retain) {
    const c = room.crypto, cl = conn.client
    if (!c || !cl || !conn.open) return false
    cl.publish(c.base + '/' + sub, obj === null ? new Uint8Array(0) : await c.seal(obj), retain)
    return true
  }
  // 断线期间自己的操作：重连后再决定要不要补发
  let offlinePending = null
  let resyncing = false
  const sendEvent = obj => publish('e', { ...obj, v: PROTOCOL, from: room.you, n: ++myEvt, at: Date.now() })
  async function publishPresence() {
    const p = await profile()
    await publish('m/' + room.you, { v: PROTOCOL, id: room.you, name: p.name, avatar: safeImg(p.avatar), joinedAt: room.joinedAt, ts: Date.now() }, true)
  }

  function recomputeMembers() {
    const now = Date.now()
    for (const [id, p] of peers) if (now - (p.ts - offOf(id)) > 150000) peers.delete(id)
    const meP = { id: room.you, name: (profileCache && profileCache.name) || '我', avatar: safeImg(profileCache && profileCache.avatar), joinedAt: room.joinedAt }
    const list = [meP, ...otherIds().map(id => peers.get(id))]
    list.sort((a, b) => (a.joinedAt - offOf(a.id)) - (b.joinedAt - offOf(b.id)) || (a.id < b.id ? -1 : 1))
    const hostBefore = room.hostId
    room.hostId = list[0].id
    room.members = list.map(m => ({ id: m.id, name: m.name, avatar: m.avatar, isHost: m.id === room.hostId }))
    const peerClock = clocks.get(otherIds()[0])
    conn.rtt = peerClock ? peerClock.rtt : 0
    if (room.code && hostBefore && hostBefore !== room.hostId && isHost()) ui.toast('你现在是房主')
  }

  function pingPeers() {
    for (let i = 0; i < 3; i++) setTimeout(() => { for (const id of otherIds()) sendEvent({ t: 'ping', to: id, c: Date.now() }) }, i * 400)
  }

  async function onMqtt(topic, payload) {
    const c = room.crypto
    if (!c || !topic.startsWith(c.base + '/')) return
    const sub = topic.slice(c.base.length + 1)
    const kind = sub.startsWith('m/') ? 'm' : sub
    if (!MAX_BYTES[kind] || payload.length > MAX_BYTES[kind]) return

    if (kind === 'm') {
      const id = sub.slice(2)
      if (id === room.you || !ID_RE.test(id)) return
      if (!payload.length) {
        const p = peers.get(id)
        if (p) { peers.delete(id); recomputeMembers(); if (room.code) ui.toast(`${p.name} 离开了`); ui.render() }
        return
      }
      if (!allow(id, 2)) return
      const p = checkPresence(await c.open(payload), id)
      if (!p) return
      const isNew = !peers.has(id)
      peers.set(id, p)
      recomputeMembers()
      if (isNew) {
        pingPeers()
        if (room.code && Date.now() > quietUntil) ui.toast(`${p.name} 加入了一起听`)
      }
      ui.render()
      return
    }

    if (!payload.length) return
    const raw = await c.open(payload)
    if (!raw) return

    if (kind === 's') {
      const m = checkState(raw)
      if (!m) return
      if (m.by === room.you) return
      if (!peers.has(m.by)) return
      const l = limits.get(m.by)
      if (l && m.seq <= l.lastSeq) return
      if (!allow(m.by, 3)) return
      limits.get(m.by).lastSeq = m.seq
      const localAt = m.at - offOf(m.by)
      if (room.state && localAt < room.stateAt - 50) return
      room.state = m; room.stateAt = localAt
      if (!room.code || resyncing) return // 还在找房间 / 重连对齐中，稍后统一处理
      ui.render()
      applyState(m, '同步')
      return
    }

    if (kind === 'e') {
      const m = raw
      if (m.v !== PROTOCOL || !ID_RE.test(m.from || '') || m.from === room.you || !peers.has(m.from)) return
      if (!isNum(m.n, 1, 1e12) || !nearNow(m.at, m.from, 120e3)) return
      const l = limits.get(m.from)
      if (l && m.n <= l.lastEvt) return
      if (!allow(m.from, 1)) return
      limits.get(m.from).lastEvt = m.n
      if (m.t === 'ping' && m.to === room.you && isNum(m.c, 0, 1e14)) sendEvent({ t: 'pong', to: m.from, c: m.c, s: Date.now() })
      else if (m.t === 'pong' && m.to === room.you && isNum(m.c, 0, 1e14) && isNum(m.s, 0, 1e14)) {
        const now = Date.now(), rtt = now - m.c
        if (rtt < 0 || rtt > 30000) return
        const cur = clocks.get(m.from)
        if (!cur || rtt <= cur.rtt * 1.25 || rtt < 80) clocks.set(m.from, { off: m.s - (m.c + now) / 2, rtt: cur ? Math.min(rtt, cur.rtt * 1.25) : rtt })
        recomputeMembers(); ui.tick()
      } else if (m.t === 'chat') {
        const text = cleanStr(m.text, 60)
        if (text) core.onChat(peers.get(m.from).name, text)
      }
    }
  }

  function resetRoom() {
    room.code = null; room.you = null; room.hostId = null; room.members = []; room.state = null; room.stateAt = 0; room.crypto = null
    peers.clear(); clocks.clear(); limits.clear()
    mySeq = 0; myEvt = 0
    conn.client = null; conn.open = false; conn.rtt = 0
  }

  async function attach(url, you) {
    const c = room.crypto
    const client = await mqttConnect(url, 'st-' + you + '-' + Math.random().toString(36).slice(2, 6), { topic: c.base + '/m/' + you, payload: new Uint8Array(0) })
    conn.client = client; conn.open = true; conn.broker = url
    client.onMessage = (t, p) => onMqtt(t, p)
    client.onClose = () => onClosed(client)
    client.subscribe(c.base + '/#')
    return client
  }

  let retry = 0
  function onClosed(client) {
    if (client !== conn.client) return // 主动断开
    conn.open = false
    if (!room.code || core.disposed) return
    ui.status('连接断开，正在重连…'); ui.render()
    const code = room.code, you = room.you, url = conn.broker
    setTimeout(async () => {
      if (room.code !== code || core.disposed) return
      try { await attach(url, you); retry = 0; await publishPresence(); pingPeers(); ui.status('已重新连接'); ui.render(); resyncAfterReconnect() } catch { onClosed(conn.client = client) }
    }, Math.min(1000 * 2 ** retry++, 15000))
  }

  // 重连后：等服务器把房间最新状态推过来，再看谁的操作更新——
  // 自己断线期间的操作更新，就补发给好友；好友那边更新，就跟着好友走
  async function resyncAfterReconnect() {
    resyncing = true
    await sleep(1500)
    resyncing = false
    if (!room.code) return
    const p = offlinePending
    offlinePending = null
    const st = room.state
    if (st && st.by !== room.you && !(p && p.at >= room.stateAt)) {
      applyState(st, '重连同步')
    } else if (p || (st && st.by === room.you)) {
      await broadcastLocal(p ? p.reason : (st.reason || 'seek'))
      if (p) ui.toast('已把断线期间的操作同步给好友')
    }
  }

  // 心跳：在线信息每 30 秒刷新一次，时钟每 15 秒校一次，清理掉线的人
  every(() => { if (room.code && conn.open) publishPresence() }, 30000)
  every(() => { if (room.code && conn.open) { pingPeers(); recomputeMembers(); ui.render() } }, 15000)
  onDispose(() => {
    core.disposed = true
    // 正常断开(DISCONNECT)时服务器不会发遗嘱消息，所以先自己清掉在线信息，避免留下「幽灵成员」
    const cl = conn.client, c = room.crypto
    conn.client = null
    try {
      if (cl && c && room.code) {
        cl.publish(c.base + '/m/' + room.you, new Uint8Array(0), true)
        if (!otherIds().length) cl.publish(c.base + '/s', new Uint8Array(0), true)
      }
      cl && setTimeout(() => cl.close(), 200)
    } catch {}
  })

  // ---------------- 同步逻辑 ----------------
  // room.state: { track:{id,key,name,artist,cover,playable}, playing, pos, at(发送者时钟), by }
  const expectedPos = s => s.pos + (s.playing ? Math.max(0, Date.now() - (s.at - offOf(s.by))) / 1000 : 0)
  // 该状态对应歌曲的时长（秒），拿不到时用本地的
  const durationOf = s => {
    const d = s && s.track && Number(s.track.duration)
    return d > 0 ? d : (local.duration || 0)
  }
  // 推算位置已经超过歌曲长度：说明这首歌已经播完、状态过期了，不能再往那里跳（否则会被拉到歌尾反复重播）
  const isStale = s => { const d = durationOf(s); return d > 0 && expectedPos(s) > d - 1 }
  let suppressUntil = 0
  let applying = null
  let prevSample = null // 用于检测拖动进度
  let lastTrackEndedNaturally = false

  async function applyState(s, why) {
    const token = {}
    applying = token
    suppressUntil = Date.now() + 3000
    try {
      if (!s || !s.track || !s.track.id) return
      if (local.mediaId !== s.track.id) {
        ui.status(`正在切换到《${s.track.name || '…'}》`)
        const q = await ST.invoke('sharedState', 'get', ['queue'])
        const has = q && q.queue && q.queue.playables.byKey[s.track.key]
        if (!has) {
          const playable = await fetchPlayable(s.track.id)
          if (applying !== token) return
          if (!playable) { ui.toast('获取歌曲信息失败，可能是版权限制'); return }
          await ST.invoke('queue', 'insertPlayable', [playable])
        }
        await ST.invoke('queue', 'play', [{ specificPlayableKey: s.track.key }])
        await waitFor(() => local.mediaId === s.track.id, 10000)
        if (applying !== token) return
        if (local.mediaId !== s.track.id) { ui.toast('切歌失败，可能是版权或会员限制'); return }
        await waitFor(() => !local.isLoading, 8000)
        suppressUntil = Date.now() + 3000
      }
      if (applying !== token) return
      // 注意：汽水的 seekSeconds 跳转后会自动 resume，所以必须先跳进度、再决定暂停
      if (isStale(s)) { ui.status('等待下一首…'); return }
      const target = expectedPos(s)
      if (Math.abs(precisePos() - target) > 0.4) await ST.invoke('player', 'seekSeconds', [target + (s.playing ? 0.12 : 0)])
      if (!s.playing) {
        if (local.isPlaying || Math.abs(localPos() - target) > 0.4) await ST.invoke('player', 'suspend', [])
        await waitFor(() => !local.isPlaying, 1500)
        if (local.isPlaying) await ST.invoke('player', 'suspend', [])
      } else if (!local.isPlaying) await ST.invoke('player', 'resume', [])
      suppressUntil = Date.now() + 1500
      ui.status(s.playing ? '同步播放中' : '已暂停')
    } catch (e) {
      log('apply err', why, e.message)
      ui.status('同步失败：' + e.message)
    } finally {
      if (applying === token) applying = null
      prevSample = null
    }
  }

  // 按 ID 向汽水自己的接口取歌曲详情，并按汽水的 playableFromTrack 规则转换
  async function fetchPlayable(trackId) {
    try {
      const res = await ST.invoke('request', 'request', ['GetTrackV2', { media_type: 'track', track_id: trackId, queue_type: '' }], 15000)
      const t = res && (res.track || (res.track_info && res.track_info.track))
      if (!t || String(t.id) !== String(trackId)) { log('GetTrackV2 no track', res && Object.keys(res)); return null }
      return {
        key: 'track-' + t.id, type: 'track', track: t, video: undefined, id: t.id, name: t.name, sub_name: t.sub_name,
        media_type: t.media_type, cover_url: t.album && t.album.url_cover, artists: t.artists, album: t.album, duration: t.duration,
        vid: t.vid, colors: t.colors, status: t.status, stats: t.stats, digital_track_info: t.digital_track_info, preview: t.preview,
        limited_free_info: t.limited_free_info, bit_rates: t.bit_rates, chorus: t.chorus, sharable_platforms: t.sharable_platforms,
        label_info: t.label_info, vocal: t.vocal, song_maker_team: t.song_maker_team,
        state: t.state ? { is_collected: t.state.is_collected } : undefined,
      }
    } catch (e) { log('fetchPlayable err', e.message); return null }
  }

  async function broadcastLocal(reason) {
    if (!room.code) return
    const p = await currentPlayable()
    if (!p || p.type !== 'track' || !TRACK_ID_RE.test(String(p.id))) return // 视频/MV 暂不支持同步
    const artist = (p.artists || []).map(a => a && a.name).filter(Boolean).join(' / ')
    const state = {
      v: PROTOCOL, by: room.you, seq: ++mySeq, reason,
      track: { id: String(p.id), key: 'track-' + p.id, name: cleanStr(p.name, 200), artist: cleanStr(artist, 200), cover: safeImg(coverOf(p)), duration: (Number(p.duration) || 0) / 1000 },
      playing: local.isPlaying,
      pos: Math.max(0, localPos()),
      at: Date.now(),
    }
    room.state = state; room.stateAt = state.at
    if (!(await publish('s', state, true))) offlinePending = { reason, at: state.at }
    ui.render()
  }

  // 本地状态变化：判断是不是用户自己的操作，是就广播
  playerHandler = (v) => {
    if (!v) return
    const now = Date.now()
    const prev = { ...local }
    local.mediaId = v.mediaId || null
    local.isPlaying = !!v.isPlaying
    local.isLoading = !!v.isLoading
    local.pos = Number(v.progressSeconds) || 0
    local.duration = Number(v.durationSeconds) || 0
    local.t = now
    ui.tick()

    if (!room.code || applying || now < suppressUntil) { prevSample = { ...local }; return }
    const s = room.state

    if (prev.mediaId && local.mediaId !== prev.mediaId) {
      const ended = prev.duration > 0 && prev.pos >= prev.duration - 3
      prevSample = { ...local }
      if (ended && !isHost()) {
        // 自然播完：等房主推送下一首，房主没反应再用自己的
        lastTrackEndedNaturally = true
        setTimeout(() => { if (lastTrackEndedNaturally && room.state && room.state.track.id !== local.mediaId && Date.now() > suppressUntil) applyState(room.state, '等待房主超时') }, 4000)
        return
      }
      lastTrackEndedNaturally = false
      setTimeout(() => broadcastLocal(ended ? 'next' : 'switch'), 300)
      return
    }
    // 加载中不更新基准：单曲循环/重新开始时，加载完成后仍能发现「位置回到了开头」并广播
    if (local.isLoading) { if (!prevSample || prevSample.mediaId !== local.mediaId) prevSample = { ...local }; return }

    if (prevSample && prevSample.mediaId === local.mediaId) {
      if (prevSample.isPlaying !== local.isPlaying && (!s || s.playing !== local.isPlaying || s.track.id !== local.mediaId)) {
        prevSample = { ...local }
        // 稍等让进度值稳定下来再广播，避免暂停/继续时位置差半秒
        setTimeout(() => broadcastLocal(local.isPlaying ? 'play' : 'pause'), 250)
        return
      }
      const predicted = prevSample.pos + (prevSample.isPlaying ? (now - prevSample.t) / 1000 : 0)
      if (Math.abs(local.pos - predicted) > 2.5) {
        prevSample = { ...local }
        broadcastLocal('seek')
        return
      }
    }
    prevSample = { ...local }
  }

  // ---------------- 纠偏 ----------------
  // 小偏差：把播放速度微调到 0.95~1.05 倍悄悄追平（浏览器默认保持音调，听不出来）；
  // 大偏差：直接跳进度。只向「别人发来的」状态纠偏，房间状态是自己发的时，本地播放器就是标准。
  let correcting = false
  function currentMedia() {
    const m = ST.audioTap && ST.audioTap.media
    if (!m || !m.isConnected && m.readyState === 0) return null
    // 确认是当前这首歌的播放器：它的进度和汽水报告的进度对得上
    return Math.abs(m.currentTime - localPos()) < 3 ? m : null
  }
  function resetRate() {
    correcting = false
    const m = ST.audioTap && ST.audioTap.media
    if (m && m.playbackRate !== 1) m.playbackRate = 1
  }
  const precisePos = () => { const m = currentMedia(); return m ? m.currentTime : localPos() }
  every(() => {
    const s = room.state
    if (!room.code || !s || applying || Date.now() < suppressUntil) return resetRate()
    if (s.by === room.you || !otherIds().length) return resetRate()
    if (isStale(s) || s.track.id !== local.mediaId || s.playing !== local.isPlaying || !s.playing || local.isLoading) return resetRate()
    const media = currentMedia()
    const drift = precisePos() - expectedPos(s)
    core.drift = drift
    core.driftAt = Date.now()
    if (!media || Math.abs(drift) > 1) {
      resetRate()
      if (Math.abs(drift) > 0.8) { log('drift seek', drift.toFixed(3)); applyState(s, '纠偏') }
      return
    }
    if (Math.abs(drift) < (correcting ? 0.03 : 0.12)) return resetRate()
    correcting = true
    // 调整幅度随偏差变化，最少 2%、最多 5%，最后一点也能较快追平
    const adj = Math.min(0.05, Math.max(0.02, Math.abs(drift) / 6))
    media.playbackRate = drift > 0 ? 1 - adj : 1 + adj
  }, 500)
  onDispose(resetRate)

  // ---------------- 新版本提醒 ----------------
  const REPO = window.__SODA_TOGETHER_REPO__ || '7zxic/soda-together'
  const RELEASES_URL = 'https://github.com/' + REPO + '/releases/latest'
  const isNewer = (a, b) => {
    const pa = a.split(/[.-]/).map(Number), pb = b.split(/[.-]/).map(Number)
    for (let i = 0; i < 3; i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0) }
    return false
  }
  async function checkUpdate() {
    const cur = String(ST.version || '')
    if (!/^\d+\.\d+\.\d+/.test(cur)) return // 开发版不检查
    let latest = LS.get('latestVersion', '')
    if (Date.now() - Number(LS.get('updateCheckedAt', 0)) > 6 * 3600e3) {
      try {
        const r = await fetch('https://api.github.com/repos/' + REPO + '/releases/latest', { headers: { Accept: 'application/vnd.github+json' }, cache: 'no-store' })
        if (r.ok) {
          const j = await r.json()
          latest = String(j.tag_name || '').replace(/^v/, '')
          LS.set('latestVersion', latest)
          LS.set('updateCheckedAt', String(Date.now()))
        }
      } catch {}
    }
    core.update = /^\d+\.\d+\.\d+/.test(latest) && isNewer(latest, cur) ? latest : null
    ui.render()
  }
  core.checkUpdate = checkUpdate
  setTimeout(checkUpdate, 8000)
  every(checkUpdate, 6 * 3600e3)

  // ---------------- 房间操作 ----------------
  // 去掉了容易看错的 I O 0 1
  const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  const CODE_LEN = 12
  const normalizeCode = s => String(s || '').toUpperCase().replace(/[^ABCDEFGHJKLMNPQRSTUVWXYZ23456789]/g, '').slice(0, CODE_LEN)
  const formatCode = c => (c.match(/.{1,4}/g) || []).join('-')
  core.formatCode = formatCode
  const newId = () => Math.random().toString(36).slice(2, 10)
  let busy = false

  async function enterRoom(code, you, creating) {
    room.code = code; room.you = you
    ui.status('')
    quietUntil = Date.now() + 2500
    await publishPresence()
    recomputeMembers()
    pingPeers()
    ui.render()
    if (creating) { LS.set('lastCreated', code); await broadcastLocal('create'); ui.toast(`房间已创建：${formatCode(code)}`) }
    else {
      ui.toast(`已加入房间 ${formatCode(code)}`)
      if (room.state) applyState(room.state, '加入房间')
    }
    LS.set('lastRoom', code)
  }

  async function createRoom() {
    if (busy || room.code) return
    busy = true
    try {
      const code = [...crypto.getRandomValues(new Uint8Array(CODE_LEN))].map(b => CODE_CHARS[b & 31]).join('')
      const you = newId()
      resetRoom()
      room.crypto = await roomCrypto(code); room.you = you; room.joinedAt = Date.now()
      for (const url of brokers()) {
        try { await attach(url, you); await enterRoom(code, you, true); return } catch (e) { log('broker fail', url, e.message) }
      }
      resetRoom()
      ui.toast('网络连接失败，请检查网络后重试')
    } finally { busy = false; ui.render() }
  }

  async function joinRoom(code) {
    code = normalizeCode(code)
    if (code.length !== CODE_LEN) { ui.shakeCode(); return ui.toast(`请输入完整的 ${CODE_LEN} 位房间码`) }
    if (busy) return
    busy = true
    ui.status('正在寻找房间…')
    try {
      if (room.code) leaveRoom(true)
      const you = newId()
      resetRoom()
      room.crypto = await roomCrypto(code); room.you = you; room.joinedAt = Date.now()
      let reachable = 0
      // 房主可能连在任意一个通道上：依次进去看有没有房间成员的在线信息
      for (const url of brokers()) {
        let client
        try { client = await attach(url, you); reachable++ } catch (e) { log('broker fail', url, e.message); continue }
        const t0 = Date.now()
        while (!otherIds().length && Date.now() - t0 < 2500) await sleep(100)
        if (otherIds().length) { await enterRoom(code, you, false); return }
        conn.client = null; client.close()
        peers.clear(); room.state = null
      }
      resetRoom()
      ui.shakeCode()
      ui.toast(reachable ? '没有找到这个房间，请确认房间码' : '网络连接失败，请检查网络后重试')
    } finally { busy = false; ui.render() }
  }

  function leaveRoom(silent) {
    resetRate()
    const c = room.crypto, client = conn.client, alone = !otherIds().length
    if (client && c) {
      client.publish(c.base + '/m/' + room.you, new Uint8Array(0), true)
      if (alone) client.publish(c.base + '/s', new Uint8Array(0), true) // 最后一个人走时清掉房间状态
      setTimeout(() => client.close(), 400)
    }
    resetRoom()
    ui.render()
    if (!silent) ui.toast('已退出一起听')
  }
  core.api = { createRoom, joinRoom, leaveRoom, room, conn, local, peers, clocks }

  // ---------------- 界面 ----------------
  // 入口：听歌模式页标题右侧「头像 + 加号 / 双人一起听」（与手机版一致）；
  // 在房间里时，底部播放栏额外显示一个迷你头像组，任何页面都能打开。
  let me = { name: '', avatar: '' }
  myProfile().then(p => { me = p; ui.render() })

  const ui = (() => {
    const css = `
:root{--st-green:#00cb64;--st-spring:cubic-bezier(.34,1.56,.64,1);--st-out:cubic-bezier(.23,1,.32,1);--st-std:cubic-bezier(.4,0,.2,1)}
.st-title-row{position:relative}
.st-entry{position:absolute;right:32px;top:2px;display:flex;flex-direction:column;align-items:center;gap:6px;cursor:pointer;-webkit-app-region:no-drag;padding:4px 2px;z-index:2}
.st-entry.st-in .st-a{animation:st-pop .55s var(--st-spring) .04s both}
.st-entry.st-in .st-b{animation:st-pop .55s var(--st-spring) .12s both}
.st-entry.st-in .st-lbl{animation:st-up .45s var(--st-out) .18s both;transform:translateY(6px)}

.st-top{position:relative;z-index:1;display:flex;align-items:center;gap:6px;height:24px;margin-left:16px;padding:0 10px 0 2px;border-radius:12px;background:rgba(255,255,255,.12);color:rgba(255,255,255,.8);font-size:12px;font-weight:600;cursor:pointer;-webkit-app-region:no-drag;flex:none;white-space:nowrap;transition:background .2s,transform .35s var(--st-spring)}
.st-top:hover{background:rgba(255,255,255,.18)}
.st-top:active{transform:scale(.93);transition-duration:.1s}
.st-top .st-stack .st-av{width:20px;height:20px;font-size:9px;transition:transform .45s var(--st-spring)}
.st-top .st-stack .st-b{margin-left:-6px;box-shadow:0 0 0 1.5px #2b2b2b;background-color:#4a4b50}
.st-top .st-stack .st-b svg{width:12px;height:12px;color:rgba(255,255,255,.85);transition:transform .45s var(--st-spring)}
.st-top:hover .st-b.plus svg{transform:rotate(90deg)}
.st-top:hover .st-a{transform:translateX(-1px)}
.st-top:hover .st-b{transform:translateX(1px)}
.st-top.on{color:var(--st-green);background:rgba(0,203,100,.14)}
.st-top.on.reconnecting{color:#ffbe50;background:rgba(255,190,80,.14)}
.st-top.on.reconnecting .st-eq i{animation:none;height:3px}
.st-top.on .st-stack .st-b{box-shadow:0 0 0 1.5px #0f2c1d}
.st-top.on:hover{background:rgba(0,203,100,.2)}
.st-top.st-in{animation:st-pop .5s var(--st-spring) both}
.st-stack{display:flex;align-items:center;transition:transform .4s var(--st-spring)}
.st-av{border-radius:50%;background:#3a3a3e center/cover no-repeat;flex:none;display:flex;align-items:center;justify-content:center;color:#fff;font-weight:600}
.st-entry .st-av{width:44px;height:44px;font-size:16px;transition:transform .45s var(--st-spring)}
.st-entry .st-b{margin-left:-12px;box-shadow:0 0 0 3px var(--st-bg,#1c1c1e);background-color:#3e3f44;transition:transform .45s var(--st-spring),background-color .2s}
.st-entry .st-b svg{width:20px;height:20px;color:rgba(255,255,255,.78);transition:transform .45s var(--st-spring)}
.st-entry:hover .st-a{transform:translateX(-3px)}
.st-entry:hover .st-b{transform:translateX(3px)}
.st-entry:hover .st-b.plus{background-color:#4b4c52}
.st-entry:hover .st-b.plus svg{transform:rotate(90deg)}
.st-entry:active .st-stack{transform:scale(.9);transition-duration:.12s}
.st-entry .st-lbl{display:flex;align-items:center;gap:5px;font-size:13px;font-weight:500;line-height:18px;color:rgba(255,255,255,.5);transition:color .2s}
.st-entry:hover .st-lbl{color:rgba(255,255,255,.78)}
.st-entry.on .st-lbl{color:var(--st-green)}
.st-eq{display:inline-flex;align-items:flex-end;gap:2px;height:10px}
.st-eq i{width:2px;border-radius:1px;background:currentColor;animation:st-eq .9s ease-in-out infinite}
.st-eq i:nth-child(2){animation-delay:-.3s}.st-eq i:nth-child(3){animation-delay:-.6s}
.st-eq.live i{animation:none;height:3px}
.st-eq.idle i{animation:none;height:3px;transition:height .3s var(--st-out)}
@keyframes st-eq{0%,100%{height:3px}50%{height:10px}}

.st-mini{position:relative}
.st-mini .st-stack .st-av{width:24px;height:24px;font-size:10px}
.st-mini .st-stack .st-av+.st-av{margin-left:-8px;box-shadow:0 0 0 2px var(--st-bar-bg,#2a2a2e)}
.st-mini:after{content:"";position:absolute;right:-1px;top:-1px;width:7px;height:7px;border-radius:50%;background:var(--st-green);box-shadow:0 0 0 2px var(--st-bar-bg,#2a2a2e)}
.st-mini.pop{animation:st-pop .5s var(--st-spring)}

.st-backdrop{position:fixed;inset:0;z-index:2147482999;background:rgba(0,0,0,.32);backdrop-filter:blur(6px);opacity:0;transition:opacity .3s var(--st-std)}
.st-backdrop.show{opacity:1}
.st-sheet button,.st-sheet input,.st-top,.st-entry,.st-toast{font-family:inherit}
.st-sheet,.st-toast{font-family:-apple-system,BlinkMacSystemFont,Helvetica,"PingFang SC",MiSans,Arial,Avenir,Inter,sans-serif}
.st-sheet{position:fixed;z-index:2147483000;width:340px;box-sizing:border-box;padding:22px 20px 18px;border-radius:22px;background:rgba(38,38,41,.97);box-shadow:0 20px 60px rgba(0,0,0,.5),0 0 0 1px rgba(255,255,255,.06);color:rgba(255,255,255,.85);font-size:13px;user-select:none;opacity:0;transform:scale(.35);transition:transform .55s var(--st-spring),opacity .2s var(--st-out)}
.st-sheet.show{opacity:1;transform:scale(1)}
.st-sheet.hide{opacity:0;transform:scale(.88);transition:transform .22s var(--st-std),opacity .18s var(--st-std)}
.st-sheet.enter .st-body>*{opacity:0;transform:translateY(10px);animation:st-up .5s var(--st-out) forwards;animation-delay:calc(var(--i,0) * 45ms + 110ms)}
@keyframes st-up{to{opacity:1;transform:none}}
@keyframes st-pop{0%{transform:scale(.3);opacity:0}100%{transform:none;opacity:1}}

.st-hero{position:relative;display:flex;justify-content:center;align-items:center;height:76px;margin-bottom:12px}
.st-hero .st-av{width:64px;height:64px;font-size:22px}
.st-hero .st-a{z-index:1}
.st-hero .st-b{margin-left:-16px;box-shadow:0 0 0 4px rgba(38,38,41,1)}
.st-sheet.enter .st-hero .st-a{animation:st-pop .6s var(--st-spring) .12s both}
.st-sheet.enter .st-hero .st-b{animation:st-pop .6s var(--st-spring) .22s both}
.st-hero .st-b.wait{position:relative;background:rgba(255,255,255,.06);border:1.5px dashed rgba(255,255,255,.28);box-sizing:border-box;box-shadow:none}
.st-hero .st-b.wait svg{width:24px;height:24px;color:rgba(255,255,255,.5)}
.st-hero .st-b.wait.ring:before,.st-hero .st-b.wait.ring:after{content:"";position:absolute;inset:-2px;border-radius:50%;border:1.5px solid var(--st-green);animation:st-ring 2s var(--st-out) infinite}
.st-hero .st-b.wait.ring:after{animation-delay:1s}
@keyframes st-ring{0%{transform:scale(1);opacity:.75}100%{transform:scale(1.5);opacity:0}}
.st-hero .st-more{position:absolute;right:calc(50% - 64px);bottom:4px;z-index:2;padding:0 6px;height:18px;border-radius:9px;background:var(--st-green);color:#fff;font-size:11px;line-height:18px;font-weight:600}
.st-note{position:absolute;left:50%;top:6px;z-index:3;color:var(--st-green);font-size:14px;pointer-events:none;animation:st-note 2.4s var(--st-out) infinite}
.st-note.n2{animation-delay:1.2s;font-size:11px}
@keyframes st-note{0%{transform:translate(-50%,18px) scale(.6);opacity:0}25%{opacity:1}100%{transform:translate(calc(-50% + 14px),-14px) scale(1);opacity:0}}

.st-sheet h3{margin:0;text-align:center;font-size:17px;font-weight:600;color:#fff}
.st-sheet .st-sub{margin:6px 0 18px;text-align:center;color:rgba(255,255,255,.45);font-size:12px;line-height:1.6}
.st-btn{display:flex;align-items:center;justify-content:center;width:100%;height:40px;border:0;border-radius:20px;font-size:14px;font-weight:600;cursor:pointer;transition:transform .35s var(--st-spring),background .2s,opacity .2s}
.st-btn:active{transform:scale(.95);transition-duration:.1s}
.st-btn.primary{background:var(--st-green);color:#fff}
.st-btn.primary:hover{background:#00b85a}
.st-btn.ghost{background:rgba(255,255,255,.08);color:rgba(255,255,255,.85);font-weight:500}
.st-btn.ghost:hover{background:rgba(255,255,255,.14)}
.st-btn.danger{background:transparent;color:rgba(255,255,255,.45);font-weight:500;height:34px;margin-top:6px}
.st-btn.danger:hover{color:#ff6b6b;background:rgba(255,80,80,.08)}
.st-btn[disabled]{opacity:.4;pointer-events:none}
.st-divider{display:flex;align-items:center;gap:10px;margin:18px 0 12px;color:rgba(255,255,255,.3);font-size:12px}
.st-divider:before,.st-divider:after{content:"";flex:1;height:1px;background:rgba(255,255,255,.08)}

.st-code{position:relative;display:flex;gap:10px;justify-content:center;cursor:text}
.st-code .g{display:flex;gap:3px}
.st-code span{width:21px;height:38px;border-radius:7px;background:rgba(255,255,255,.07);display:flex;align-items:center;justify-content:center;font-size:15px;font-weight:700;color:#fff;font-variant-numeric:tabular-nums;transition:box-shadow .2s,background .2s}
.st-code span.cur{box-shadow:0 0 0 1.5px var(--st-green);background:rgba(0,203,100,.06)}
.st-code span.cur:empty:after{content:"";width:2px;height:16px;border-radius:1px;background:var(--st-green);animation:st-caret 1s steps(1) infinite}
.st-code span.pop{animation:st-tick .32s var(--st-spring)}
.st-code input{position:absolute;inset:0;width:100%;height:100%;opacity:0;border:0;padding:0;cursor:text;font-size:1px}
.st-code.shake{animation:st-shake .4s var(--st-std)}
@keyframes st-caret{50%{opacity:0}}
@keyframes st-tick{0%{transform:scale(.8)}100%{transform:none}}
@keyframes st-shake{20%,60%{transform:translateX(-6px)}40%,80%{transform:translateX(6px)}}
.st-code.ro span{background:rgba(255,255,255,.05)}
.st-coderow{display:flex;flex-direction:column;align-items:center;gap:10px;margin-bottom:16px}
.st-copy{border:0;height:26px;padding:0 12px;border-radius:13px;background:rgba(0,203,100,.14);color:var(--st-green);font-size:12px;cursor:pointer;transition:transform .35s var(--st-spring),background .2s}
.st-copy:hover{background:rgba(0,203,100,.22)}
.st-copy:active{transform:scale(.92)}

.st-now{display:flex;align-items:center;gap:10px;padding:10px;border-radius:14px;background:rgba(255,255,255,.05);margin-bottom:10px}
.st-now img{width:38px;height:38px;border-radius:8px;object-fit:cover;flex:none;background:#333}
.st-now .t{color:#fff;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.st-now .s{color:rgba(255,255,255,.45);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.st-status{display:flex;align-items:center;gap:6px;padding:0 4px;margin-bottom:12px;color:rgba(255,255,255,.45);font-size:12px}
.st-status i{width:6px;height:6px;border-radius:50%;background:var(--st-green);box-shadow:0 0 6px var(--st-green)}
.st-status.off i{background:#777;box-shadow:none}
.st-chat{display:flex;gap:6px;margin-bottom:6px}
.st-emoji{width:34px;height:34px;flex:none;border:0;border-radius:17px;background:rgba(255,255,255,.07);cursor:pointer;font-size:15px;transition:transform .35s var(--st-spring),background .2s}
.st-emoji:hover{background:rgba(255,255,255,.13);transform:scale(1.1)}
.st-emoji:active{transform:scale(.88)}
.st-chat input{flex:1;min-width:0;height:34px;padding:0 14px;border:0;border-radius:17px;background:rgba(255,255,255,.07);color:#fff;font-size:13px;outline:none;user-select:text}
.st-chat input:focus{box-shadow:0 0 0 1px rgba(0,203,100,.5)}
.st-detect{display:flex;align-items:center;gap:10px;padding:10px 12px;margin:0 0 14px;border-radius:14px;background:rgba(0,203,100,.1);box-shadow:inset 0 0 0 1px rgba(0,203,100,.28);animation:st-up .45s var(--st-out) both}
.st-detect .t{flex:1;min-width:0;font-size:12px;color:rgba(255,255,255,.65)}
.st-detect b{display:block;margin-top:2px;color:#fff;font-size:14px;letter-spacing:1px}
.st-detect .st-btn{width:auto;height:32px;padding:0 14px;font-size:13px;flex:none}
.st-update{margin-top:12px;text-align:center;font-size:12px;color:var(--st-green);cursor:pointer}
.st-update:hover{text-decoration:underline}
.st-top .st-new{position:absolute;right:-1px;top:-1px;width:7px;height:7px;border-radius:50%;background:var(--st-green);box-shadow:0 0 0 2px #2b2b2b}
.st-foot{margin-top:14px;display:flex;justify-content:space-between;align-items:center;font-size:11px;color:rgba(255,255,255,.28)}
.st-link{cursor:pointer;color:rgba(255,255,255,.45)}
.st-link:hover{color:var(--st-green)}
.st-srv{display:flex;gap:6px;margin-top:12px}
.st-srv input{flex:1;min-width:0;height:32px;padding:0 12px;border:0;border-radius:16px;background:rgba(255,255,255,.07);color:#fff;font-size:12px;outline:none;user-select:text}
.st-srv .st-btn{width:auto;height:32px;padding:0 14px;font-size:12px}

.st-toast{position:fixed;left:50%;bottom:118px;z-index:2147483001;padding:10px 18px;border-radius:20px;background:rgba(51,52,63,.97);color:#fff;font-size:13px;box-shadow:0 8px 28px rgba(0,0,0,.35);pointer-events:none;max-width:60vw;text-align:center;opacity:0;transform:translate(-50%,16px) scale(.9);transition:opacity .2s var(--st-std),transform .45s var(--st-spring)}
.st-toast.show{opacity:1;transform:translate(-50%,0) scale(1)}
.st-float{position:fixed;z-index:2147483002;font-size:30px;pointer-events:none;animation:st-float 1.6s var(--st-out) forwards}
@keyframes st-float{0%{transform:translateY(0) scale(.4);opacity:0}20%{transform:translateY(-20px) scale(1.15);opacity:1}100%{transform:translateY(-120px) scale(1);opacity:0}}
`
    const style = document.createElement('style')
    style.textContent = css
    document.head.appendChild(style)
    onDispose(() => style.remove())

    const PLUS = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>'
    const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
    const av = (p, cls) => p && p.avatar
      ? `<div class="st-av ${cls}" style="background-image:url('${esc(p.avatar)}')"></div>`
      : `<div class="st-av ${cls}">${esc(((p && p.name) || '?').slice(0, 1))}</div>`
    const meM = () => room.members.find(m => m.id === room.you) || me
    const others = () => room.members.filter(m => m.id !== room.you)
    const inRoom = () => !!room.code

    function bgOf(el) {
      for (let e = el; e; e = e.parentElement) {
        const c = getComputedStyle(e).backgroundColor
        if (c && c !== 'transparent' && !/rgba\(\s*0,\s*0,\s*0,\s*0\s*\)/.test(c)) return c
      }
      return '#1c1c1e'
    }

    // ---- 入口 1：听歌模式页标题 ----
    let entry = null
    // 清掉之前实例（热加载/重复注入）留下的入口和弹层
    document.querySelectorAll('.st-top,.st-entry,.st-sheet,.st-backdrop,.st-toast').forEach(e => e.remove())

    function ensureEntry() {
      if (core.disposed) return
      const title = document.querySelector('.scene-mode .page-title')
      if (!title) { entry = null; return }
      if (entry && title.contains(entry)) return
      title.classList.add('st-title-row')
      entry = document.createElement('div')
      entry.className = 'st-entry'
      entry.title = '双人一起听'
      entry.addEventListener('click', (e) => { e.stopPropagation(); toggle(entry) })
      entry.classList.add('st-in')
      title.appendChild(entry)
      entry.style.setProperty('--st-bg', bgOf(title))
      renderEntry()
      // 入场动画结束后移除，避免 animation 的 fill 盖住悬停动效
      const e = entry
      setTimeout(() => e.classList.remove('st-in'), 800)
    }
    function renderEntry() {
      if (!entry) return
      const o = others()
      const on = inRoom()
      entry.classList.toggle('on', on)
      const b = on && o.length ? av(o[0], 'st-b') : `<div class="st-av st-b plus">${PLUS}</div>`
      entry.innerHTML = `<div class="st-stack">${av(on ? meM() : me, 'st-a')}${b}</div>
        <div class="st-lbl">${on ? '<span class="st-eq"><i></i><i></i><i></i></span>' + (!conn.open ? '重连中…' : o.length ? '一起听中' : '等待好友') : '双人一起听'}</div>`
    }

    // ---- 入口 2：顶栏「一起听」胶囊（每个页面都有），放在「AI 写歌」左边 ----
    let mini = null
    function ensureMini() {
      if (core.disposed) return
      const topbar = document.querySelector('.topbar')
      if (!topbar) { mini = null; return }
      if (mini && topbar.contains(mini)) return
      const before = topbar.querySelector('.ai-song-badge') || topbar.querySelector('.vip-status') || topbar.querySelector('.actions')
      if (!before) return
      mini = document.createElement('div')
      mini.className = 'st-top st-in'
      mini.title = '双人一起听'
      mini.addEventListener('click', (e) => { e.stopPropagation(); toggle(mini) })
      before.parentElement.insertBefore(mini, before)
      // 我们插在 AI 按钮前面，它原本的左边距由我们承担，避免间距翻倍
      if (before.classList.contains('ai-song-badge')) before.style.marginLeft = '8px'
      renderMini()
      const m = mini
      setTimeout(() => m.classList.remove('st-in'), 700)
    }
    function renderMini() {
      if (!mini) return
      const o = others()
      const on = inRoom()
      mini.classList.toggle('on', on)
      mini.classList.toggle('reconnecting', on && !conn.open)
      const b = on && o.length ? av(o[0], 'st-b') : `<div class="st-av st-b plus">${PLUS}</div>`
      mini.innerHTML = `<div class="st-stack">${av(on ? meM() : me, 'st-a')}${b}</div>${on ? '<span class="st-eq"><i></i><i></i><i></i></span>' + (!conn.open ? '重连中…' : o.length ? '一起听中' : '等待好友') : '一起听'}${core.update ? '<i class="st-new"></i>' : ''}`
    }

    // 页面一渲染就同步插入入口（不等定时器），切换页面回来时不会「晚一拍」才冒出来
    const ensureAll = () => { ensureEntry(); ensureMini() }
    let scheduled = false
    const mo = new MutationObserver(() => {
      if (scheduled) return
      scheduled = true
      queueMicrotask(() => { scheduled = false; ensureAll() })
    })
    mo.observe(document.getElementById('app') || document.body, { childList: true, subtree: true })
    every(ensureAll, 2000)
    onDispose(() => {
      mo.disconnect()
      entry && entry.remove(); mini && mini.remove()
      const ai = document.querySelector('.topbar .ai-song-badge'); if (ai) ai.style.marginLeft = ''
      document.querySelectorAll('.st-title-row').forEach(e => e.classList.remove('st-title-row'))
      closeNow()
    })

    // ---- 弹层 ----
    let sheet = null, backdrop = null, anchor = null, mode = '', editingServer = false, codeDraft = ''
    function toggle(from) { sheet ? close() : open(from) }

    function open(from) {
      anchor = from
      setTimeout(detectClipboard, 0)
      backdrop = document.createElement('div')
      backdrop.className = 'st-backdrop'
      backdrop.addEventListener('mousedown', close)
      sheet = document.createElement('div')
      sheet.className = 'st-sheet'
      sheet.addEventListener('mousedown', e => e.stopPropagation())
      document.body.appendChild(backdrop)
      document.body.appendChild(sheet)
      mode = ''
      render()
      place()
      // 先强制浏览器应用初始的缩小状态，再加 show，动画才会从入口处「长」出来
      void sheet.offsetWidth
      backdrop.classList.add('show')
      sheet.classList.add('show')
    }
    function close() {
      if (!sheet) return
      const s = sheet, b = backdrop
      sheet = null; backdrop = null
      s.classList.remove('show'); s.classList.add('hide')
      b.classList.remove('show')
      setTimeout(() => { s.remove(); b.remove() }, 260)
    }
    function closeNow() { if (sheet) { sheet.remove(); backdrop.remove(); sheet = null; backdrop = null } }
    function onKey(e) { if (e.key === 'Escape' && sheet) close() }
    document.addEventListener('keydown', onKey)
    onDispose(() => document.removeEventListener('keydown', onKey))
    // 面板开着时切到微信复制了房间码再切回来，也能识别
    const onFocus = () => { if (sheet && !inRoom()) detectClipboard() }
    window.addEventListener('focus', onFocus)
    onDispose(() => window.removeEventListener('focus', onFocus))

    // 定位在入口旁边，并把缩放原点设在入口中心
    function place() {
      if (!sheet) return
      if (!anchor || !anchor.isConnected) anchor = entry || mini
      if (!anchor) return
      const r = anchor.getBoundingClientRect()
      // offsetWidth/Height 不受 transform 缩放影响，拿到的是展开后的真实尺寸
      const w = sheet.offsetWidth, h = sheet.offsetHeight
      const below = r.top < window.innerHeight / 2
      let left = Math.min(window.innerWidth - w - 16, Math.max(16, r.left + r.width / 2 - w + 40))
      if (!below) left = Math.min(window.innerWidth - w - 16, Math.max(16, r.left + r.width / 2 - w / 2))
      const top = below ? Math.min(window.innerHeight - h - 16, r.bottom + 12) : Math.max(16, r.top - h - 14)
      sheet.style.left = left + 'px'
      sheet.style.top = top + 'px'
      sheet.style.transformOrigin = `${r.left + r.width / 2 - left}px ${r.top + r.height / 2 - top}px`
    }

    function render() {
      if (core.disposed) return
      ensureEntry(); renderEntry(); ensureMini(); renderMini()
      if (!sheet) return
      const newMode = (inRoom() ? 'room' + Math.min(room.members.length, 3) : 'lobby') + (editingServer ? 's' : '')
      const animate = newMode.replace(/s$/, '') !== mode.replace(/s$/, '')
      mode = newMode
      const focused = document.activeElement && sheet.contains(document.activeElement) ? document.activeElement.dataset.k : null
      const keep = {}
      sheet.querySelectorAll('input[data-k="chat"],input[data-k="server"]').forEach(i => { keep[i.dataset.k] = i.value })
      sheet.innerHTML = `<div class="st-body">${inRoom() ? roomHtml() : lobbyHtml()}</div>`
      for (const k in keep) { const i = sheet.querySelector(`input[data-k="${k}"]`); if (i) i.value = keep[k] }
      if (animate) {
        sheet.classList.remove('enter'); void sheet.offsetWidth; sheet.classList.add('enter')
        ;[...sheet.querySelector('.st-body').children].forEach((c, i) => c.style.setProperty('--i', i))
      }
      bind(focused)
      place()
    }

    function heroHtml() {
      const o = others()
      const meP = inRoom() ? meM() : me
      if (o.length) {
        return `<div class="st-hero">${av(meP, 'st-a')}${av(o[0], 'st-b')}${o.length > 1 ? `<span class="st-more">+${o.length - 1}</span>` : ''}<span class="st-note">♪</span><span class="st-note n2">♫</span></div>`
      }
      return `<div class="st-hero">${av(meP, 'st-a')}<div class="st-av st-b wait ${inRoom() ? 'ring' : ''}">${PLUS}</div></div>`
    }

    function codeBoxes(value, readonly) {
      const v = String(value || '').toUpperCase()
      let s = ''
      // 12 位分成 3 组，每组 4 个格子
      for (let g = 0; g < CODE_LEN / 4; g++) {
        s += '<b class="g">'
        for (let i = g * 4; i < g * 4 + 4; i++) s += `<span class="${!readonly && i === Math.min(v.length, CODE_LEN - 1) ? 'cur' : ''}">${esc(v[i] || '')}</span>`
        s += '</b>'
      }
      return `<div class="st-code ${readonly ? 'ro' : ''}">${s}${readonly ? '' : `<input data-k="code" maxlength="20" value="${esc(v)}" spellcheck="false" autocomplete="off" placeholder="粘贴或输入房间码">`}</div>`
    }

    const updateHtml = () => core.update ? `<div class="st-update" data-a="update">发现新版本 v${esc(core.update)}，点击下载</div>` : ''

    // 打开面板时看看剪贴板里有没有好友发来的房间码（只认 XXXX-XXXX-XXXX 格式，或剪贴板里只有 12 位房间码）
    let detectedCode = ''
    async function detectClipboard() {
      if (inRoom()) return
      let text = ''
      try { text = String(await navigator.clipboard.readText() || '') } catch { return }
      const up = text.toUpperCase()
      const m = up.match(/(?:^|[^A-Z0-9])([A-HJ-NP-Z2-9]{4})-([A-HJ-NP-Z2-9]{4})-([A-HJ-NP-Z2-9]{4})(?![A-Z0-9])/) || up.trim().match(/^([A-HJ-NP-Z2-9]{4})([A-HJ-NP-Z2-9]{4})([A-HJ-NP-Z2-9]{4})$/)
      const c = m ? m[1] + m[2] + m[3] : ''
      const next = c && c !== LS.get('lastCreated', '') ? c : ''
      if (next === detectedCode) return
      detectedCode = next
      if (next) codeDraft = next
      render()
    }

    function lobbyHtml() {
      return `
        ${heroHtml()}
        <h3>双人一起听</h3>
        <div class="st-sub">邀请好友实时同步收听<br>切歌、暂停、拖动进度都会一起变化</div>
        ${detectedCode ? `<div class="st-detect"><div class="t">检测到好友的房间码<b>${esc(formatCode(detectedCode))}</b></div><button class="st-btn primary" data-a="joinDetected">一键加入</button></div>` : ''}
        <button class="st-btn ${detectedCode ? 'ghost' : 'primary'}" data-a="create">创建房间并邀请好友</button>
        <div class="st-divider">或输入好友的房间码</div>
        ${codeBoxes(codeDraft, false)}
        <div style="height:12px"></div>
        <button class="st-btn ghost" data-a="join" ${codeDraft.length === CODE_LEN ? '' : 'disabled'}>加入房间</button>
        ${editingServer ? `
          <div class="st-srv"><input data-k="server" value="${esc(customBroker())}" placeholder="wss://你的服务器:端口/mqtt" spellcheck="false"><button class="st-btn primary" data-a="saveServer">保存</button></div>
          <div class="st-foot"><span>自定义服务器：双方需填写相同地址，留空则使用默认</span><span class="st-link" data-a="closeServer">收起</span></div>`
        : `<div class="st-foot"><span>${customBroker() ? '使用自定义服务器' : '无需服务器，直接连接好友'}</span><span class="st-link" data-a="server">高级</span></div>`}
        ${updateHtml()}`
    }

    function roomHtml() {
      const o = others()
      const s = room.state, t = s && s.track
      return `
        ${heroHtml()}
        <h3>${o.length ? (o.length === 1 ? `和 ${esc(o[0].name)} 一起听` : `${room.members.length} 人正在一起听`) : '等待好友加入…'}</h3>
        <div class="st-sub">${o.length ? '你们的播放已同步' : '把房间码发给好友，在TA的汽水里输入即可加入'}</div>
        <div class="st-coderow">${codeBoxes(room.code, true)}<button class="st-copy" data-a="copy">复制邀请</button></div>
        ${t ? `<div class="st-now"><img src="${esc(t.cover || '')}" onerror="this.style.visibility='hidden'"><div style="min-width:0;flex:1"><div class="t">${esc(t.name)}</div><div class="s">${esc(t.artist)}</div></div></div>` : ''}
        <div class="st-status ${conn.open ? '' : 'off'}"><i></i><span data-r="status">${esc(conn.open ? (statusText || '已连接') : '未连接')}</span><span style="margin-left:auto" data-r="latency">${syncLabel()}</span></div>
        ${o.length ? `<div class="st-chat"><button class="st-emoji" data-a="emoji" data-e="❤️">❤️</button><button class="st-emoji" data-a="emoji" data-e="👍">👍</button><button class="st-emoji" data-a="emoji" data-e="🎵">🎵</button><input data-k="chat" maxlength="60" placeholder="说点什么…"></div>` : ''}
        <button class="st-btn danger" data-a="leave">退出一起听</button>
        ${updateHtml()}`
    }

    function bind(focused) {
      sheet.querySelectorAll('[data-a]').forEach(el => el.addEventListener('click', onAction))
      const code = sheet.querySelector('input[data-k="code"]')
      if (code) {
        code.addEventListener('input', () => {
          const v = normalizeCode(code.value)
          const grew = v.length > codeDraft.length
          codeDraft = v
          code.value = v
          const spans = sheet.querySelectorAll('.st-code span')
          spans.forEach((sp, i) => { sp.textContent = v[i] || ''; sp.classList.toggle('cur', i === Math.min(v.length, CODE_LEN - 1)) })
          if (grew && spans[v.length - 1]) { const sp = spans[v.length - 1]; sp.classList.remove('pop'); void sp.offsetWidth; sp.classList.add('pop') }
          const jb = sheet.querySelector('[data-a="join"]')
          if (jb) jb.disabled = v.length !== CODE_LEN
        })
        code.addEventListener('keydown', e => { if (e.key === 'Enter' && codeDraft.length === CODE_LEN) joinRoom(codeDraft) })
        if (focused === 'code') code.focus()
      }
      const chat = sheet.querySelector('input[data-k="chat"]')
      if (chat) {
        chat.addEventListener('keydown', e => { if (e.key === 'Enter' && chat.value.trim()) { sendChat(chat.value.trim()); chat.value = '' } })
        if (focused === 'chat') chat.focus()
      }
      const srv = sheet.querySelector('input[data-k="server"]')
      if (srv) srv.addEventListener('keydown', e => { if (e.key === 'Enter') { const b = sheet.querySelector('[data-a="saveServer"]'); if (b) b.click() } })
    }

    function sendChat(text) {
      sendEvent({ t: 'chat', text })
      if ([...text].length <= 2) floatEmoji(text)
      else toast('我：' + text)
    }
    core.onChat = (who, text) => {
      if ([...text].length <= 2) floatEmoji(text)
      toast(`${who}：${text}`)
    }

    async function onAction(e) {
      const a = e.currentTarget.dataset.a
      if (a === 'create') { e.currentTarget.disabled = true; e.currentTarget.textContent = '正在创建…'; await createRoom(); render() }
      if (a === 'join') { e.currentTarget.disabled = true; e.currentTarget.textContent = '正在寻找房间…'; await joinRoom(codeDraft); render() }
      if (a === 'leave') { leaveRoom(); codeDraft = '' }
      if (a === 'emoji') sendChat(e.currentTarget.dataset.e)
      if (a === 'server') { editingServer = true; render(); const i = sheet.querySelector('input[data-k="server"]'); if (i) i.focus() }
      if (a === 'closeServer') { editingServer = false; render() }
      if (a === 'saveServer') {
        const v = sheet.querySelector('input[data-k="server"]').value.trim()
        if (v && !/^wss?:\/\/[^\s/]+(:\d+)?(\/\S*)?$/.test(v)) return toast('地址格式不对，例如 wss://example.com:8084/mqtt')
        LS.set('broker', v)
        editingServer = false
        render()
        toast(v ? '已切换到自定义服务器' : '已恢复默认')
      }
      if (a === 'copy') {
        const invite = '来汽水音乐一起听歌吧！\n房间码：' + formatCode(room.code) + '\n打开汽水顶栏的「一起听」就能自动识别加入。\n还没装插件？在这里下载：' + RELEASES_URL
        try { await navigator.clipboard.writeText(invite); toast('邀请已复制，发给好友吧') } catch {
          try { await ST.invoke('utils', 'copyToClipboard', [invite]); toast('邀请已复制，发给好友吧') } catch { toast('复制失败，房间码：' + formatCode(room.code)) }
        }
      }
      if (a === 'joinDetected') {
        e.currentTarget.disabled = true; e.currentTarget.textContent = '加入中…'
        const c = detectedCode
        detectedCode = ''
        await joinRoom(c)
        render()
      }
      if (a === 'update') ST.invoke('utils', 'openUrl', [RELEASES_URL]).catch(() => { try { window.open(RELEASES_URL) } catch {} })
    }

    function shakeCode() {
      const c = sheet && sheet.querySelector('.st-code')
      if (c) { c.classList.remove('shake'); void c.offsetWidth; c.classList.add('shake') }
    }

    // 表情从入口处飘起
    function floatEmoji(text) {
      const from = (sheet && sheet.querySelector('.st-hero')) || mini || entry
      const r = from ? from.getBoundingClientRect() : { left: window.innerWidth / 2, top: window.innerHeight / 2, width: 0 }
      for (let i = 0; i < 3; i++) {
        const el = document.createElement('div')
        el.className = 'st-float'
        el.textContent = text
        el.style.left = (r.left + r.width / 2 - 15 + (i - 1) * 22) + 'px'
        el.style.top = (r.top + 10) + 'px'
        el.style.animationDelay = (i * 0.12) + 's'
        document.body.appendChild(el)
        setTimeout(() => el.remove(), 2000)
      }
    }

    let toastEl = null, toastTimer = null
    function toast(text) {
      if (!toastEl) { toastEl = document.createElement('div'); toastEl.className = 'st-toast'; document.body.appendChild(toastEl); onDispose(() => toastEl && toastEl.remove()) }
      toastEl.textContent = text
      toastEl.classList.remove('show'); void toastEl.offsetWidth; toastEl.classList.add('show')
      clearTimeout(toastTimer)
      toastTimer = setTimeout(() => toastEl && toastEl.classList.remove('show'), 2600)
    }

    let statusText = ''
    function status(text) {
      statusText = text
      const el = sheet && sheet.querySelector('[data-r="status"]')
      if (el) el.textContent = text
    }
    function syncLabel() {
      if (!conn.open || !core.driftAt || Date.now() - core.driftAt > 3000) return ''
      return '误差 ' + Math.abs(core.drift).toFixed(2) + ' 秒'
    }
    function tick() {
      const el = sheet && sheet.querySelector('[data-r="latency"]')
      if (el) el.textContent = syncLabel()
    }
    // ---- 音柱：跟随音乐频谱跳动 ----
    // 三根柱子分别对应低频 / 中频 / 高频；起得快、落得慢，看起来更像真的律动
    const BANDS = [[0, 3, 0.95], [3, 16, 1.3], [16, 64, 2.2]]
    const lvl = [0, 0, 0]
    let rafId = 0
    function eqLoop() {
      rafId = requestAnimationFrame(eqLoop)
      const eqs = document.querySelectorAll('.st-eq')
      if (!eqs.length) return
      const tap = ST.audioTap
      const hasTap = !!(tap && tap.analyser)
      const playing = local.isPlaying && !local.isLoading
      if (!hasTap) {
        // 还没接上分析器（汽水下次切歌时才会接上）：先用预设动画
        eqs.forEach(eq => { eq.classList.remove('live'); eq.classList.toggle('idle', !playing) })
        return
      }
      const target = [0, 0, 0]
      if (playing) {
        tap.analyser.getByteFrequencyData(tap.data)
        BANDS.forEach(([a, b, g], i) => {
          let s = 0
          for (let k = a; k < b; k++) s += tap.data[k]
          target[i] = Math.min(1, (s / (b - a) / 255) * g)
        })
      }
      for (let i = 0; i < 3; i++) lvl[i] += (target[i] - lvl[i]) * (target[i] > lvl[i] ? 0.55 : 0.16)
      eqs.forEach(eq => {
        eq.classList.add('live'); eq.classList.remove('idle')
        const bars = eq.children
        for (let i = 0; i < bars.length && i < 3; i++) bars[i].style.height = (3 + 7 * Math.pow(lvl[i], 1.3)).toFixed(1) + 'px'
      })
    }
    rafId = requestAnimationFrame(eqLoop)
    onDispose(() => cancelAnimationFrame(rafId))

    return { render, toast, status, tick, shakeCode }
  })()

  log('core loaded')
}
