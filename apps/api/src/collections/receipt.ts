import { Money } from '@fin/money';
import PDFDocument from 'pdfkit';
import { toBuffer } from 'qrcode';

/** Exactly what was printed on a receipt. Stored with it so a reprint never changes. */
export interface ReceiptSnapshot {
  company: { name: string; address: string | null; phone: string | null; gstin: string | null; footer: string | null };
  branch: { code: string; name: string };
  receiptNo: string;
  paymentNo: string;
  issuedAt: string;
  valueDate: string;
  customer: { name: string; customerNo: string };
  loan: { loanNo: string };
  amount: string;
  amountInWords: string;
  method: string;
  reference: string | null;
  chequeBank: string | null;
  chequeDate: string | null;
  collectedBy: string | null;
  components: { penalty: string; fee: string; interest: string; principal: string; advance: string };
  installmentsCleared: number[];
  installmentsPart: number[];
  balanceAfter: string;
  nextDue: { date: string; amount: string } | null;
  loanClosed: boolean;
  fullSettlement: boolean;
}

const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

function belowHundred(n: number): string {
  return n < 20 ? ONES[n]! : `${TENS[Math.floor(n / 10)]}${n % 10 ? ' ' + ONES[n % 10] : ''}`;
}
function belowThousand(n: number): string {
  const h = Math.floor(n / 100);
  const r = n % 100;
  return [h ? `${ONES[h]} Hundred` : '', r ? belowHundred(r) : ''].filter(Boolean).join(' ');
}

/** Indian system: 1,23,45,678 → "One Crore Twenty Three Lakh Forty Five Thousand Six Hundred Seventy Eight". */
export function rupeesInWords(amount: string): string {
  const [ip = '0', fp = '00'] = Money.of(amount).toString().split('.');
  let n = BigInt(ip);
  const parts: string[] = [];
  const crore = n / 10_000_000n;
  n %= 10_000_000n;
  if (crore > 0n) parts.push(`${crore > 999n ? rupeesInWords(crore.toString()).replace(/^Rupees | Only$/g, '') : belowThousand(Number(crore))} Crore`);
  const lakh = Number(n / 100_000n);
  n %= 100_000n;
  if (lakh) parts.push(`${belowHundred(lakh)} Lakh`);
  const thousand = Number(n / 1000n);
  n %= 1000n;
  if (thousand) parts.push(`${belowHundred(thousand)} Thousand`);
  if (n > 0n) parts.push(belowThousand(Number(n)));
  const rupees = parts.length ? parts.join(' ') : 'Zero';
  const paise = Number(fp);
  return `Rupees ${rupees}${paise ? ` and ${belowHundred(paise)} Paise` : ''} Only`;
}

const rs = (v: string) => `Rs. ${Money.of(v).format({ symbol: false })}`;
const dmy = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}`;
const istTime = (iso: string) =>
  new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true }).format(new Date(iso));
const METHOD: Record<string, string> = { CASH: 'Cash', UPI: 'UPI', BANK_TRANSFER: 'Bank transfer', CHEQUE: 'Cheque' };

/** A5 receipt with a QR code linking to the public verification page. Cancelled receipts are watermarked. */
export async function receiptPdf(s: ReceiptSnapshot, opts: { cancelled: boolean; verifyUrl: string }): Promise<Buffer> {
  const qr = await toBuffer(opts.verifyUrl, { margin: 0, width: 160, errorCorrectionLevel: 'M' });
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A5', margin: 32, info: { Title: `Receipt ${s.receiptNo}`, Author: s.company.name } });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    const W = doc.page.width - 64;

    doc.font('Helvetica-Bold').fontSize(13).text(s.company.name, 32, 32, { width: W - 90 });
    doc.font('Helvetica').fontSize(8).fillColor('#555');
    if (s.company.address) doc.text(s.company.address, { width: W - 90 });
    doc.text([s.company.phone, s.company.gstin ? `GSTIN ${s.company.gstin}` : null, `Branch ${s.branch.name}`].filter(Boolean).join(' · '), { width: W - 90 });
    doc.image(qr, 32 + W - 72, 30, { width: 72 });
    doc.fontSize(6).text('Scan to verify', 32 + W - 72, 104, { width: 72, align: 'center' });

    doc.moveDown(1.2).fillColor('#000').font('Helvetica-Bold').fontSize(12).text('PAYMENT RECEIPT', 32, 122);
    doc.moveTo(32, doc.y + 4).lineTo(32 + W, doc.y + 4).strokeColor('#ccc').stroke();

    const rows: [string, string][] = [
      ['Receipt no.', s.receiptNo],
      ['Date', istTime(s.issuedAt)],
      ['Customer', `${s.customer.name} (${s.customer.customerNo})`],
      ['Loan no.', s.loan.loanNo],
      ['Paid by', METHOD[s.method] ?? s.method],
      ...(s.reference ? [[s.method === 'CHEQUE' ? 'Cheque no.' : 'Reference / UTR', s.reference] as [string, string]] : []),
      ...(s.chequeBank ? [['Cheque', `${s.chequeBank}${s.chequeDate ? `, dated ${dmy(s.chequeDate)}` : ''} (subject to realisation)`] as [string, string]] : []),
      ...(s.collectedBy ? [['Collected by', s.collectedBy] as [string, string]] : []),
    ];
    let y = doc.y + 12;
    for (const [k, v] of rows) {
      doc.font('Helvetica').fontSize(9).fillColor('#666').text(k, 32, y, { width: 100 });
      doc.font('Helvetica-Bold').fillColor('#000').text(v, 135, y, { width: W - 103 });
      y = doc.y + 4;
    }

    y += 6;
    doc.rect(32, y, W, 44).fillColor('#f3f5f7').fill();
    doc.fillColor('#000').font('Helvetica').fontSize(9).text('Amount received', 42, y + 8);
    doc.font('Helvetica-Bold').fontSize(16).text(rs(s.amount), 42, y + 20, { width: W - 20 });
    y += 52;
    doc.font('Helvetica-Oblique').fontSize(8).fillColor('#444').text(s.amountInWords, 32, y, { width: W });
    y = doc.y + 10;

    doc.font('Helvetica-Bold').fontSize(9).fillColor('#000').text('Applied to', 32, y);
    y = doc.y + 4;
    const comp: [string, string][] = [
      ['Penal charges', s.components.penalty],
      ['Fees', s.components.fee],
      ['Interest', s.components.interest],
      ['Principal', s.components.principal],
      ['Advance (applied to future installments)', s.components.advance],
    ];
    for (const [k, v] of comp.filter(([, v]) => Money.of(v).isPositive())) {
      doc.font('Helvetica').fontSize(9).text(k, 42, y, { width: W - 130 });
      doc.text(rs(v), 32 + W - 120, y, { width: 120, align: 'right' });
      y = doc.y + 3;
    }
    const notes: string[] = [];
    if (s.installmentsCleared.length) notes.push(`Installment ${s.installmentsCleared.join(', ')} paid in full.`);
    if (s.installmentsPart.length) notes.push(`Installment ${s.installmentsPart.join(', ')} paid in part.`);
    doc.font('Helvetica').fontSize(8).fillColor('#444').text(notes.join(' '), 32, y + 4, { width: W });
    y = doc.y + 10;

    doc.moveTo(32, y).lineTo(32 + W, y).strokeColor('#ccc').stroke();
    y += 8;
    doc.fillColor('#000').font('Helvetica').fontSize(9).text('Balance payable after this payment', 32, y, { width: W - 120 });
    doc.font('Helvetica-Bold').text(rs(s.balanceAfter), 32 + W - 120, y, { width: 120, align: 'right' });
    y = doc.y + 4;
    if (s.loanClosed) doc.font('Helvetica-Bold').fillColor('#0a7d4f').text('Loan fully repaid and closed. Thank you.', 32, y);
    else if (s.nextDue) doc.font('Helvetica').fillColor('#000').text(`Next installment: ${rs(s.nextDue.amount)} due ${dmy(s.nextDue.date)}`, 32, y);

    doc.font('Helvetica').fontSize(7).fillColor('#777');
    const footer = [s.company.footer, `Verify this receipt at ${opts.verifyUrl}`, 'Computer-generated receipt; no signature required.'].filter(Boolean).join('\n');
    doc.text(footer, 32, doc.page.height - 32 - 36, { width: W, align: 'center' });

    if (opts.cancelled) {
      doc.save();
      doc.rotate(-35, { origin: [doc.page.width / 2, doc.page.height / 2] });
      doc.font('Helvetica-Bold').fontSize(64).fillColor('#c62828').opacity(0.25).text('CANCELLED', 0, doc.page.height / 2 - 40, { width: doc.page.width, align: 'center' });
      doc.restore();
    }
    doc.end();
  });
}
