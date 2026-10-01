// Real-SQLite stand-in for a D1 binding, loading the project's one schema.sql.
// Mirrors the adapter the source tests defined inline, plus batch().
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export const SCHEMA = readFileSync(fileURLToPath(new URL('../../schema.sql', import.meta.url)), 'utf8')

export function realDB() {
  const db = new DatabaseSync(':memory:')
  db.exec(SCHEMA)
  const wrap = (sql) => ({
    args: [],
    bind(...a) { this.args = a; return this },
    async run() {
      const r = db.prepare(sql).run(...this.args)
      return { success: true, meta: { changes: Number(r.changes) } }
    },
    async first() { return db.prepare(sql).get(...this.args) ?? null },
    async all() { return { results: db.prepare(sql).all(...this.args) } },
  })
  return {
    raw: db,
    prepare: wrap,
    async batch(stmts) {
      db.exec('BEGIN')
      try {
        const out = []
        for (const s of stmts) out.push(await s.run())
        db.exec('COMMIT')
        return out
      } catch (e) { db.exec('ROLLBACK'); throw e }
    },
  }
}
