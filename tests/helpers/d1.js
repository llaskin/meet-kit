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
    sql, args: [],
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
    // Zero yield points between BEGIN and COMMIT: two "concurrent" batch()
    // calls on this one shared synchronous connection must not interleave,
    // or the second's BEGIN throws "cannot start a transaction within a
    // transaction" while the first is still open. A per-statement `await`
    // here (even though run() itself has no internal await) hands control
    // back to the microtask queue mid-transaction, which is exactly the gap
    // a second pending continuation can land in. Mirrors the source tests'
    // inline fixture, which ran its batch loop synchronously for the same
    // reason.
    async batch(stmts) {
      db.exec('BEGIN')
      try {
        const out = stmts.map((s) => {
          const r = db.prepare(s.sql).run(...s.args)
          return { success: true, meta: { changes: Number(r.changes) } }
        })
        db.exec('COMMIT')
        return out
      } catch (e) { db.exec('ROLLBACK'); throw e }
    },
  }
}
