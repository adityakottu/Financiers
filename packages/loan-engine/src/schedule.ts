import { D, Dec, Money } from '@fin/money';
import { addDays, addMonthsAnchored, compareDates, daysBetween, isSunday, parseDate } from './dates';
import { xirr } from './apr';
import { EngineError, Frequency, LoanTerms, Schedule, ScheduleRow } from './types';

export const ENGINE_VERSION = '1.0.0';

const PERIODS_PER_YEAR: Record<Exclude<Frequency, 'CUSTOM'>, number> = {
  DAILY: 365,
  WEEKLY: 52,
  FORTNIGHTLY: 26,
  MONTHLY: 12,
};

export function periodsPerYear(t: Pick<LoanTerms, 'frequency' | 'customIntervalDays'>): Dec {
  if (t.frequency === 'CUSTOM') {
    if (!t.customIntervalDays || t.customIntervalDays < 1) throw new EngineError('CUSTOM_INTERVAL', 'Custom frequency needs an interval in days');
    return new D(365).dividedBy(t.customIntervalDays);
  }
  return new D(PERIODS_PER_YEAR[t.frequency]);
}

/** Due dates per doc 06 §3. */
export function dueDates(t: LoanTerms): string[] {
  const n = t.numInstallments;
  const out: string[] = [];
  switch (t.frequency) {
    case 'MONTHLY': {
      const anchor = parseDate(t.firstDueDate).d;
      for (let k = 0; k < n; k++) out.push(addMonthsAnchored(t.firstDueDate, k, anchor));
      break;
    }
    case 'DAILY': {
      let d = t.firstDueDate;
      if (t.skipSundays && isSunday(d)) d = addDays(d, 1);
      while (out.length < n) {
        if (!(t.skipSundays && isSunday(d))) out.push(d);
        d = addDays(d, 1);
      }
      break;
    }
    default: {
      const step = t.frequency === 'WEEKLY' ? 7 : t.frequency === 'FORTNIGHTLY' ? 14 : t.customIntervalDays!;
      for (let k = 0; k < n; k++) out.push(addDays(t.firstDueDate, k * step));
    }
  }
  return out;
}

/** The first due date one regular period after disbursement (used for broken-period interest). */
function nominalFirstDue(t: LoanTerms): string {
  switch (t.frequency) {
    case 'MONTHLY':
      return addMonthsAnchored(t.disbursementDate, 1);
    case 'DAILY':
      return addDays(t.disbursementDate, 1);
    case 'WEEKLY':
      return addDays(t.disbursementDate, 7);
    case 'FORTNIGHTLY':
      return addDays(t.disbursementDate, 14);
    case 'CUSTOM':
      return addDays(t.disbursementDate, t.customIntervalDays!);
  }
}

function validate(t: LoanTerms): { P: Money; R: Dec } {
  let P: Money;
  try {
    P = Money.of(t.principal);
  } catch {
    throw new EngineError('PRINCIPAL', 'Loan amount is not a valid amount');
  }
  if (!P.isPositive()) throw new EngineError('PRINCIPAL', 'Loan amount must be more than zero');
  if (!/^\d{1,3}(\.\d{1,4})?$/.test(t.annualRate)) throw new EngineError('RATE', 'Interest rate must be a percentage like 24 or 18.5');
  const R = new D(t.annualRate);
  if (R.greaterThan(100)) throw new EngineError('RATE', 'Interest rate above 100% p.a. is not allowed');
  if (!Number.isInteger(t.numInstallments) || t.numInstallments < 1 || t.numInstallments > 1000) {
    throw new EngineError('INSTALLMENTS', 'Number of installments must be between 1 and 1000');
  }
  parseDate(t.disbursementDate);
  parseDate(t.firstDueDate);
  if (compareDates(t.firstDueDate, t.disbursementDate) <= 0) {
    throw new EngineError('FIRST_DUE', 'First installment must be due after the disbursement date');
  }
  periodsPerYear(t);
  return { P, R };
}

const pct = (r: Dec) => r.dividedBy(100);

/**
 * Generate the full repayment schedule (doc 06). Pure: same input → same output, byte for byte.
 * Rounding: interest per row to paise; installment to the product's unit; last installment
 * takes the exact residual so the totals reconcile to the paisa.
 */
export function generateSchedule(terms: LoanTerms): Schedule {
  const t: LoanTerms = { ...terms, fees: terms.fees ?? [] };
  const { P, R } = validate(t);
  const N = t.numInstallments;
  const m = periodsPerYear(t);
  const unit = t.roundingUnit;
  const dates = dueDates(t);

  // Fees.
  let feesDeducted = Money.zero();
  let feesInInstallments = Money.zero();
  let feeTotal = Money.zero();
  let gstTotal = Money.zero();
  for (const f of t.fees!) {
    const amount = Money.of(f.amount);
    const gst = Money.of(f.gstAmount ?? '0');
    if (amount.isNegative() || gst.isNegative()) throw new EngineError('FEES', 'Fees cannot be negative');
    feeTotal = feeTotal.plus(amount);
    gstTotal = gstTotal.plus(gst);
    if (f.mode === 'DEDUCT_FROM_DISBURSAL') feesDeducted = feesDeducted.plus(amount).plus(gst);
    else feesInInstallments = feesInInstallments.plus(amount).plus(gst);
  }
  const netDisbursed = P.minus(feesDeducted);
  if (!netDisbursed.isPositive()) throw new EngineError('FEES', 'Deducted fees leave nothing to disburse');

  const rows: { principal: Money; interest: Money }[] = [];

  if (t.method === 'FLAT') {
    // Interest on the original principal for the whole tenure, split straight-line.
    const totalInterest = P.times(pct(R).times(N).dividedBy(m));
    const total = P.plus(totalInterest);
    const inst = N === 1 ? total : Money.of(total.toDecimal().dividedBy(N)).roundTo(unit);
    const interestEach = Money.of(totalInterest.toDecimal().dividedBy(N));
    let pSum = Money.zero();
    let iSum = Money.zero();
    for (let k = 1; k < N; k++) {
      const principal = inst.minus(interestEach);
      rows.push({ principal, interest: interestEach });
      pSum = pSum.plus(principal);
      iSum = iSum.plus(interestEach);
    }
    rows.push({ principal: P.minus(pSum), interest: totalInterest.minus(iSum) });
  } else if (t.method === 'REDUCING_EMI') {
    const i = pct(R).dividedBy(m);
    let emi: Money;
    if (i.isZero()) emi = Money.of(P.toDecimal().dividedBy(N)).roundTo(unit);
    else {
      const f = i.plus(1).pow(N);
      emi = Money.of(P.toDecimal().times(i).times(f).dividedBy(f.minus(1))).roundTo(unit);
    }
    // Broken period: a first installment later than one regular period carries the extra days' interest.
    const extraDays = daysBetween(nominalFirstDue(t), t.firstDueDate);
    const brokenInterest = extraDays > 0 ? P.times(pct(R).times(extraDays).dividedBy(365)) : Money.zero();
    let bal = P;
    for (let k = 1; k <= N; k++) {
      const interest = bal.times(i);
      const principal = k === N ? bal : emi.minus(interest);
      if (principal.isNegative() || (k < N && !principal.isPositive())) {
        throw new EngineError('NEGATIVE_AMORTISATION', 'The installment does not cover the interest. Increase tenure-adjusted EMI or reduce the rate.');
      }
      const prin = principal.gt(bal) ? bal : principal;
      rows.push({ principal: prin, interest: k === 1 ? interest.plus(brokenInterest) : interest });
      bal = bal.minus(prin);
      if (bal.isZero() && k < N) {
        throw new EngineError('ROUNDING', 'Rounding repays the loan before the last installment. Use a smaller rounding unit.');
      }
    }
  } else if (t.method === 'SIMPLE') {
    const principalEach = Money.of(P.toDecimal().dividedBy(N)).roundTo(unit);
    let bal = P;
    let prev = t.disbursementDate;
    for (let k = 1; k <= N; k++) {
      const days = daysBetween(prev, dates[k - 1]!);
      const interest = bal.times(pct(R).times(days).dividedBy(365));
      const principal = k === N ? bal : principalEach;
      rows.push({ principal, interest });
      bal = bal.minus(principal);
      prev = dates[k - 1]!;
    }
  } else {
    throw new EngineError('METHOD', `Unknown interest method ${String(t.method)}`);
  }

  // Assemble rows, fees on installment 1, and check invariants.
  let opening = P;
  let interestTotal = Money.zero();
  const out: ScheduleRow[] = rows.map((r, idx) => {
    if (r.principal.isNegative() || r.interest.isNegative()) {
      throw new EngineError('ROUNDING', 'This rounding unit is too large for the installment size. Use a smaller rounding unit.');
    }
    const fees = idx === 0 ? feesInInstallments : Money.zero();
    const closing = opening.minus(r.principal);
    const row: ScheduleRow = {
      no: idx + 1,
      dueDate: dates[idx]!,
      openingPrincipal: opening.toString(),
      principal: r.principal.toString(),
      interest: r.interest.toString(),
      fees: fees.toString(),
      total: r.principal.plus(r.interest).plus(fees).toString(),
      closingPrincipal: closing.toString(),
    };
    interestTotal = interestTotal.plus(r.interest);
    opening = closing;
    return row;
  });
  if (!opening.isZero()) throw new Error(`Engine invariant broken: closing balance ${opening.toString()}`);
  const last = out[out.length - 1]!;
  if (!Money.of(last.total).isPositive()) {
    throw new EngineError('ROUNDING', 'This rounding unit is too large for the installment size. Use a smaller rounding unit.');
  }

  const totalPayable = Money.sum(out.map((r) => Money.of(r.total)));
  const regular = N > 1 ? Money.of(out[1]!.principal).plus(Money.of(out[1]!.interest)) : Money.of(last.total);

  const apr = xirr([
    { date: t.disbursementDate, amount: netDisbursed.toDecimal() },
    ...out.map((r) => ({ date: r.dueDate, amount: new D(r.total).negated() })),
  ]);

  return {
    engineVersion: ENGINE_VERSION,
    terms: t,
    rows: out,
    totals: {
      principal: P.toString(),
      interest: interestTotal.toString(),
      fees: feeTotal.toString(),
      gst: gstTotal.toString(),
      feesDeducted: feesDeducted.toString(),
      feesInInstallments: feesInInstallments.toString(),
      totalPayable: totalPayable.toString(),
      installmentAmount: regular.toString(),
      lastInstallmentAmount: last.total,
      netDisbursed: netDisbursed.toString(),
    },
    apr: apr.times(100).toDecimalPlaces(4).toFixed(4),
    maturityDate: last.dueDate,
  };
}
