export interface SqliteStatement {
  run: (...params: never[]) => { changes: number | bigint }
  get: (...params: never[]) => unknown
  all: (...params: never[]) => unknown[]
}

/** The slice of better-sqlite3 and node:sqlite that the repositories use. */
export interface SqliteHandle {
  exec: (sql: string) => unknown
  prepare: (sql: string) => SqliteStatement
}

export function isUniqueViolation(error: unknown, column: string): boolean {
  return (
    error instanceof Error &&
    error.message.includes(`UNIQUE constraint failed`) &&
    error.message.includes(column)
  )
}

/** One `BEGIN IMMEDIATE` around a synchronous step: all its writes commit, or none does. */
export function runInTransaction<T>(db: SqliteHandle, work: () => T): T {
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = work()
    db.exec('COMMIT')
    return result
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}
