import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';

export const MIGRATIONS_DIR = join(__dirname, 'migrations');

/** Migration files shipped with this build (the readiness check compares them with the database). */
export const shippedMigrations = () => readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();

/** Applies pending SQL migrations in order, each in its own transaction. Refuses edited migrations. */
export async function migrate(databaseUrl: string, log: (m: string) => void = console.log) {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
    await client.query('SELECT pg_advisory_lock(7314000)');
    const applied = new Map(
      (await client.query<{ version: string; checksum: string }>('SELECT version, checksum FROM schema_migrations'))
        .rows.map((r) => [r.version, r.checksum]),
    );
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const prior = applied.get(file);
      if (prior) {
        if (prior !== checksum) throw new Error(`Migration ${file} was modified after being applied`);
        continue;
      }
      log(`applying ${file}`);
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)', [file, checksum]);
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(7314000)').catch(() => undefined);
    await client.end();
  }
}

if (require.main === module) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  migrate(url).then(
    () => console.log('migrations up to date'),
    (e) => {
      console.error(e);
      process.exit(1);
    },
  );
}
