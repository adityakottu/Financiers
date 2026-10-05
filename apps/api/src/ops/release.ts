import { Client } from 'pg';
import { createDb } from '../db/db';
import { migrate } from '../db/migrate';
import { applyRoles } from '../db/roles';
import { seed, syncReferenceData } from '../db/seed';
import { ownerUrl } from './db-url';

/**
 * The one-off task run on every deploy, before the new version takes traffic (doc 13 §4), as the
 * schema owner (MIGRATE_DATABASE_URL — never the app's own connection):
 *   1. apply pending migrations (each in its own transaction; edited migrations are refused)
 *   2. sync permissions, system roles and numbering formats with this build
 *   3. first deploy only: create the Super Admin (SEED_ADMIN_PASSWORD; must be changed at first sign-in)
 *   4. re-apply the least-privilege database roles (new tables get the right grants)
 *   5. set fin_app's password from the secret (FIN_APP_PASSWORD), if given
 *   node dist/ops/release.js
 */
async function main() {
  const url = ownerUrl();
  if (!url) throw new Error('The schema owner is required: MIGRATE_DATABASE_URL, or DB_OWNER_USERNAME + DB_OWNER_PASSWORD + DB_HOST');
  const log = (m: string) => process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), level: 'info', context: 'release', msg: m })}\n`);
  await migrate(url, log);
  const db = createDb(url, 2);
  try {
    if (process.env.SEED_ADMIN_PASSWORD) {
      await seed(db, { adminUsername: process.env.SEED_ADMIN_USERNAME ?? 'admin', adminPassword: process.env.SEED_ADMIN_PASSWORD, companyName: process.env.SEED_COMPANY_NAME ?? 'Financiers Pvt Ltd' });
      log('reference data synced; Super Admin present');
    } else {
      await syncReferenceData(db);
      log('reference data synced');
    }
  } finally {
    await db.destroy();
  }
  await applyRoles(url);
  log('database roles applied');
  if (process.env.FIN_APP_PASSWORD) {
    const c = new Client({ connectionString: url });
    await c.connect();
    try {
      // ALTER ROLE takes no bind parameters: PostgreSQL itself quotes the value (format %L).
      const stmt = await c.query<{ s: string }>("SELECT format('ALTER ROLE fin_app PASSWORD %L', $1::text) s", [process.env.FIN_APP_PASSWORD]);
      await c.query(stmt.rows[0]!.s);
    } finally {
      await c.end();
    }
    log('fin_app password set from the secret');
  }
  log('release tasks complete');
}

main().catch((e) => {
  process.stderr.write(`${JSON.stringify({ ts: new Date().toISOString(), level: 'error', context: 'release', msg: (e as Error).message })}\n`);
  process.exit(1);
});
