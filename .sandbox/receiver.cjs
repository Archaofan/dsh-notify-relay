/**
 * Loopback receiver for the notify-relay delivery test.
 *
 * The plugin POSTs to whatever URL a channel is configured with, so the honest
 * way to prove the delivery path is a real socket: this process listens on
 * 12998, records every request verbatim (method, headers, body) to a JSON file,
 * and answers 200. If the payload builder is wrong, this file is the evidence.
 */
const http = require('http')
const fs = require('fs')

const PORT = Number(process.argv[2] || 12998)
const OUT = process.argv[3] || 'E:\\DSH-Workspace\\DSH-Notify\\.sandbox\\received.json'
const received = []

const server = http.createServer((req, res) => {
  const chunks = []
  req.on('data', (chunk) => chunks.push(chunk))
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8')
    const entry = {
      method: req.method,
      url: req.url,
      headers: req.headers,
      body,
      at: new Date().toISOString(),
    }
    received.push(entry)
    fs.writeFileSync(OUT, JSON.stringify(received, null, 2), 'utf8')
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true }))
  })
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`receiver listening on 127.0.0.1:${PORT}, writing to ${OUT}`)
})

server.on('error', (error) => {
  console.log(`receiver error: ${error.message}`)
  process.exit(1)
})
