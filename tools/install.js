// 用法: node install.js [install|restore|status]
// install: 备份原始 main.asar (main.asar.orig)，然后把 plugin/ 目录注入进去
// restore: 用备份还原原始 main.asar
'use strict'
const fs = require('fs')
const path = require('path')
const { readAsar, writeAsar } = require('./asar')

const MARK = '<!-- soda-together -->'

function findSoda() {
  const base = process.env.SODA_DIR || path.join(process.env.LOCALAPPDATA, 'Programs', 'Soda Music')
  // 汽水会把界面热更新包下载到 Packages/<版本>/，存在时优先加载它，而不是安装目录里的 resources/
  let dir, version
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(base, 'Packages', 'config.json'), 'utf8'))
    const d = path.join(base, 'Packages', pkg.latestVersion)
    if (pkg.latestVersion && fs.existsSync(path.join(d, 'main.asar'))) { dir = d; version = pkg.latestVersion + '（热更新包）' }
  } catch {}
  if (!dir) {
    const cfg = JSON.parse(fs.readFileSync(path.join(base, 'launcher_config.json'), 'utf8'))
    dir = path.join(base, cfg.cur_path, 'resources')
    version = cfg.cur_path
  }
  return { base, version, asar: path.join(dir, 'main.asar'), orig: path.join(dir, 'main.asar.orig') }
}

function pluginFiles() {
  const dir = path.join(__dirname, '..', 'plugin')
  const out = []
  ;(function walk(d, rel) {
    for (const n of fs.readdirSync(d)) {
      const full = path.join(d, n)
      const r = rel ? rel + '/' + n : n
      if (fs.statSync(full).isDirectory()) walk(full, r)
      else out.push([r, fs.readFileSync(full)])
    }
  })(dir, '')
  return out
}

// 汽水运行时会按启动时读到的偏移读取 asar，此时改文件会让它读到错位的数据
function assertSodaClosed() {
  try {
    const out = require('child_process').execSync('tasklist /FI "IMAGENAME eq SodaMusic.exe" /NH', { encoding: 'utf8' })
    if (/SodaMusic\.exe/i.test(out)) {
      console.error('汽水音乐正在运行，请先完全退出（包括托盘图标）再操作')
      process.exit(2)
    }
  } catch (e) { if (e.status === 2) throw e }
}

function install() {
  assertSodaClosed()
  const s = findSoda()
  if (!fs.existsSync(s.orig)) {
    fs.copyFileSync(s.asar, s.orig)
    console.log('已备份原始文件 ->', s.orig)
  }
  const { files } = readAsar(s.orig)
  const html = files.get('main.html')
  if (!html) throw new Error('main.asar 里没有 main.html，版本可能不兼容')
  const text = html.data.toString('utf8')
  // 找到入口模块脚本，把插件代码插到它最前面（main.html 里额外加 <script> 不会被执行）
  const m = text.match(/<script type="module"[^>]*src="\.\/([^"]+)"/)
  if (!m) throw new Error('找不到入口脚本，版本可能不兼容')
  const entryPath = m[1]
  const entry = files.get(entryPath)
  if (!entry) throw new Error('入口脚本不存在: ' + entryPath)
  if (entry.data.toString('utf8', 0, 200).includes(MARK)) throw new Error('备份文件已被修改过，请先手动恢复')
  // together.js（通道层）必须最先执行，其余脚本按文件名顺序
  const order = ([a], [b]) => (a === 'together.js' ? -1 : b === 'together.js' ? 1 : a.localeCompare(b))
  const plugin = pluginFiles().filter(([rel]) => rel.endsWith('.js')).sort(order).map(([rel, data]) => `/* ${rel} */\n` + data.toString('utf8')).join('\n;\n')
  const devFlag = process.argv.includes('--dev') ? 'window.__SODA_TOGETHER_DEV__=true;\n' : ''
  const prefix = `/* ${MARK} */\n;try{(function(){\n${devFlag}${plugin}\n})()}catch(e){console.error('[soda-together]',e)}\n`
  files.set(entryPath, { entry: entry.entry, data: Buffer.concat([Buffer.from(prefix, 'utf8'), entry.data]) })
  console.log('注入入口脚本:', entryPath)
  writeAsar(s.asar, files)
  console.log(`已注入到汽水音乐 ${s.version}，重启汽水生效`)
}

function restore() {
  assertSodaClosed()
  const s = findSoda()
  if (!fs.existsSync(s.orig)) return console.log('没有备份，无需还原')
  fs.copyFileSync(s.orig, s.asar)
  fs.unlinkSync(s.orig)
  console.log('已还原原始 main.asar')
}

function status() {
  const s = findSoda()
  const { files } = readAsar(s.asar)
  const m = files.get('main.html').data.toString('utf8').match(/<script type="module"[^>]*src="\.\/([^"]+)"/)
  const injected = !!m && files.get(m[1]).data.toString('utf8', 0, 200).includes(MARK)
  console.log(`汽水音乐 ${s.version}: ${injected ? '已注入' : '未注入'}${fs.existsSync(s.orig) ? '（有备份）' : ''}`)
}

const cmd = process.argv[2] || 'status'
;({ install, restore, status }[cmd] || (() => console.log('用法: node install.js [install|restore|status]')))()
