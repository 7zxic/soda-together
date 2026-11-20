// 一起听 - 注入到汽水主窗口入口脚本最前面执行（早于汽水自己的服务初始化）
;(function () {
  if (window.__sodaTogether) return
  const orig = window.transportPort
  if (!orig) return

  // ---- 1. 接管 transportPort：汽水的消息照常转发，插件自己的请求/回调由插件处理 ----
  const PREFIX = 'st-'
  const pending = new Map() // requestId -> resolve(return)
  const callbacks = new Map() // callbackId -> fn
  let appCb = null
  const early = []

  orig.receiveTransport((msg) => {
    try {
      if (msg && msg.type === 'method.return' && typeof msg.requestId === 'string' && msg.requestId.startsWith(PREFIX)) {
        const done = pending.get(msg.requestId)
        pending.delete(msg.requestId)
        if (done) done(msg.return)
        return
      }
      if (msg && msg.type === 'method.callback' && typeof msg.callbackId === 'string' && msg.callbackId.startsWith(PREFIX)) {
        const fn = callbacks.get(msg.callbackId)
        if (fn) fn(...(msg.arguments || []))
        return
      }
    } catch (e) { console.error('[soda-together]', e) }
    if (appCb) appCb(msg)
    else early.push(msg)
  })

  window.transportPort = {
    registerTransport: (...a) => orig.registerTransport(...a),
    sendTransport: (...a) => orig.sendTransport(...a),
    receiveTransport: (cb) => {
      appCb = cb
      while (early.length) cb(early.shift())
    },
  }

  const uid = () => PREFIX + Math.random().toString(36).slice(2) + Date.now().toString(36)

  // 调用汽水内部服务。参数里的函数会变成回调（用于订阅）。
  function invoke(serviceId, method, args = [], timeout = 8000) {
    return new Promise((resolve, reject) => {
      const requestId = uid()
      const cbs = {}
      const plainArgs = args.map((a, i) => {
        if (typeof a !== 'function') return a
        const id = uid()
        callbacks.set(id, a)
        cbs[i] = id
        return null
      })
      const timer = setTimeout(() => { pending.delete(requestId); reject(new Error('超时 ' + serviceId + '.' + method)) }, timeout)
      pending.set(requestId, (ret) => {
        clearTimeout(timer)
        ret && ret.type === 'success' ? resolve(ret.result) : reject(new Error(ret ? ret.error : 'no return'))
      })
      orig.sendTransport(JSON.parse(JSON.stringify({
        type: 'method.invoke', fromWorkerId: 'rendererMain', toServiceId: serviceId,
        methodName: method, requestId, arguments: plainArgs, callbacks: cbs,
      })))
    })
  }

  // 开发模式由安装器 --dev 打开：显示调试框、启用本机热加载
  const DEV_MODE = !!window.__SODA_TOGETHER_DEV__

  // ---- 2. 状态框（仅开发模式） ----
  const results = {}
  let badge
  if (DEV_MODE) setInterval(() => {
    if (!document.body) return
    if (!badge) {
      badge = document.createElement('div')
      badge.style.cssText = 'position:fixed;left:12px;bottom:96px;z-index:2147483647;max-width:560px;padding:8px 10px;background:rgba(0,0,0,.85);color:#7CFC00;font:12px/1.5 monospace;white-space:pre-wrap;word-break:break-all;pointer-events:none;border-radius:8px;border:1px solid #7CFC00'
      document.body.appendChild(badge)
    }
    const entries = Object.entries(results)
    badge.style.display = entries.length ? '' : 'none'
    badge.textContent = '【一起听】\n' + entries.map(([k, v]) => k + ': ' + v).join('\n')
  }, 1000)

  // ---- 3. 开发日志 + 热加载（仅开发模式） ----
  const DEV = 'http://127.0.0.1:17890'
  function log(...a) {
    if (!DEV_MODE) return
    try { fetch(DEV + '/log', { method: 'POST', body: JSON.stringify(a) }).catch(() => {}) } catch {}
  }
  // 汽水注册好通道且底部播放栏渲染出来后，才能调用内部服务
  let readyPromise = null
  function whenAppReady() {
    if (!readyPromise) readyPromise = new Promise((resolve) => {
      const check = () => {
        if (appCb && document.querySelector('.bottom-player')) return setTimeout(resolve, 500)
        setTimeout(check, 300)
      }
      check()
    })
    return readyPromise
  }

  const api = { invoke, results, log, whenAppReady, version: 3, dev: DEV_MODE }
  window.__sodaTogether = api
  if (!DEV_MODE) return

  let lastDev = ''
  async function pollDev() {
    try {
      const r = await fetch(DEV + '/dev.js', { cache: 'no-store' })
      const code = await r.text()
      if (code && code !== lastDev) {
        lastDev = code
        try { await new Function('ST', code)(api) } catch (e) { log('dev.js error', String(e && e.stack || e)) }
      }
    } catch {}
  }
  setInterval(pollDev, 2000)
  results.状态 = '已加载 v3（开发模式）'
})()
