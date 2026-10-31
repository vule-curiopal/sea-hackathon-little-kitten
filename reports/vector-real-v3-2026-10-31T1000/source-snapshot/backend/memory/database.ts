import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';

export type Row = Record<string, unknown>;
export interface QueryResult<T = Row> { rows: T[]; rowCount: number }
export interface Queryable {
  query<T = Row>(sql: string, values?: unknown[]): Promise<QueryResult<T>>;
  exec(sql: string): Promise<void>;
}
export interface Database extends Queryable {
  transaction<T>(work: (tx: Queryable) => Promise<T>): Promise<T>;
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
}

export async function createDatabase(options: { databaseUrl?: string; dataDir?: string; vectorExtension?: boolean } = {}): Promise<Database> {
  if (options.databaseUrl) {
    const pool = new pg.Pool({
      connectionString: options.databaseUrl, max: 5, connectionTimeoutMillis: 10_000,
      // SQL DATE is a calendar date, not a midnight instant. pg's default Date
      // conversion shifts Vietnam dates backwards when later serialized as UTC.
      // Keep the same exact YYYY-MM-DD representation returned by PGlite.
      types: { getTypeParser(oid, format) {
        return oid === pg.types.builtins.DATE && format !== 'binary'
          ? (value: string) => value
          : pg.types.getTypeParser(oid, format);
      } },
    });
    const wrap = (client: pg.Pool | pg.PoolClient, sequential = false): Queryable & { settled(): Promise<unknown> } => {
      let pending: Promise<unknown> = Promise.resolve();
      const run = <T>(work: () => Promise<T>): Promise<T> => {
        if (!sequential) return work();
        const next = pending.then(work);
        pending = next.catch(() => undefined);
        return next;
      };
      return {
        async exec(sql) { await run(() => client.query(sql)); },
        async query<T>(sql: string, values: unknown[] = []) {
          const result = await run(() => client.query(sql, values));
          return { rows: result.rows as T[], rowCount: result.rowCount ?? 0 };
        },
        settled: () => pending,
      };
    };
    return {
      ...wrap(pool),
      async transaction(work) {
        const client = await pool.connect();
        // Promise.all callers may batch independent reads, but a transaction's
        // single connection must execute one query at a time (required by pg 9).
        const transaction = wrap(client, true);
        try {
          await client.query('BEGIN');
          const result = await work(transaction);
          await transaction.settled();
          await client.query('COMMIT');
          return result;
        } catch (error) { await transaction.settled(); await client.query('ROLLBACK'); throw error; }
        finally { client.release(); }
      },
      async exec(sql) { await pool.query(sql); },
      async close() { await pool.end(); },
    };
  }
  // The pinned 0.3.x package bundles this optional extension. Do not load it for
  // feature-off startup; newer split-package upgrades require separate review.
  const vector = options.vectorExtension ? (await import('@electric-sql/pglite/vector')).vector : undefined;
  const lite = vector ? new PGlite({ dataDir: options.dataDir, extensions: { vector } }) : new PGlite(options.dataDir);
  await lite.waitReady;
  const wrap = (client: Pick<PGlite, 'query' | 'exec'>): Queryable => ({
    async exec(sql) { await client.exec(sql); },
    async query<T>(sql: string, values: unknown[] = []) {
      const result = await client.query<T>(sql, values);
      // PGlite 0.3.x returns DATE as UTC-midnight Date, whereas native pg is
      // configured above to preserve calendar strings. Normalize only DATE OID;
      // timestamps remain real instants, independent of the process timezone.
      const dates = result.fields.filter(field => field.dataTypeID === 1082).map(field => field.name);
      const rows = dates.length ? result.rows.map(row => {
        const copy = { ...row } as Record<string, unknown>;
        for (const name of dates) if (copy[name] instanceof Date) copy[name] = (copy[name] as Date).toISOString().slice(0, 10);
        return copy as T;
      }) : result.rows;
      return { rows, rowCount: result.affectedRows ?? result.rows.length };
    },
  });
  return {
    ...wrap(lite),
    async transaction(work) { return lite.transaction(async (tx) => work(wrap(tx as Pick<PGlite, 'query' | 'exec'>))); },
    async exec(sql) { await lite.exec(sql); },
    async close() { await lite.close(); },
  };
}

export async function migrate(db: Database): Promise<void> {
  await db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
  const directory = fileURLToPath(new URL('./migrations/', import.meta.url));
  for (const name of (await readdir(directory)).filter((name) => name.endsWith('.sql')).sort()) {
    await db.transaction(async (tx) => {
      // Serialize migrations across processes without requiring extensions.
      await tx.query('LOCK TABLE schema_migrations IN EXCLUSIVE MODE');
      if ((await tx.query('SELECT name FROM schema_migrations WHERE name=$1', [name])).rows.length) return;
      const sql = await readFile(`${directory}/${name}`, 'utf8');
      await tx.exec(sql);
      await tx.query('INSERT INTO schema_migrations(name) VALUES ($1)', [name]);
    });
  }
}
