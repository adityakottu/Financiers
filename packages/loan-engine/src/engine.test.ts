import fc from 'fast-check';
import { Money } from '@fin/money';
import { describe, expect, it } from 'vitest';
import { D } from '@fin/money';
import { addMonthsAnchored, dueDates, EngineError, generateSchedule, LoanTerms, penaltyForDay, xirr } from './index';

const base: LoanTerms = {
  principal: '100000',
  annualRate: '24',
  method: 'FLAT',
  frequency: 'MONTHLY',
  numInstallments: 12,
  disbursementDate: '2026-09-05',
  firstDueDate: '2026-10-05',
  roundingUnit: '1',
};

const sum = (xs: string[]) => Money.sum(xs.map((x) => Money.of(x))).toString();

describe('golden schedules (doc 06 worked examples)', () => {
  it('A — ₹1,00,000, 24% flat, 12 monthly, round to ₹1', () => {
    const s = generateSchedule(base);
    expect(s.totals.interest).toBe('24000.00');
    expect(s.totals.totalPayable).toBe('124000.00');
    expect(s.rows.slice(0, 11).every((r) => r.total === '10333.00' && r.principal === '8333.00' && r.interest === '2000.00')).toBe(true);
    expect(s.rows[11]).toMatchObject({ principal: '8337.00', interest: '2000.00', total: '10337.00', closingPrincipal: '0.00' });
    expect(s.totals.installmentAmount).toBe('10333.00');
    expect(s.maturityDate).toBe('2027-09-05');
  });

  it('B — same, 52 weekly', () => {
    const s = generateSchedule({ ...base, frequency: 'WEEKLY', numInstallments: 52, firstDueDate: '2026-09-12' });
    expect(s.totals.totalPayable).toBe('124000.00');
    expect(s.rows[0]!.total).toBe('2385.00');
    expect(s.rows[51]!.total).toBe('2365.00');
    expect(s.rows[1]!.dueDate).toBe('2026-09-19');
  });

  it('C — ₹1,00,000, 24% flat, 100 daily installments', () => {
    const s = generateSchedule({ ...base, frequency: 'DAILY', numInstallments: 100, firstDueDate: '2026-09-06' });
    expect(s.totals.interest).toBe('6575.34');
    expect(s.totals.totalPayable).toBe('106575.34');
    expect(s.rows[0]!.total).toBe('1066.00');
    expect(s.rows[99]!.total).toBe('1041.34');
  });

  it('D — ₹1,00,000, 24% reducing, 12 monthly: EMI ₹9,456', () => {
    const s = generateSchedule({ ...base, method: 'REDUCING_EMI' });
    expect(s.rows.slice(0, 3).map((r) => [r.openingPrincipal, r.interest, r.principal, r.total, r.closingPrincipal])).toEqual([
      ['100000.00', '2000.00', '7456.00', '9456.00', '92544.00'],
      ['92544.00', '1850.88', '7605.12', '9456.00', '84938.88'],
      ['84938.88', '1698.78', '7757.22', '9456.00', '77181.66'],
    ]);
    expect(s.rows[11]!.closingPrincipal).toBe('0.00');
    // ≈ ₹13,471 in doc 06; exact figures below were cross-checked with an independent Python implementation.
    expect(s.totals.interest).toBe('13471.46');
    expect(s.rows[11]!.total).toBe('9455.46');
    // XIRR on actual dates (month lengths vary), independently computed: 26.8942%.
    expect(Number(s.apr)).toBeCloseTo(26.8942, 3);
  });

  it('SIMPLE — equal principal, interest on balance for actual days', () => {
    const s = generateSchedule({ ...base, method: 'SIMPLE', numInstallments: 4 });
    expect(s.rows.map((r) => r.principal)).toEqual(['25000.00', '25000.00', '25000.00', '25000.00']);
    // 30 days on 1,00,000 at 24% = 1,972.60
    expect(s.rows[0]!.interest).toBe('1972.60');
    expect(Number(s.rows[1]!.total)).toBeLessThan(Number(s.rows[0]!.total));
  });

  it('flat 24% has a much higher APR than its headline rate', () => {
    const s = generateSchedule(base);
    // Independently computed XIRR: 50.8156% — more than double the "24%" headline.
    expect(Number(s.apr)).toBeCloseTo(50.8156, 3);
  });

  it('zero-rate loan: no interest, APR 0', () => {
    const s = generateSchedule({ ...base, annualRate: '0', method: 'REDUCING_EMI' });
    expect(s.totals.interest).toBe('0.00');
    expect(s.apr).toBe('0.0000');
  });
});

describe('APR solver', () => {
  it('Newton and bisection agree', () => {
    const flows = [
      { date: '2026-01-01', amount: new D(1000) },
      { date: '2026-01-31', amount: new D(-1100) },
    ];
    const a = xirr(flows);
    const b = xirr(flows, { solver: 'bisection' });
    // 1.1^(365/30) − 1
    expect(Number(a)).toBeCloseTo(Math.pow(1.1, 365 / 30) - 1, 6);
    expect(Number(b)).toBeCloseTo(Number(a), 8);
  });
});

describe('fees and broken period', () => {
  it('deducted fees reduce cash disbursed and raise the APR', () => {
    const plain = generateSchedule(base);
    const s = generateSchedule({ ...base, fees: [{ code: 'PROCESSING', amount: '2000', gstAmount: '360', mode: 'DEDUCT_FROM_DISBURSAL' }] });
    expect(s.totals.netDisbursed).toBe('97640.00');
    expect(s.totals.totalPayable).toBe(plain.totals.totalPayable);
    expect(Number(s.apr)).toBeGreaterThan(Number(plain.apr));
  });

  it('fees added to the first installment', () => {
    const s = generateSchedule({ ...base, fees: [{ code: 'DOCUMENTATION', amount: '500', gstAmount: '90', mode: 'ADD_TO_FIRST_INSTALLMENT' }] });
    expect(s.rows[0]).toMatchObject({ fees: '590.00', total: '10923.00' });
    expect(s.totals.totalPayable).toBe('124590.00');
    expect(s.totals.netDisbursed).toBe('100000.00');
  });

  it('reducing: a first installment 15 days late carries broken-period interest', () => {
    const s = generateSchedule({ ...base, method: 'REDUCING_EMI', firstDueDate: '2026-10-20' });
    // 15 extra days on 1,00,000 at 24% = 986.30
    expect(s.rows[0]!.interest).toBe('2986.30');
  });
});

describe('due dates', () => {
  it('keeps the month-end anchor', () => {
    expect(dueDates({ ...base, firstDueDate: '2027-01-31', numInstallments: 4 })).toEqual(['2027-01-31', '2027-02-28', '2027-03-31', '2027-04-30']);
    expect(addMonthsAnchored('2028-01-31', 1)).toBe('2028-02-29');
  });
  it('can skip Sundays for daily collection', () => {
    const d = dueDates({ ...base, frequency: 'DAILY', numInstallments: 7, firstDueDate: '2026-09-26', skipSundays: true });
    expect(d).toEqual(['2026-09-26', '2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-03']);
  });
  it('custom interval', () => {
    expect(dueDates({ ...base, frequency: 'CUSTOM', customIntervalDays: 10, numInstallments: 3 })).toEqual(['2026-10-05', '2026-10-15', '2026-10-25']);
  });
});

describe('validation', () => {
  it('rejects bad inputs with clear codes', () => {
    const code = (t: Partial<LoanTerms>) => {
      try {
        generateSchedule({ ...base, ...t });
        return 'OK';
      } catch (e) {
        return (e as EngineError).code;
      }
    };
    expect(code({ principal: '0' })).toBe('PRINCIPAL');
    expect(code({ principal: '100.001' })).toBe('PRINCIPAL');
    expect(code({ annualRate: '-5' })).toBe('RATE');
    expect(code({ annualRate: '150' })).toBe('RATE');
    expect(code({ numInstallments: 0 })).toBe('INSTALLMENTS');
    expect(code({ firstDueDate: '2026-09-05' })).toBe('FIRST_DUE');
    expect(code({ frequency: 'CUSTOM' })).toBe('CUSTOM_INTERVAL');
    expect(code({ fees: [{ code: 'X', amount: '100000', mode: 'DEDUCT_FROM_DISBURSAL' }] })).toBe('FEES');
    expect(code({ principal: '500', numInstallments: 100, frequency: 'DAILY', firstDueDate: '2026-09-06', roundingUnit: '10' })).toBe('ROUNDING');
  });
});

describe('invariants (property-based)', () => {
  const terms = fc.record({
    principal: fc.integer({ min: 1000, max: 50_00_000 }).map(String),
    annualRate: fc.constantFrom('0', '9.5', '12', '18', '24', '36'),
    method: fc.constantFrom('FLAT' as const, 'REDUCING_EMI' as const, 'SIMPLE' as const),
    frequency: fc.constantFrom('DAILY' as const, 'WEEKLY' as const, 'FORTNIGHTLY' as const, 'MONTHLY' as const, 'CUSTOM' as const),
    numInstallments: fc.integer({ min: 1, max: 120 }),
    roundingUnit: fc.constantFrom('0.01' as const, '1' as const, '10' as const),
    firstGap: fc.integer({ min: 1, max: 45 }),
  });

  it('principal and interest reconcile, balances close at zero, nothing negative', () => {
    fc.assert(
      fc.property(terms, (x) => {
        const t: LoanTerms = {
          ...base,
          ...x,
          customIntervalDays: 10,
          firstDueDate: new Date(Date.UTC(2026, 8, 5 + x.firstGap)).toISOString().slice(0, 10),
        };
        let s;
        try {
          s = generateSchedule(t);
        } catch (e) {
          // The only acceptable refusals are explicit engine errors (e.g. rounding too coarse).
          expect(e).toBeInstanceOf(EngineError);
          return;
        }
        expect(s.rows).toHaveLength(t.numInstallments);
        expect(sum(s.rows.map((r) => r.principal))).toBe(Money.of(t.principal).toString());
        expect(sum(s.rows.map((r) => r.interest))).toBe(s.totals.interest);
        expect(sum(s.rows.map((r) => r.total))).toBe(s.totals.totalPayable);
        expect(s.rows[s.rows.length - 1]!.closingPrincipal).toBe('0.00');
        for (const r of s.rows) {
          expect(Money.of(r.principal).isNegative()).toBe(false);
          expect(Money.of(r.interest).isNegative()).toBe(false);
        }
        for (let i = 1; i < s.rows.length; i++) expect(s.rows[i]!.dueDate > s.rows[i - 1]!.dueDate).toBe(true);
        expect(Number(s.apr)).toBeGreaterThanOrEqual(0);
        // Deterministic.
        expect(JSON.stringify(generateSchedule(t))).toBe(JSON.stringify(s));
      }),
      { numRuns: 200 },
    );
  }, 180_000);
});

describe('penal charges', () => {
  const s = { daysOverdue: 5, overdueAmount: '10333.00', alreadyCharged: '0' };
  it('nothing within the grace period', () => {
    expect(penaltyForDay({ type: 'FLAT_PER_INSTALLMENT', value: '100', graceDays: 5 }, s).toString()).toBe('0.00');
  });
  it('flat charge once per installment', () => {
    const r = { type: 'FLAT_PER_INSTALLMENT' as const, value: '100', graceDays: 3 };
    expect(penaltyForDay(r, s).toString()).toBe('100.00');
    expect(penaltyForDay(r, { ...s, alreadyCharged: '100' }).toString()).toBe('0.00');
  });
  it('daily percentage with a cap', () => {
    const r = { type: 'PCT_PA_ON_OVERDUE' as const, value: '36', graceDays: 0, cap: '20' };
    // 10,333 × 36% / 365 = 10.19 per day
    expect(penaltyForDay(r, s).toString()).toBe('10.19');
    expect(penaltyForDay(r, { ...s, alreadyCharged: '15' }).toString()).toBe('5.00');
    expect(penaltyForDay(r, { ...s, alreadyCharged: '20' }).toString()).toBe('0.00');
  });
});
