// 开发用：接收插件日志 (POST /log)，并提供热加载脚本 (GET /dev.js -> tools/dev.js)。 node devlog.js
'use strict'
const http = require('http')
const fs = require('fs')
const path = require('path')
const LOG = path.join(__dirname, 'devlog.txt')
const DEV = path.join(__dirname, 'dev.js')
http.createServer((req, res) => {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' }
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end() }
  if (req.method === 'GET' && req.url.startsWith('/dev.js')) {
    res.writeHead(200, { ...cors, 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' })
    return res.end(fs.existsSync(DEV) ? fs.readFileSync(DEV) : '')
  }
  let body = ''
  req.on('data', c => { body += c })
  req.on('end', () => {
    res.writeHead(200, cors)
    res.end('ok')
    if (req.method !== 'POST') return
    const line = new Date().toISOString().slice(11, 23) + ' ' + body + '\n'
    process.stdout.write(line.slice(0, 2000))
    fs.appendFileSync(LOG, line)
  })
}).listen(17890, '127.0.0.1', () => console.log('devlog listening on 17890'))
