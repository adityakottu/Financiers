import { randomUUID } from 'node:crypto';
import { Client } from 'pg';

/**
 * Load test against a running API (Phase 8). Signs in like a browser (cookies + CSRF + Origin)
 * and drives each scenario at a fixed concurrency for a fixed time, then prints p50/p95/p99,
 * throughput and errors against the targets in doc 01 §6.
 *
 *   API=http://localhost:4000 ORIGIN=http://localhost:3000 USER=manager.kkd PASSWORD=… \
 *   DATABASE_URL=… (to pick loan ids) pnpm --filter @fin/api perf:load
 */
const API = process.env.API ?? 'http://localhost:4000';
const ORIGIN = process.env.ORIGIN ?? 'http://localhost:3000';
const SECONDS = Number(process.env.SECONDS ?? 20);
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 20);

let cookie = '';
let csrf = '';

async function call(method: string, path: string, body?: unknown, extra: Record<string, string> = {}) {
  const res = await fetch(`${API}/api/v1${path}`, {
    method,
    headers: { Cookie: cookie, Origin: ORIGIN, 'X-Forwarded-For': '10.99.0.1', ...(method !== 'GET' ? { 'X-CSRF-Token': csrf, 'Content-Type': 'application/json' } : {}), ...extra },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  await res.arrayBuffer();
  return res;
}

async function signIn(user: string, password: string) {
  const res = await fetch(`${API}/api/v1/auth/login`, { method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json' }, body: JSON.stringify({ identifier: user, password }) });
  if (!res.ok) throw new Error(`sign-in failed: ${res.status} ${await res.text()}`);
  const set = res.headers.getSetCookie();
  cookie = set.map((c) => c.split(';')[0]).join('; ');
  csrf = decodeURIComponent(/(?:^|; )(?:__Host-)?fin_csrf=([^;]+)/.exec(cookie)?.[1] ?? '');
}

interface Result { name: string; n: number; errors: number; p50: number; p95: number; p99: number; rps: number; target?: number }

async function scenario(name: string, fn: (i: number) => Promise<Response>, opts: { concurrency?: number; seconds?: number; target?: number } = {}): Promise<Result> {
  const times: number[] = [];
  let errors = 0;
  let i = 0;
  const end = Date.now() + (opts.seconds ?? SECONDS) * 1000;
  const worker = async () => {
    while (Date.now() < end) {
      const t = performance.now();
      const r = await fn(i++).catch(() => null);
      times.push(performance.now() - t);
      if (!r || r.status >= 400) errors++;
    }
  };
  const started = Date.now();
  await Promise.all(Array.from({ length: opts.concurrency ?? CONCURRENCY }, worker));
  times.sort((a, b) => a - b);
  const q = (p: number) => Math.round(times[Math.min(times.length - 1, Math.floor(times.length * p))] ?? 0);
  return { name, n: times.length, errors, p50: q(0.5), p95: q(0.95), p99: q(0.99), rps: Math.round((times.length / (Date.now() - started)) * 1000), target: opts.target };
}

async function main() {
  const user = process.env.USER_NAME ?? 'manager.kkd';
  const password = process.env.PASSWORD;
  if (!password || !process.env.DATABASE_URL) throw new Error('PASSWORD and DATABASE_URL are required');
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  const kkd = (await db.query<{ id: string }>("SELECT id FROM branches WHERE code = 'KKD'")).rows[0]!.id;
  const loanIds = (await db.query<{ id: string }>("SELECT id FROM loans WHERE status = 'ACTIVE' AND branch_id = $1 ORDER BY random() LIMIT 5000", [kkd])).rows.map((r) => r.id);
  const counts = (await db.query<{ customers: string; loans: string }>('SELECT (SELECT count(*) FROM customers)::text customers, (SELECT count(*) FROM loans)::text loans')).rows[0]!;
  await db.end();
  await signIn(user, password);
  const names = ['Venkata Rao', 'Lakshmi', 'Srinivas Reddy', 'Padma Devi', 'Durga', 'Naidu 4', 'Prasad 77'];

  const results: Result[] = [];
  results.push(await scenario('Global search (names)', (i) => call('GET', `/search?q=${encodeURIComponent(names[i % names.length]!)}&limit=10`), { target: 300 }));
  results.push(await scenario('Global search (mobile)', (i) => call('GET', `/search?q=${6 + (i % 4)}${String((i * 7919) % 1e9).padStart(9, '0')}&limit=10`), { target: 300 }));
  results.push(await scenario('Loan list (active, page)', () => call('GET', '/loans?status=ACTIVE&limit=50')));
  results.push(await scenario('Loan detail', (i) => call('GET', `/loans/${loanIds[i % loanIds.length]}`)));
  // Payments in one branch queue on the gapless receipt / journal numbering (and the audit chain) until
  // commit — by design: no gaps in receipt numbers. 5 at once is already well above a branch's real
  // peak; the 20-at-once row is a stress figure for throughput, not the target.
  results.push(await scenario('Payment, one branch, 20 at once', (i) => call('POST', `/loans/${loanIds[i % loanIds.length]}/payments`, { amount: '100', method: 'CASH', atCounter: true, confirmDuplicate: true, notify: false }, { 'Idempotency-Key': randomUUID() })));
  results.push(await scenario('Payment, one branch, 5 at once', (i) => call('POST', `/loans/${loanIds[(i + 2500) % loanIds.length]}/payments`, { amount: '100', method: 'CASH', atCounter: true, confirmDuplicate: true, notify: false }, { 'Idempotency-Key': randomUUID() }), { concurrency: 5, target: 500 }));
  results.push(await scenario('Branch dashboard', () => call('GET', `/dashboard/branch/${kkd}`), { concurrency: 5 }));
  results.push(await scenario('Report: outstanding by loan (JSON)', () => call('GET', '/reports/outstanding-by-loan'), { concurrency: 3 }));
  results.push(await scenario('Report: active loans (Excel)', () => call('GET', '/reports/loans-active?format=xlsx'), { concurrency: 2, seconds: 10 }));

  process.stdout.write(`\nVolume: ${Number(counts.customers).toLocaleString('en-IN')} customers, ${Number(counts.loans).toLocaleString('en-IN')} loans · concurrency ${CONCURRENCY} · ${SECONDS}s per scenario\n\n`);
  process.stdout.write(`${'Scenario'.padEnd(36)}${'requests'.padStart(9)}${'errors'.padStart(8)}${'p50'.padStart(7)}${'p95'.padStart(7)}${'p99'.padStart(7)}${'req/s'.padStart(7)}  target\n`);
  for (const r of results) {
    const verdict = r.target ? (r.p95 <= r.target && r.errors === 0 ? `p95 < ${r.target} ms ✓` : `p95 < ${r.target} ms ✗`) : r.errors ? 'errors ✗' : '';
    process.stdout.write(`${r.name.padEnd(36)}${String(r.n).padStart(9)}${String(r.errors).padStart(8)}${String(r.p50).padStart(7)}${String(r.p95).padStart(7)}${String(r.p99).padStart(7)}${String(r.rps).padStart(7)}  ${verdict}\n`);
  }
  process.exitCode = results.some((r) => r.errors > 0 || (r.target !== undefined && r.p95 > r.target)) ? 1 : 0;
}

main().catch((e) => {
  process.stderr.write(`${(e as Error).stack}\n`);
  process.exit(2);
});
