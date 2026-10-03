import { formatINR, Money } from '@fin/money';
import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import type { Column, ReportResult, Row } from './types';

export interface RenderMeta {
  company: string;
  title: string;
  /** Human-readable filters, e.g. "Branch: KKD · 01/09/2026 to 30/09/2026". */
  filters: string;
  generatedAt: Date;
  generatedBy: string;
}

const ist = (d: Date) => new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' }).format(d);
const dmy = (v: string) => (/^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10).split('-').reverse().join('/') : v);

/** Totals row: money / int columns marked `total`, exact decimal sums. */
export function totalsRow(r: ReportResult): Row | null {
  if (r.totals !== undefined) return r.totals;
  const cols = r.columns.filter((c) => c.total);
  if (!cols.length) return null;
  const data = r.rows.filter((x) => !x._section);
  const t: Row = { [r.columns[0]!.key]: 'Total' };
  for (const c of cols) {
    t[c.key] = c.type === 'int' ? data.reduce((s, x) => s + Number(x[c.key] ?? 0), 0) : Money.sum(data.map((x) => Money.of(String(x[c.key] ?? '0') || '0'))).toString();
  }
  return t;
}

const INDIAN = '[>=10000000]##\\,##\\,##\\,##0.00;[>=100000]##\\,##\\,##0.00;##,##0.00';

/** Excel: company header, report name, filters, generated time, frozen header, Indian number format. */
export async function toXlsx(meta: RenderMeta, r: ReportResult, wb = new ExcelJS.Workbook(), sheetName?: string): Promise<ExcelJS.Workbook> {
  wb.creator = meta.company;
  const ws = wb.addWorksheet((sheetName ?? meta.title).replace(/[\\/?*[\]:]/g, ' ').slice(0, 31), { pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 } });
  ws.addRow([meta.company]).font = { bold: true, size: 13 };
  ws.addRow([meta.title]).font = { bold: true, size: 12 };
  ws.addRow([meta.filters || 'No filters']);
  ws.addRow([`Generated ${ist(meta.generatedAt)} IST by ${meta.generatedBy}`]).font = { color: { argb: 'FF666666' }, size: 9 };
  let headerRow = 6;
  for (const n of r.notes ?? []) {
    ws.addRow([n]).font = { italic: true, size: 9, color: { argb: 'FF666666' } };
    headerRow++;
  }
  ws.addRow([]);
  const header = ws.addRow(r.columns.map((c) => c.label));
  header.font = { bold: true };
  header.eachCell((c) => {
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFF2F5' } };
    c.border = { bottom: { style: 'thin', color: { argb: 'FFB0B8C0' } } };
  });
  ws.views = [{ state: 'frozen', ySplit: headerRow }];
  r.columns.forEach((c, i) => {
    const col = ws.getColumn(i + 1);
    col.width = c.width ?? (c.type === 'money' ? 16 : c.type === 'date' ? 12 : c.type === 'int' || c.type === 'pct' ? 10 : 24);
    if (c.type === 'money' || c.type === 'int' || c.type === 'pct') col.alignment = { horizontal: 'right' };
  });
  const add = (row: Row, bold = false) => {
    if (row._section) {
      const x = ws.addRow([row._section]);
      x.font = { bold: true };
      return;
    }
    const x = ws.addRow(
      r.columns.map((c) => {
        const v = row[c.key];
        if (v === null || v === undefined || v === '') return null;
        if (c.type === 'money' || c.type === 'pct') return Number(v);
        if (c.type === 'int') return Number(v);
        if (c.type === 'date' && typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) {
          const [y, m, d] = v.split('-').map(Number);
          return new Date(Date.UTC(y!, m! - 1, d!));
        }
        return v;
      }),
    );
    r.columns.forEach((c, i) => {
      const cell = x.getCell(i + 1);
      if (c.type === 'money') cell.numFmt = INDIAN;
      else if (c.type === 'pct') cell.numFmt = '0.00"%"';
      else if (c.type === 'date') cell.numFmt = 'dd/mm/yyyy';
    });
    if (bold || row._bold) x.font = { bold: true };
  };
  r.rows.forEach((x) => add(x));
  const t = totalsRow(r);
  if (t) {
    const line = ws.lastRow!.number + 1;
    add(t, true);
    ws.getRow(line).eachCell((c) => (c.border = { top: { style: 'thin' } }));
  }
  return wb;
}

export async function xlsxBuffer(meta: RenderMeta, r: ReportResult) {
  return Buffer.from(await (await toXlsx(meta, r)).xlsx.writeBuffer());
}

/** PDF: print-ready A4 landscape, repeated column headers, totals, "Page x of y". */
export function toPdf(meta: RenderMeta, r: ReportResult): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 32, bufferPages: true, info: { Title: meta.title, Author: meta.company } });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    const left = doc.page.margins.left;
    const W = doc.page.width - left - doc.page.margins.right;
    const bottom = doc.page.height - doc.page.margins.bottom - 18;
    const weights = r.columns.map((c) => c.width ?? (c.type === 'money' ? 16 : c.type === 'date' ? 11 : c.type === 'int' || c.type === 'pct' ? 9 : 22));
    const sum = weights.reduce((a, b) => a + b, 0);
    const widths = weights.map((w) => (w / sum) * W);
    const xs = widths.map((_, i) => left + widths.slice(0, i).reduce((a, b) => a + b, 0));
    const fs = r.columns.length > 10 ? 6.5 : r.columns.length > 7 ? 7.5 : 8.5;
    // Standard PDF fonts have no ₹ glyph; amounts print in Indian grouping without the symbol.
    const fmt = (c: Column, v: unknown) => {
      if (v === null || v === undefined || v === '') return '';
      if (c.type === 'money') return formatINR(String(v), { symbol: false });
      if (c.type === 'pct') return `${Number(v).toFixed(2)}%`;
      if (c.type === 'date') return dmy(String(v));
      return String(v);
    };
    const right = (c: Column) => c.type === 'money' || c.type === 'int' || c.type === 'pct';

    const head = (first: boolean) => {
      if (first) {
        doc.font('Helvetica-Bold').fontSize(13).fillColor('#000').text(meta.company, left, doc.y);
        doc.font('Helvetica-Bold').fontSize(11).text(meta.title);
        doc.font('Helvetica').fontSize(8).fillColor('#444').text(meta.filters || 'No filters');
        doc.text(`Generated ${ist(meta.generatedAt)} IST by ${meta.generatedBy}`);
        for (const n of r.notes ?? []) doc.font('Helvetica-Oblique').text(n);
        doc.moveDown(0.5);
      }
      const y = doc.y;
      doc.rect(left, y - 2, W, fs + 8).fill('#eef1f4');
      doc.fillColor('#000').font('Helvetica-Bold').fontSize(fs);
      r.columns.forEach((c, i) => doc.text(c.label, xs[i]! + 2, y + 1, { width: widths[i]! - 4, align: right(c) ? 'right' : 'left', lineBreak: false, ellipsis: true }));
      doc.y = y + fs + 8;
    };
    const line = (row: Row, bold = false) => {
      const h = fs + 5;
      if (doc.y + h > bottom) {
        doc.addPage();
        head(false);
      }
      const y = doc.y;
      if (row._section) {
        doc.font('Helvetica-Bold').fontSize(fs).fillColor('#000').text(String(row._section), left + 2, y + 1, { width: W - 4, lineBreak: false });
      } else {
        doc.font(bold || row._bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(fs).fillColor('#000');
        r.columns.forEach((c, i) => doc.text(fmt(c, row[c.key]), xs[i]! + 2, y + 1, { width: widths[i]! - 4, align: right(c) ? 'right' : 'left', lineBreak: false, ellipsis: true }));
      }
      doc.moveTo(left, y + h - 1).lineTo(left + W, y + h - 1).lineWidth(0.3).strokeColor('#dde2e6').stroke();
      doc.y = y + h;
    };

    head(true);
    if (!r.rows.length) doc.font('Helvetica-Oblique').fontSize(9).text('No rows for these filters.', left, doc.y + 4);
    r.rows.forEach((x) => line(x));
    const t = totalsRow(r);
    if (t) {
      doc.moveTo(left, doc.y).lineTo(left + W, doc.y).lineWidth(0.8).strokeColor('#000').stroke();
      line(t, true);
    }
    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i++) {
      doc.switchToPage(range.start + i);
      doc.font('Helvetica').fontSize(7).fillColor('#666');
      doc.text(`${meta.title} · ${meta.company}`, left, doc.page.height - doc.page.margins.bottom - 8, { width: W / 2, lineBreak: false });
      doc.text(`Page ${i + 1} of ${range.count}`, left + W / 2, doc.page.height - doc.page.margins.bottom - 8, { width: W / 2, align: 'right', lineBreak: false });
    }
    doc.end();
  });
}
