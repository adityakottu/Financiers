import { CATEGORY_LABELS, LoanCategory } from '@fin/contracts';
import { formatINR, Money } from '@fin/money';
import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import { sql } from 'kysely';
import type { Executor } from '../db/db';

export interface StatementLine {
  date: string;
  entryNo: string;
  type: string;
  description: string;
  debit: string;
  credit: string;
  balance: string;
}

export interface Statement {
  company: { name: string; address: string | null };
  loan: {
    loanNo: string;
    status: string;
    customerName: string;
    customerNo: string;
    branch: string;
    product: string;
    category: string;
    principal: string;
    annualRate: string;
    method: string;
    frequency: string;
    installments: number;
    installmentAmount: string;
    apr: string;
    disbursedOn: string | null;
    maturityDate: string;
    feesDeducted: string;
  };
  lines: StatementLine[];
  summary: {
    principalDisbursed: string;
    interestCharged: string;
    feesCharged: string;
    penaltiesCharged: string;
    paymentsReceived: string;
    outstanding: string;
    principalOutstanding: string;
    overdue: string;
    dpd: number;
  };
  schedule: { no: number; dueDate: string; principal: string; interest: string; fees: string; penalty: string; total: string; paid: string; balance: string; status: string }[];
  generatedAt: string;
}

const RECEIVABLES = ['1310', '1320', '1330', '1340'];
const TYPE_LABEL: Record<string, string> = {
  DISBURSEMENT: 'Disbursement',
  ACCRUAL: 'Interest due',
  PENALTY: 'Penal charge',
  PAYMENT: 'Payment',
  REVERSAL: 'Reversal',
  ADJUSTMENT: 'Adjustment',
  OPENING: 'Opening balance',
};

/**
 * Customer statement straight from the ledger: every line is a journal line on the loan's
 * receivable accounts (principal, interest, fees, penal charges). Debit = charged to the
 * customer, credit = paid / reduced. It therefore can never disagree with the books.
 */
export async function buildStatement(db: Executor, loanId: string): Promise<Statement> {
  const l = await db
    .selectFrom('loans as l')
    .innerJoin('customers as c', 'c.id', 'l.customer_id')
    .innerJoin('branches as b', 'b.id', 'l.branch_id')
    .innerJoin('loan_products as p', 'p.id', 'l.product_id')
    .selectAll('l')
    .select(['c.full_name', 'c.customer_no', 'b.name as branch_name', 'p.name as product_name'])
    .where('l.id', '=', loanId)
    .executeTakeFirstOrThrow();
  const company = await db.selectFrom('companies').select(['legal_name', 'trade_name', 'address']).executeTakeFirstOrThrow();

  const rows = await sql<{ value_date: string; entry_no: string; entry_type: string; narration: string; memo: string | null; code: string; debit: string; credit: string }>`
    SELECT e.value_date::text, e.entry_no, e.entry_type, e.narration, jl.memo, a.code, jl.debit::text, jl.credit::text
    FROM journal_lines jl
    JOIN journal_entries e ON e.id = jl.entry_id
    JOIN accounts a ON a.id = jl.account_id
    WHERE jl.loan_id = ${loanId} AND a.code = ANY(${RECEIVABLES}::text[])
    ORDER BY e.value_date, e.posted_at, jl.line_no`.execute(db);

  let bal = Money.zero();
  const sums = { principal: Money.zero(), interest: Money.zero(), fees: Money.zero(), penalty: Money.zero(), paid: Money.zero() };
  const lines: StatementLine[] = rows.rows.map((r) => {
    const dr = Money.of(r.debit);
    const cr = Money.of(r.credit);
    bal = bal.plus(dr).minus(cr);
    if (dr.isPositive()) {
      if (r.code === '1310') sums.principal = sums.principal.plus(dr);
      if (r.code === '1320') sums.interest = sums.interest.plus(dr);
      if (r.code === '1330') sums.fees = sums.fees.plus(dr);
      if (r.code === '1340') sums.penalty = sums.penalty.plus(dr);
    }
    if (cr.isPositive()) sums.paid = sums.paid.plus(cr);
    const what = r.code === '1310' ? 'principal' : r.code === '1320' ? 'interest' : r.code === '1330' ? 'fees' : 'penal charge';
    return {
      date: r.value_date,
      entryNo: r.entry_no,
      type: TYPE_LABEL[r.entry_type] ?? r.entry_type,
      description: `${r.memo ?? r.narration} (${what})`,
      debit: dr.toString(),
      credit: cr.toString(),
      balance: bal.toString(),
    };
  });

  const inst = await db
    .selectFrom('loan_installments')
    .selectAll()
    .where('loan_id', '=', loanId)
    .where('status', '<>', 'RESCHEDULED')
    .orderBy('installment_no')
    .execute();

  return {
    company: { name: company.trade_name || company.legal_name, address: company.address },
    loan: {
      loanNo: l.loan_no,
      status: l.status,
      customerName: l.full_name,
      customerNo: l.customer_no,
      branch: l.branch_name,
      product: l.product_name,
      category: CATEGORY_LABELS[l.category as LoanCategory] ?? l.category,
      principal: l.principal,
      annualRate: l.annual_rate,
      method: l.interest_method,
      frequency: l.frequency,
      installments: l.num_installments,
      installmentAmount: l.installment_amount,
      apr: l.apr,
      disbursedOn: l.disbursed_on,
      maturityDate: l.maturity_date,
      feesDeducted: l.fees_deducted,
    },
    lines,
    summary: {
      principalDisbursed: sums.principal.toString(),
      interestCharged: sums.interest.toString(),
      feesCharged: sums.fees.toString(),
      penaltiesCharged: sums.penalty.toString(),
      paymentsReceived: sums.paid.toString(),
      outstanding: bal.toString(),
      principalOutstanding: l.principal_outstanding,
      overdue: l.overdue_amount,
      dpd: l.dpd,
    },
    schedule: inst.map((i) => ({
      no: i.installment_no,
      dueDate: i.due_date,
      principal: i.principal_due,
      interest: i.interest_due,
      fees: i.fees_due,
      penalty: i.penalty_due,
      total: i.total_due ?? '0',
      paid: i.total_paid ?? '0',
      balance: Money.of(i.total_due ?? '0').minus(Money.of(i.total_paid ?? '0')).toString(),
      status: i.status,
    })),
    generatedAt: new Date().toISOString(),
  };
}

const d = (s: string | null) => (s ? `${s.slice(8, 10)}/${s.slice(5, 7)}/${s.slice(0, 4)}` : '—');
const ist = (iso: string) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));

export async function statementXlsx(s: Statement): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = s.company.name;
  wb.created = new Date(s.generatedAt);
  const money = '#,##,##0.00';

  const header = (ws: ExcelJS.Worksheet, title: string, cols: number) => {
    ws.mergeCells(1, 1, 1, cols);
    ws.getCell(1, 1).value = s.company.name;
    ws.getCell(1, 1).font = { bold: true, size: 14 };
    ws.mergeCells(2, 1, 2, cols);
    ws.getCell(2, 1).value = `${title} — Loan ${s.loan.loanNo} — ${s.loan.customerName} (${s.loan.customerNo})`;
    ws.getCell(2, 1).font = { bold: true };
    ws.mergeCells(3, 1, 3, cols);
    ws.getCell(3, 1).value = `Generated ${ist(s.generatedAt)} IST`;
    ws.getCell(3, 1).font = { italic: true, color: { argb: 'FF666666' } };
  };

  const st = wb.addWorksheet('Statement', { views: [{ state: 'frozen', ySplit: 5 }] });
  header(st, 'Loan statement', 6);
  st.getRow(5).values = ['Date', 'Entry', 'Description', 'Charged (Dr)', 'Paid / reduced (Cr)', 'Balance'];
  st.getRow(5).font = { bold: true };
  for (const l of s.lines) {
    st.addRow([d(l.date), l.entryNo, l.description, Number(l.debit) || null, Number(l.credit) || null, Number(l.balance)]);
  }
  st.addRow([]);
  const sumRows: [string, string][] = [
    ['Principal disbursed', s.summary.principalDisbursed],
    ['Interest charged', s.summary.interestCharged],
    ['Fees charged', s.summary.feesCharged],
    ['Penal charges', s.summary.penaltiesCharged],
    ['Payments received', s.summary.paymentsReceived],
    ['Outstanding', s.summary.outstanding],
  ];
  for (const [k, v] of sumRows) {
    const r = st.addRow(['', '', k, null, null, Number(v)]);
    r.font = { bold: k === 'Outstanding' };
  }
  st.columns = [{ width: 12 }, { width: 18 }, { width: 52 }, { width: 16 }, { width: 18 }, { width: 16 }];
  for (const c of [4, 5, 6]) st.getColumn(c).numFmt = money;

  const sc = wb.addWorksheet('Schedule', { views: [{ state: 'frozen', ySplit: 5 }] });
  header(sc, 'Repayment schedule', 10);
  sc.getRow(5).values = ['No.', 'Due date', 'Principal', 'Interest', 'Fees', 'Penal', 'Total due', 'Paid', 'Balance', 'Status'];
  sc.getRow(5).font = { bold: true };
  for (const r of s.schedule) {
    sc.addRow([r.no, d(r.dueDate), Number(r.principal), Number(r.interest), Number(r.fees), Number(r.penalty), Number(r.total), Number(r.paid), Number(r.balance), r.status.replace(/_/g, ' ')]);
  }
  sc.columns = [{ width: 6 }, { width: 12 }, ...Array(7).fill({ width: 14 }), { width: 16 }];
  for (let c = 3; c <= 9; c++) sc.getColumn(c).numFmt = money;

  return Buffer.from(await wb.xlsx.writeBuffer());
}

export function statementPdf(s: Statement): Promise<Buffer> {
  // Standard PDF fonts have no ₹ glyph, so amounts print as "Rs. 1,24,000.00".
  const rs = (v: string) => `Rs. ${formatINR(v, { symbol: false })}`;
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 40, info: { Title: `Statement ${s.loan.loanNo}`, Author: s.company.name } });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    const W = doc.page.width - 80;

    doc.font('Helvetica-Bold').fontSize(15).text(s.company.name);
    if (s.company.address) doc.font('Helvetica').fontSize(9).fillColor('#555').text(s.company.address);
    doc.moveDown(0.6).fillColor('#000').font('Helvetica-Bold').fontSize(12).text('Loan Statement');
    doc.font('Helvetica').fontSize(8).fillColor('#555').text(`Generated ${ist(s.generatedAt)} IST`).fillColor('#000');
    doc.moveDown(0.6);

    const facts: [string, string][] = [
      ['Loan number', s.loan.loanNo],
      ['Customer', `${s.loan.customerName} (${s.loan.customerNo})`],
      ['Product', `${s.loan.product} — ${s.loan.category}`],
      ['Branch', s.loan.branch],
      ['Loan amount', rs(s.loan.principal)],
      ['Interest', `${Number(s.loan.annualRate)}% p.a. ${s.loan.method === 'FLAT' ? 'flat' : s.loan.method === 'REDUCING_EMI' ? 'reducing balance' : 'simple'}`],
      ['APR (annualised cost)', `${Number(s.loan.apr).toFixed(2)}%`],
      ['Installments', `${s.loan.installments} × ${rs(s.loan.installmentAmount)} (${s.loan.frequency.toLowerCase()})`],
      ['Disbursed on', d(s.loan.disbursedOn)],
      ['Maturity', d(s.loan.maturityDate)],
      ['Status', s.loan.status.replace(/_/g, ' ')],
    ];
    doc.fontSize(9);
    const y0 = doc.y;
    facts.forEach(([k, v], i) => {
      const col = i % 2;
      const y = y0 + Math.floor(i / 2) * 14;
      doc.font('Helvetica').fillColor('#666').text(k, 40 + col * (W / 2), y, { width: 110 });
      doc.font('Helvetica-Bold').fillColor('#000').text(v, 150 + col * (W / 2), y, { width: W / 2 - 115 });
    });
    doc.y = y0 + Math.ceil(facts.length / 2) * 14 + 10;

    const table = (headers: string[], widths: number[], rows: string[][], align: ('left' | 'right')[]) => {
      const draw = (cells: string[], bold: boolean) => {
        if (doc.y > doc.page.height - 70) doc.addPage();
        const y = doc.y;
        let x = 40;
        doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8);
        const h = Math.max(...cells.map((c, i) => doc.heightOfString(c, { width: widths[i]! - 4 })));
        cells.forEach((c, i) => {
          doc.text(c, x + 2, y, { width: widths[i]! - 4, align: align[i] });
          x += widths[i]!;
        });
        doc.y = y + h + 4;
        doc.moveTo(40, doc.y - 2).lineTo(40 + W, doc.y - 2).strokeColor(bold ? '#999' : '#e5e5e5').lineWidth(0.5).stroke();
      };
      draw(headers, true);
      rows.forEach((r) => draw(r, false));
    };

    doc.font('Helvetica-Bold').fontSize(10).text('Transactions', 40);
    doc.moveDown(0.3);
    table(
      ['Date', 'Description', 'Charged', 'Paid', 'Balance'],
      [58, W - 58 - 3 * 78, 78, 78, 78],
      s.lines.map((l) => [d(l.date), l.description, Money.of(l.debit).isPositive() ? rs(l.debit) : '', Money.of(l.credit).isPositive() ? rs(l.credit) : '', rs(l.balance)]),
      ['left', 'left', 'right', 'right', 'right'],
    );
    doc.moveDown(0.5);
    const summary: [string, string][] = [
      ['Principal disbursed', s.summary.principalDisbursed],
      ['Interest charged to date', s.summary.interestCharged],
      ['Fees charged', s.summary.feesCharged],
      ['Penal charges', s.summary.penaltiesCharged],
      ['Payments received', s.summary.paymentsReceived],
      ['Outstanding', s.summary.outstanding],
    ];
    if (Money.of(s.loan.feesDeducted).isPositive()) summary.splice(3, 0, ['Fees deducted at disbursement', s.loan.feesDeducted]);
    for (const [k, v] of summary) {
      doc.font(k === 'Outstanding' ? 'Helvetica-Bold' : 'Helvetica').fontSize(9).text(k, 40 + W - 260, doc.y, { width: 160, continued: false });
      doc.moveUp().text(rs(v), 40 + W - 100, doc.y, { width: 100, align: 'right' });
    }

    doc.addPage();
    doc.font('Helvetica-Bold').fontSize(10).text('Repayment schedule', 40);
    doc.moveDown(0.3);
    table(
      ['No.', 'Due date', 'Principal', 'Interest', 'Fees + penal', 'Total due', 'Paid', 'Status'],
      [28, 58, 68, 64, 66, 70, 64, W - 418],
      s.schedule.map((r) => [
        String(r.no),
        d(r.dueDate),
        rs(r.principal),
        rs(r.interest),
        rs(Money.of(r.fees).plus(Money.of(r.penalty)).toString()),
        rs(r.total),
        rs(r.paid),
        r.status.replace(/_/g, ' ').toLowerCase(),
      ]),
      ['right', 'left', 'right', 'right', 'right', 'right', 'right', 'left'],
    );
    doc.moveDown(1).font('Helvetica').fontSize(7).fillColor('#777').text('This statement is generated from the company’s accounting records. Please report any discrepancy to your branch.', 40);
    doc.end();
  });
}
