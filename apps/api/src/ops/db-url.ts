/**
 * The schema owner's connection URL for the release, backup and restore-drill tasks. On AWS the
 * owner's credentials live in the RDS-managed secret (rotated by RDS), injected as
 * DB_OWNER_USERNAME / DB_OWNER_PASSWORD with DB_HOST / DB_NAME — so the URL is built at start-up
 * instead of being stored anywhere. MIGRATE_DATABASE_URL, when set, wins.
 *   node dist/ops/db-url.js   → prints the URL (used by the shell scripts)
 */
export function ownerUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.MIGRATE_DATABASE_URL) return env.MIGRATE_DATABASE_URL;
  const { DB_OWNER_USERNAME: u, DB_OWNER_PASSWORD: p, DB_HOST: h } = env;
  if (!u || !p || !h) return null;
  const port = env.DB_PORT ?? '5432';
  // verify-full: the image trusts the RDS certificate authority (NODE_EXTRA_CA_CERTS / PGSSLROOTCERT).
  return `postgresql://${encodeURIComponent(u)}:${encodeURIComponent(p)}@${h}:${port}/${encodeURIComponent(env.DB_NAME ?? 'financiers')}?sslmode=verify-full`;
}

if (require.main === module) {
  const url = ownerUrl();
  if (!url) {
    process.stderr.write('set MIGRATE_DATABASE_URL, or DB_OWNER_USERNAME + DB_OWNER_PASSWORD + DB_HOST\n');
    process.exit(1);
  }
  process.stdout.write(url);
}
