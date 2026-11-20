// 一起听 - 注入到汽水主窗口入口脚本最前面执行（早于汽水自己的服务初始化）
;(function () {
  if (window.__sodaTogether) return
  const orig = window.transportPort
  if (!orig) return

  const VERSION = window.__SODA_TOGETHER_VERSION__ || 'dev'
  const TEST = window.__SODA_TOGETHER_TEST__ || {}

  // ---- 0. 兼容性保护：汽水更新后如果插件和新版本不兼容，宁可不启动，也不能让汽水白屏 ----
  // 用汽水入口脚本的文件名当「汽水版本标识」（每次汽水更新文件名里的哈希都会变）
  const BUILD = (() => {
    try {
      const s = document.querySelector('script[type="module"][src]')
      return s ? s.getAttribute('src').split('/').pop() : location.pathname
    } catch { return '' }
  })()
  const DISABLED_KEY = 'sodaTogether.disabled'
  const readDisabled = () => { try { return JSON.parse(localStorage.getItem(DISABLED_KEY) || 'null') } catch { return null } }
  const off = readDisabled()
  if (off && off.build === BUILD && off.version === VERSION) {
    // 上次在这个汽水版本上出过问题：这次不接管，汽水原样运行。汽水或插件更新后会自动再试
    console.warn('[soda-together] 已在此汽水版本上停用：', off.reason)
    window.__sodaTogether = { disabled: true, reason: off.reason }
    return
  }
  function disableAndReload(reason) {
    try { localStorage.setItem(DISABLED_KEY, JSON.stringify({ build: BUILD, version: VERSION, reason, at: Date.now() })) } catch {}
    console.warn('[soda-together] 与当前汽水版本不兼容，已停用并刷新：', reason)
    if (TEST.onDisable) return TEST.onDisable(reason)
    location.reload()
  }

  // 通道结构必须和预期完全一致才接管；汽水改了内部实现就直接不启动
  const EXPECTED = ['receiveTransport', 'registerTransport', 'sendTransport']
  const keys = Object.keys(orig).sort()
  if (keys.join() !== EXPECTED.join() || EXPECTED.some(k => typeof orig[k] !== 'function')) {
    console.warn('[soda-together] 汽水内部结构已变化，插件不启动：', keys.join())
    window.__sodaTogether = { disabled: true, reason: 'shape ' + keys.join() }
    return
  }

  // ---- 1. 接管 transportPort：汽水的消息照常转发，插件自己的请求/回调由插件处理 ----
  const PREFIX = 'st-'
  const pending = new Map() // requestId -> resolve(return)
  const callbacks = new Map() // callbackId -> fn
  let appCb = null
  const early = []
  let forwarded = 0
  let errors = 0
  let passthrough = false // 插件自己处理消息时反复出错，就只转发，不再拦截

  orig.receiveTransport((msg) => {
    if (!passthrough) {
      const ours = msg && ((msg.type === 'method.return' && typeof msg.requestId === 'string' && msg.requestId.startsWith(PREFIX)) ||
        (msg.type === 'method.callback' && typeof msg.callbackId === 'string' && msg.callbackId.startsWith(PREFIX)))
      if (ours) {
        try {
          if (msg.type === 'method.return') {
            const done = pending.get(msg.requestId)
            pending.delete(msg.requestId)
            if (done) done(msg.return)
          } else {
            const fn = callbacks.get(msg.callbackId)
            if (fn) fn(...(msg.arguments || []))
          }
        } catch (e) {
          console.error('[soda-together]', e)
          if (++errors >= 20) passthrough = true
        }
        return
      }
    }
    forwarded++
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

  // 看门狗：一段时间后汽水界面还没正常起来（没注册接收、没收到任何消息、页面是空的），
  // 就当作和这个版本不兼容：记下来并刷新，刷新后插件不再接管，汽水原样运行
  setTimeout(() => {
    const root = document.getElementById('app')
    const rendered = !!(root && root.children.length)
    if (appCb && forwarded > 0 && rendered) return
    disableAndReload(!appCb ? 'app never registered' : !forwarded ? 'no messages' : 'app not rendered')
  }, TEST.watchMs || 45000)

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

  const api = { invoke, results, log, whenAppReady, version: VERSION, dev: DEV_MODE }
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
  results.状态 = '已加载 ' + VERSION + '（开发模式）'
})()
