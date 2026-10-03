import { Client } from 'pg';
import { migrate } from '../db/migrate';
import { createDb } from '../db/db';
import { syncReferenceData } from '../db/seed';

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgresql://fin:fin@localhost:5432/financiers_test';

/** Fresh database for every test run: drop, create, migrate, load reference data. */
export default async function setup() {
  const url = new URL(TEST_DATABASE_URL);
  const dbName = url.pathname.slice(1);
  if (!/_test$/.test(dbName)) throw new Error(`Refusing to reset non-test database "${dbName}"`);
  const admin = new Client({ connectionString: Object.assign(new URL(url), { pathname: '/postgres' }).toString() });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
  await admin.query(`CREATE DATABASE "${dbName}"`);
  await admin.end();

  await migrate(TEST_DATABASE_URL, () => undefined);
  const db = createDb(TEST_DATABASE_URL, 2);
  const company = await db.insertInto('companies').values({ legal_name: 'Test Finance Pvt Ltd' }).returning('id').executeTakeFirstOrThrow();
  await db.insertInto('branches').values([
    { company_id: company.id, code: 'HQ', name: 'Head Office' },
    { company_id: company.id, code: 'KKD', name: 'Kakinada' },
    { company_id: company.id, code: 'RJY', name: 'Rajahmundry' },
  ]).execute();
  await syncReferenceData(db); // also creates each branch's cash accounts
  await db.destroy();
}
