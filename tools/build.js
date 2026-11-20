// 构建：打包插件脚本 → 编译安装器 SodaTogether.exe → 生成 SHA256SUMS.txt
// 用法: node tools/build.js            （本机和 GitHub Actions 用同一条命令）
// 只需要 Node.js 和 Windows 自带的 .NET Framework 4.x 编译器 csc.exe，不需要安装 .NET SDK。
'use strict'
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { execFileSync } = require('child_process')

const root = path.join(__dirname, '..')
const dist = path.join(root, 'dist')
const version = fs.readFileSync(path.join(root, 'VERSION'), 'utf8').trim()
if (!/^\d+\.\d+\.\d+([-.][0-9A-Za-z.]+)?$/.test(version)) throw new Error('VERSION 格式不对: ' + version)
const repo = process.env.GITHUB_REPOSITORY ? `https://github.com/${process.env.GITHUB_REPOSITORY}` : (process.env.REPO_URL || 'https://github.com/')
const MARK = '<!-- soda-together -->'

fs.rmSync(dist, { recursive: true, force: true })
fs.mkdirSync(dist, { recursive: true })

// 1. 插件脚本（正式版，不带开发模式）。开头的标记和版本号供安装器识别。
const read = f => fs.readFileSync(path.join(root, 'plugin', f), 'utf8')
const plugin = ['together.js', 'core.js'].map(f => `/* ${f} */\n` + read(f)).join('\n;\n')
const bundle = `/* ${MARK} soda-together v${version} */\n;try{(function(){\nwindow.__SODA_TOGETHER_VERSION__=${JSON.stringify(version)};\nwindow.__SODA_TOGETHER_REPO__=${JSON.stringify(process.env.GITHUB_REPOSITORY || '7zxic/soda-together')};\n${plugin}\n})()}catch(e){console.error('[soda-together]',e)}\n`
const bundlePath = path.join(dist, 'soda-together.js')
fs.writeFileSync(bundlePath, bundle, 'utf8')

// 2. 构建信息
const v4 = version.replace(/[-+].*$/, '').split('.').concat(['0', '0', '0']).slice(0, 4).join('.')
fs.writeFileSync(path.join(root, 'installer', 'BuildInfo.g.cs'), `// 由 tools/build.js 生成，请勿手改
using System.Reflection;
[assembly: AssemblyTitle("汽水音乐 · 一起听 安装器")]
[assembly: AssemblyProduct("汽水音乐 · 一起听")]
[assembly: AssemblyDescription("给汽水音乐电脑版加上双人一起听")]
[assembly: AssemblyVersion("${v4}")]
[assembly: AssemblyFileVersion("${v4}")]
[assembly: AssemblyInformationalVersion("${version}")]
namespace SodaTogether { static class BuildInfo { public const string Version = "${version}"; public const string RepoUrl = "${repo}"; } }
`, 'utf8')

// 3. 图标
if (!fs.existsSync(path.join(root, 'installer', 'icon.ico'))) execFileSync(process.execPath, [path.join(__dirname, 'make-icon.js')], { stdio: 'inherit' })

// 4. 编译
const csc = process.env.CSC || path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe')
if (!fs.existsSync(csc)) throw new Error('找不到 csc.exe: ' + csc)
const exe = path.join(dist, 'SodaTogether.exe')
const sources = fs.readdirSync(path.join(root, 'installer')).filter(f => f.endsWith('.cs')).map(f => path.join(root, 'installer', f))
execFileSync(csc, [
  '/nologo', '/target:winexe', '/optimize+', '/codepage:65001', '/warn:4',
  '/out:' + exe,
  '/win32manifest:' + path.join(root, 'installer', 'app.manifest'),
  '/win32icon:' + path.join(root, 'installer', 'icon.ico'),
  `/resource:${bundlePath},soda-together.js`,
  '/r:System.dll', '/r:System.Core.dll', '/r:System.Drawing.dll', '/r:System.Windows.Forms.dll', '/r:Microsoft.CSharp.dll',
  ...sources,
], { stdio: 'inherit' })

// 5. SHA256SUMS.txt
const sums = ['SodaTogether.exe', 'soda-together.js'].map(f => crypto.createHash('sha256').update(fs.readFileSync(path.join(dist, f))).digest('hex') + '  ' + f)
fs.writeFileSync(path.join(dist, 'SHA256SUMS.txt'), sums.join('\n') + '\n')
console.log(`\n✓ v${version}`)
console.log('  ' + exe + '  ' + (fs.statSync(exe).size / 1024).toFixed(1) + ' KB')
console.log(sums.map(s => '  ' + s).join('\n'))
