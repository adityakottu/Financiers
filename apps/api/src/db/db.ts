import { Kysely, PostgresDialect, Transaction } from 'kysely';
import { Pool, types } from 'pg';
import type { DB } from './schema';

// DATE columns stay 'YYYY-MM-DD' strings (no timezone shifting); NUMERIC and INT8 stay strings (no floats).
types.setTypeParser(types.builtins.DATE, (v) => v);
types.setTypeParser(types.builtins.NUMERIC, (v) => v);
types.setTypeParser(types.builtins.INT8, (v) => v);

export type Db = Kysely<DB>;
export type Tx = Transaction<DB>;
/** Anything a query can run on: the pool or an open transaction. */
export type Executor = Db | Tx;

export const DB_TOKEN = Symbol('DB');

export function createDb(connectionString: string, max = 10): Db {
  const pool = new Pool({ connectionString, max, application_name: 'financiers-api' });
  return new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
}

/** Postgres error helpers. */
export function pgErrorCode(e: unknown): string | undefined {
  return typeof e === 'object' && e !== null && 'code' in e ? String((e as { code: unknown }).code) : undefined;
}
export function pgConstraint(e: unknown): string | undefined {
  return typeof e === 'object' && e !== null && 'constraint' in e
    ? String((e as { constraint: unknown }).constraint)
    : undefined;
}
export const isUniqueViolation = (e: unknown) => pgErrorCode(e) === '23505';
