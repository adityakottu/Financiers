import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import type { Executor, Tx } from '../db/db';

export type SeqType = 'CUSTOMER' | 'LOAN' | 'RECEIPT' | 'PAYMENT' | 'JOURNAL' | 'EXPENSE';

/** Indian financial year (April–March) identified by its starting calendar year. */
export function fiscalYear(date: Date, fyStartMonth = 4, timeZone = 'Asia/Kolkata'): number {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: 'numeric' }).formatToParts(date);
  const year = Number(parts.find((p) => p.type === 'year')!.value);
  const month = Number(parts.find((p) => p.type === 'month')!.value);
  return month >= fyStartMonth ? year : year - 1;
}

/**
 * Tokens: {FY} = FY start year (2026 for FY 2026-27), {FYS} = "2026-27", {YYYY} = calendar year,
 * {BR} = branch code, {SEQ:n} = counter zero-padded to n digits.
 */
export function renderNumber(format: string, v: { fy: number; year: number; branchCode?: string; seq: number }): string {
  return format
    .replace(/\{FYS\}/g, `${v.fy}-${String((v.fy + 1) % 100).padStart(2, '0')}`)
    .replace(/\{FY\}/g, String(v.fy))
    .replace(/\{YYYY\}/g, String(v.year))
    .replace(/\{BR\}/g, v.branchCode ?? '')
    .replace(/\{SEQ(?::(\d))?\}/g, (_m, pad: string | undefined) => String(v.seq).padStart(Number(pad ?? 1), '0'));
}

@Injectable()
export class NumberingService {
  /**
   * Allocate the next number inside the caller's transaction. The upsert row-locks the counter
   * until commit, so numbers are unique and gapless: a rolled-back transaction releases its number.
   */
  async next(tx: Tx, type: SeqType, opts: { branchCode?: string; at?: Date } = {}): Promise<string> {
    const at = opts.at ?? new Date();
    const fmt = await tx
      .selectFrom('numbering_formats')
      .select('format')
      .where('seq_type', '=', type)
      .executeTakeFirstOrThrow();
    const perBranch = fmt.format.includes('{BR}');
    if (perBranch && !opts.branchCode) throw new Error(`Numbering ${type} needs a branch code`);
    const fy = fiscalYear(at);
    const scopeKey = perBranch ? opts.branchCode! : '';
    const row = await sql<{ seq: string }>`
      INSERT INTO numbering_sequences (seq_type, scope_key, fiscal_year, next_value)
      VALUES (${type}, ${scopeKey}, ${fy}, 2)
      ON CONFLICT (seq_type, scope_key, fiscal_year)
      DO UPDATE SET next_value = numbering_sequences.next_value + 1
      RETURNING next_value - 1 AS seq`.execute(tx);
    const seq = Number(row.rows[0]!.seq);
    return renderNumber(fmt.format, { fy, year: at.getUTCFullYear(), branchCode: opts.branchCode, seq });
  }

  async preview(db: Executor, type: SeqType, format: string, branchCode = 'HQ') {
    const fy = fiscalYear(new Date());
    const current = await db
      .selectFrom('numbering_sequences')
      .select('next_value')
      .where('seq_type', '=', type)
      .where('scope_key', '=', format.includes('{BR}') ? branchCode : '')
      .where('fiscal_year', '=', fy)
      .executeTakeFirst();
    return renderNumber(format, { fy, year: new Date().getUTCFullYear(), branchCode, seq: Number(current?.next_value ?? 1) });
  }
}
