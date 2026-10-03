import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';

/** Creates / refreshes the least-privilege roles (roles.sql). Run as the database owner after migrating. */
export async function applyRoles(databaseUrl: string) {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query(readFileSync(join(__dirname, 'roles.sql'), 'utf8'));
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  applyRoles(url)
    .then(() => console.log('roles applied: fin_app, fin_readonly, fin_audit (set their passwords from the secrets manager)'))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
