import type { StatementMapping } from '@fin/contracts';
import { Money } from '@fin/money';
import ExcelJS from 'exceljs';
import { createHash } from 'node:crypto';

export interface ParsedLine {
  row: number;
  txnDate: string;
  description: string;
  reference: string | null;
  utr: string | null;
  debit: string;
  credit: string;
  balance: string | null;
  hash: string;
}
export interface InvalidLine {
  row: number;
  error: string;
  raw: string[];
}

/** RFC 4180 CSV: quoted fields, doubled quotes, CRLF or LF. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (q) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') q = false;
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

export async function xlsxRows(buf: Buffer): Promise<string[][]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  const ws = wb.worksheets[0];
  if (!ws) return [];
  const rows: string[][] = [];
  ws.eachRow({ includeEmpty: false }, (r) => {
    const vals = (r.values as unknown[]).slice(1).map((v) => {
      if (v instanceof Date) return v.toISOString().slice(0, 10);
      if (v && typeof v === 'object' && 'text' in v) return String((v as { text: unknown }).text);
      if (v && typeof v === 'object' && 'result' in v) return String((v as { result: unknown }).result);
      return v === null || v === undefined ? '' : String(v);
    });
    rows.push(vals);
  });
  return rows;
}

const MONTHS: Record<string, string> = { JAN: '01', FEB: '02', MAR: '03', APR: '04', MAY: '05', JUN: '06', JUL: '07', AUG: '08', SEP: '09', OCT: '10', NOV: '11', DEC: '12' };

export function parseDate(v: string, fmt: StatementMapping['dateFormat']): string | null {
  const s = v.trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return validDate(s.slice(0, 10)); // already ISO (e.g. from Excel)
  let y: string | undefined, m: string | undefined, d: string | undefined;
  if (fmt === 'DD/MM/YYYY' || fmt === 'DD-MM-YYYY') [, d, m, y] = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/) ?? [];
  else if (fmt === 'YYYY-MM-DD') [, y, m, d] = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/) ?? [];
  else {
    const r = s.match(/^(\d{1,2})[\s-]([A-Za-z]{3})[\s-](\d{2,4})$/);
    if (r) {
      d = r[1];
      m = MONTHS[r[2]!.toUpperCase()];
      y = r[3];
    }
  }
  if (!y || !m || !d) return null;
  if (y.length === 2) y = `20${y}`;
  return validDate(`${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`);
}

function validDate(iso: string): string | null {
  const t = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === iso ? iso : null;
}

/** "1,23,456.78", "1234.5 Cr", "" → decimal string; null when not a number. */
export function parseAmount(v: string | undefined): string | null {
  const s = (v ?? '').replace(/[,\s₹]|INR|Rs\.?|Cr|Dr/gi, '');
  if (s === '' || s === '-') return '0.00';
  if (!/^-?\d+(\.\d{1,2})?$/.test(s)) return null;
  return Money.of(s.replace(/^-/, '')).toString();
}

/** UTR / UPI reference from a narration: 12-digit UPI RRN, or an IFSC-style NEFT/RTGS/IMPS reference. */
export function extractUtr(text: string): string | null {
  const t = text.toUpperCase();
  const neft = t.match(/\b([A-Z]{4}[0-9A-Z]{12,18})\b/);
  if (neft && /\d{6,}/.test(neft[1]!)) return neft[1]!;
  const upi = t.match(/(?:^|\D)(\d{12})(?!\d)/);
  return upi ? upi[1]! : null;
}

/**
 * Parse a bank statement (CSV or XLSX) with a column mapping. Every row is either a valid line or
 * an invalid one with the reason — nothing is dropped silently. The hash (account, date, amounts,
 * text, balance, occurrence) makes re-importing the same rows a no-op.
 */
export async function parseStatement(buf: Buffer, fileName: string, mapping: StatementMapping, accountId: string) {
  const isXlsx = buf.subarray(0, 2).toString() === 'PK' || /\.xlsx$/i.test(fileName);
  const all = isXlsx ? await xlsxRows(buf) : parseCsv(buf.toString('utf8').replace(/^﻿/, ''));
  const body = all.slice(mapping.skipRows + 1); // + header row
  const lines: ParsedLine[] = [];
  const invalid: InvalidLine[] = [];
  const seen = new Map<string, number>();
  body.forEach((cols, i) => {
    const row = mapping.skipRows + i + 2; // 1-based, after header
    const cell = (k?: number) => (k === undefined ? '' : (cols[k] ?? '').trim());
    const date = parseDate(cell(mapping.date), mapping.dateFormat);
    const debit = parseAmount(cell(mapping.debit));
    const credit = parseAmount(cell(mapping.credit));
    const balance = mapping.balance === undefined ? null : cell(mapping.balance) === '' ? null : parseAmount(cell(mapping.balance));
    const description = cell(mapping.description);
    const err = !date
      ? `Date “${cell(mapping.date)}” is not ${mapping.dateFormat}`
      : debit === null || credit === null
        ? 'Debit / credit is not a number'
        : Money.of(debit).isPositive() === Money.of(credit).isPositive()
          ? Money.of(debit).isZero()
            ? 'Neither debit nor credit has an amount'
            : 'Both debit and credit have an amount'
          : mapping.balance !== undefined && cell(mapping.balance) !== '' && balance === null
            ? 'Balance is not a number'
            : !description
              ? 'Description is empty'
              : null;
    if (err) {
      invalid.push({ row, error: err, raw: cols });
      return;
    }
    const reference = cell(mapping.reference) || null;
    const base = [accountId, date, debit, credit, description.replace(/\s+/g, ' ').toUpperCase(), reference ?? '', balance ?? ''].join('|');
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    lines.push({
      row,
      txnDate: date!,
      description,
      reference,
      utr: extractUtr(`${reference ?? ''} ${description}`),
      debit: debit!,
      credit: credit!,
      balance,
      hash: createHash('sha256').update(`${base}|${n}`).digest('hex'),
    });
  });
  return { lines, invalid, header: all[mapping.skipRows] ?? [] };
}
