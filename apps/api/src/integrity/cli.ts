import { createDb } from '../db/db';
import { runIntegrityChecks } from './checks';

/**
 * `pnpm --filter @fin/api db:verify` — integrity checks against DATABASE_URL (live or restored).
 * Prints each check; exits 1 if any fails (used by the restore drill and after incidents).
 */
async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  const db = createDb(url, 2);
  try {
    const checks = await runIntegrityChecks(db);
    for (const c of checks) {
      process.stdout.write(`${c.ok ? 'PASS' : 'FAIL'}  ${c.label} — ${c.detail}\n`);
      for (const s of c.samples ?? []) process.stdout.write(`        ${s}\n`);
    }
    const ok = checks.every((c) => c.ok);
    process.stdout.write(ok ? '\nAll integrity checks passed.\n' : '\nINTEGRITY CHECKS FAILED.\n');
    process.exitCode = ok ? 0 : 1;
  } finally {
    await db.destroy();
  }
}

void main().catch((e) => {
  process.stderr.write(`${(e as Error).stack}\n`);
  process.exit(2);
});
