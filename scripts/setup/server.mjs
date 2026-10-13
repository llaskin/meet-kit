#!/usr/bin/env node
// `npm run setup`: a local web page that walks through deploying meet-kit to
// Cloudflare (DEPLOY-AGENT.md steps 1-10). This server runs wrangler and
// receives secrets, so it only listens on 127.0.0.1, requires a per-run random
// token on every request, refuses foreign Host and Origin headers (DNS
// rebinding, other sites in the same browser), and runs one action at a time.
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createSetup } from './steps.mjs'
import { spawnWrangler } from './wrangler.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const MAX_BODY = 64 * 1024
const ACTIONS = new Set([
  'login', 'chooseAccount', 'saveProfile', 'setupDatabase', 'firstDeploy',
  'saveGoogle', 'saveTurnstile', 'saveAccess', 'lockCheck', 'tick',
])

function sameToken(given, token) {
  const a = Buffer.from(String(given || ''))
  const b = Buffer.from(token)
  return a.length === b.length && timingSafeEqual(a, b)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size <= MAX_BODY) chunks.push(c)
    })
    // Drain an oversized body rather than destroying the socket, so the 413
    // reply can still be sent.
    req.on('end', () => {
      if (size > MAX_BODY) reject(Object.assign(new Error('too large'), { status: 413 }))
      else resolve(Buffer.concat(chunks).toString('utf8'))
    })
    req.on('error', reject)
  })
}

export function createWizardServer({ setup, token, pageHtml = readFileSync(join(HERE, 'page.html'), 'utf8') }) {
  let busy = false

  const send = (res, status, body, headers = {}) => {
    const isJson = typeof body !== 'string'
    res.writeHead(status, {
      'content-type': isJson ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      ...headers,
    })
    res.end(isJson ? JSON.stringify(body) : body)
  }

  return createServer(async (req, res) => {
    const port = req.socket.localPort
    const host = req.headers.host || ''
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return send(res, 403, 'Forbidden')
    const url = new URL(req.url || '/', `http://${host}`)

    if (url.pathname === '/') {
      if (req.method !== 'GET') return send(res, 405, 'Method not allowed')
      if (!sameToken(url.searchParams.get('t'), token)) return send(res, 403, 'Open the link printed in the terminal.')
      const nonce = randomBytes(16).toString('base64')
      const html = pageHtml.replaceAll('__SETUP_TOKEN__', token).replaceAll('__NONCE__', nonce)
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
        'content-security-policy': [
          "default-src 'none'", `script-src 'nonce-${nonce}'`, "style-src 'unsafe-inline'",
          "connect-src 'self'", "img-src data:", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'",
        ].join('; '),
      })
      return res.end(html)
    }

    if (!url.pathname.startsWith('/api/')) return send(res, 404, 'Not found')
    if (!sameToken(req.headers['x-setup-token'], token)) return send(res, 403, { error: 'Forbidden' })
    const origin = req.headers.origin
    if (origin !== undefined && origin !== `http://${host}`) return send(res, 403, { error: 'Forbidden' })

    if (url.pathname === '/api/status') {
      if (req.method !== 'GET') return send(res, 405, { error: 'Method not allowed' })
      return send(res, 200, setup.status())
    }

    const action = url.pathname.slice('/api/'.length)
    if (!ACTIONS.has(action)) return send(res, 404, { error: 'Not found' })
    if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed' })
    if (!/^application\/json\b/.test(req.headers['content-type'] || '')) return send(res, 415, { error: 'JSON only' })
    if (busy) return send(res, 409, { result: { ok: false, message: 'Another step is still running. Wait for it to finish.' } })

    busy = true
    try {
      let input
      try {
        input = JSON.parse((await readBody(req)) || '{}')
      } catch (err) {
        if (err.status === 413) return send(res, 413, { error: 'Too large' })
        return send(res, 400, { error: 'Bad JSON' })
      }
      console.log(`[setup] ${action}`)
      let result
      try {
        result = await setup[action](input)
      } catch (err) {
        return send(res, 500, { result: { ok: false, message: `Unexpected error: ${err instanceof Error ? err.message : err}` }, status: setup.status() })
      }
      return send(res, 200, { result, status: setup.status() })
    } finally {
      busy = false
    }
  })
}

function openBrowser(url) {
  const [cmd, args] = process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
    : ['xdg-open', [url]]
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true, windowsHide: true }).on('error', () => {}).unref()
  } catch {}
}

function main() {
  const root = join(HERE, '..', '..')
  const [major, minor] = process.versions.node.split('.').map(Number)
  if (major < 22 || (major === 22 && minor < 13)) {
    console.error(`meet-kit needs Node.js 22.13 or newer; this is ${process.versions.node}. Install the current LTS from https://nodejs.org and try again.`)
    process.exit(1)
  }
  if (!existsSync(join(root, 'node_modules', 'wrangler', 'bin', 'wrangler.js'))) {
    console.error('Run `npm install` first, then `npm run setup` again.')
    process.exit(1)
  }
  const token = randomBytes(32).toString('hex')
  const setup = createSetup({ root, run: spawnWrangler(root) })
  const server = createWizardServer({ setup, token })
  server.listen(0, '127.0.0.1', () => {
    const link = `http://127.0.0.1:${server.address().port}/?t=${token}`
    console.log('\nmeet-kit setup is running. If your browser did not open, open this link:\n')
    console.log(`  ${link}\n`)
    console.log('Keep this window open until you are done. Press Ctrl+C to stop.\n')
    if (!process.argv.includes('--no-open')) openBrowser(link)
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
