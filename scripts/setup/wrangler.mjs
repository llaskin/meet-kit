// The only wrangler commands the setup wizard runs. Each is a fixed argument
// list passed to spawn() without a shell; nothing the person types is ever
// put into argv. Secrets go to `wrangler secret put` on stdin, which wrangler
// reads when it is not attached to a terminal.
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import {
  parseWhoami, findDatabaseId, parseTableNames, parseSecretNames, parseDeployUrl,
  subdomainOnboardingLink,
} from './checks.mjs'

export const DATABASE_NAME = 'meet-kit'
export const SECRET_NAMES = Object.freeze(['GOOGLE_CLIENT_SECRET', 'TURNSTILE_SECRET_KEY', 'ZOHO_CLIENT_SECRET'])

/**
 * Runs wrangler from this repo's node_modules with the current Node binary,
 * so it behaves the same on macOS, Linux and Windows (no npx, no .cmd shims).
 */
export function spawnWrangler(root) {
  const bin = join(root, 'node_modules', 'wrangler', 'bin', 'wrangler.js')
  return (args, { stdin, env = {}, timeoutMs = 120_000 } = {}) =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, [bin, ...args], {
        cwd: root,
        env: { ...process.env, ...env },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (d) => { stdout += d })
      child.stderr.on('data', (d) => { stderr += d })
      const timer = setTimeout(() => child.kill(), timeoutMs)
      child.on('error', (err) => {
        clearTimeout(timer)
        resolve({ code: null, stdout, stderr: `${stderr}${err.message}` })
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        resolve({ code, stdout, stderr })
      })
      // Always close stdin: a command that would otherwise prompt sees EOF
      // and takes its non-interactive path instead of waiting forever.
      child.stdin.end(typeof stdin === 'string' ? stdin : '')
    })
}

export function createWrangler({ run, accountId = () => '' }) {
  const exec = (args, opts = {}) => {
    const env = { NO_COLOR: '1', FORCE_COLOR: '0' }
    const id = accountId()
    if (id) env.CLOUDFLARE_ACCOUNT_ID = id
    return run(args, { ...opts, env })
  }
  const output = (r) => `${r.stdout || ''}${r.stderr || ''}`
  const D1 = ['d1', 'execute', DATABASE_NAME, '--remote', '--yes']

  return {
    async whoami() {
      const r = await exec(['whoami', '--json'])
      return parseWhoami(r.code, r.stdout)
    },
    async login() {
      const r = await exec(['login'], { timeoutMs: 5 * 60_000 })
      return { ok: r.code === 0, output: output(r) }
    },
    async d1List() {
      const r = await exec(['d1', 'list', '--json'])
      return { ok: r.code === 0, id: findDatabaseId(r.stdout, DATABASE_NAME), output: output(r) }
    },
    async d1Create() {
      const r = await exec(['d1', 'create', DATABASE_NAME])
      return { ok: r.code === 0, output: output(r) }
    },
    async applySchema() {
      const r = await exec([...D1, '--file=schema.sql'], { timeoutMs: 180_000 })
      return { ok: r.code === 0, output: output(r) }
    },
    async tables() {
      const r = await exec([...D1, '--json', '--command', "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"])
      return { ok: r.code === 0, names: parseTableNames(r.stdout), output: output(r) }
    },
    async deploy() {
      const r = await exec(['deploy'], { timeoutMs: 300_000 })
      const out = output(r)
      return { ok: r.code === 0, url: parseDeployUrl(out), onboarding: subdomainOnboardingLink(out), output: out }
    },
    async secretNames() {
      const r = await exec(['secret', 'list', '--format', 'json'])
      return { ok: r.code === 0, names: parseSecretNames(r.stdout) }
    },
    async secretPut(name, value) {
      if (!SECRET_NAMES.includes(name)) throw new Error(`refusing to set unknown secret ${name}`)
      const r = await exec(['secret', 'put', name], { stdin: value })
      // Never hand wrangler's output back: on failure it could include the value.
      return { ok: r.code === 0 }
    },
  }
}
