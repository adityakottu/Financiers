import type { Permission } from '@fin/contracts';
import { z } from 'zod';
import type { AuthContext } from '../auth/context';
import type { Db } from '../db/db';
import type { BooksService } from '../accounting/books.service';

export type ColumnType = 'text' | 'money' | 'int' | 'date' | 'pct';

export interface Column {
  key: string;
  label: string;
  type: ColumnType;
  /** Excel width in characters; PDF widths are proportional to it. */
  width?: number;
  /** Add this column up in the totals row. */
  total?: boolean;
}

export type Cell = string | number | null;
/** A data row; `_section` makes a heading row and `_bold` a bold one. */
export type Row = Record<string, Cell | boolean | undefined>;

export interface ReportResult {
  columns: Column[];
  rows: Row[];
  /** Overrides the computed totals row (e.g. ratios, or "balanced" checks). */
  totals?: Row | null;
  /** Lines printed under the title (assumptions, ⚖ notes). */
  notes?: string[];
}

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
  .refine((v) => {
    const d = new Date(`${v}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
  }, 'Not a real date');
const blank = <T extends z.ZodTypeAny>(s: T) => z.preprocess((v) => (v === '' || v === null ? undefined : v), s.optional());

/** Every filter a report can take; each report lists the ones it uses (doc 10: global filters). */
export const filtersSchema = z.object({
  from: blank(isoDate),
  to: blank(isoDate),
  asOf: blank(isoDate),
  branchId: blank(z.string().uuid()),
  employeeId: blank(z.string().uuid()),
  accountId: blank(z.string().uuid()),
  category: blank(z.string().max(40)),
  method: blank(z.enum(['CASH', 'UPI', 'BANK_TRANSFER', 'CHEQUE'])),
  status: blank(z.string().max(40)),
  bucket: blank(z.enum(['DPD_1_30', 'DPD_31_60', 'DPD_61_90', 'DPD_90_PLUS'])),
  range: blank(z.enum(['today', 'tomorrow', 'week'])),
});
export type Filters = z.infer<typeof filtersSchema>;
export type FilterKey = keyof Filters;

export interface RunContext {
  db: Db;
  books: BooksService;
  auth: AuthContext;
  today: string;
  /** Branch ids to restrict to, or null for all; [NONE] when nothing is visible. */
  branches: string[] | null;
  /** For collectors (ASSIGNED scope): their own employee id; reports show only their work. */
  ownEmployeeId: string | null;
}

export interface ReportDef {
  name: string;
  title: string;
  group: 'Loans' | 'Collections' | 'Accounting' | 'Reconciliation' | 'Recovery';
  description: string;
  permission: Permission;
  filters: FilterKey[];
  /** Filters filled in when the user has not chosen them. */
  defaults?: (today: string) => Partial<Filters>;
  /** Filters that must be present after defaults. */
  required?: FilterKey[];
  run(c: RunContext, f: Filters): Promise<ReportResult>;
}

export const NONE = '00000000-0000-0000-0000-000000000000';
