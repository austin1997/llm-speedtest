import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import type { D1Database, D1PreparedStatement, D1Result } from '../../worker/d1';

class SqliteStatement implements D1PreparedStatement {
  private params: unknown[] = [];
  constructor(private readonly db: DatabaseSync, private readonly sql: string) {}
  bind(...values: unknown[]): D1PreparedStatement {
    const statement = new SqliteStatement(this.db, this.sql);
    statement.params = values.map(value => value === undefined ? null : value);
    return statement;
  }
  private statement() { return this.db.prepare(this.sql); }
  async first<T>(column?: string): Promise<T | null> {
    const row = this.statement().get(...(this.params as never[])) as Record<string, unknown> | undefined;
    if (!row) return null;
    return (column ? row[column] : row) as T;
  }
  async run(): Promise<D1Result> {
    const result = this.statement().run(...(this.params as never[]));
    return { results: [], success: true, meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid), duration: 0, rows_read: 0, rows_written: Number(result.changes) } };
  }
  async all<T>(): Promise<D1Result<T>> {
    const results = this.statement().all(...(this.params as never[])) as T[];
    return { results, success: true, meta: { changes: 0, last_row_id: 0, duration: 0, rows_read: results.length, rows_written: 0 } };
  }
}

export class SqliteD1 implements D1Database {
  constructor(private readonly db: DatabaseSync) {}
  prepare(query: string): D1PreparedStatement { return new SqliteStatement(this.db, query); }
  async batch(statements: D1PreparedStatement[]): Promise<D1Result[]> {
    this.db.exec('BEGIN');
    const results: D1Result[] = [];
    try {
      for (const statement of statements) results.push(await statement.run());
      this.db.exec('COMMIT');
      return results;
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* The failed statement may already have closed the transaction. */ }
      throw error;
    }
  }
}

export function openTestDatabase(migrationsDir = new URL('../../migrations/', import.meta.url)): SqliteD1 {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  for (const file of readdirSync(migrationsDir).filter(name => name.endsWith('.sql')).sort()) db.exec(readFileSync(new URL(file, migrationsDir), 'utf8'));
  return new SqliteD1(db);
}
