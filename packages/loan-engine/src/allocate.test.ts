import fc from 'fast-check';
import { Money } from '@fin/money';
import { describe, expect, it } from 'vitest';
import { allocate, AllocationRule, EngineError, OpenInstallment } from './index';

const STD: AllocationRule = { mode: 'INSTALLMENT_WISE', order: ['PENALTY', 'FEE', 'INTEREST', 'PRINCIPAL'], excessHandling: 'ADVANCE' };
const CW: AllocationRule = { ...STD, mode: 'COMPONENT_WISE' };

// Doc 08 §4: installments 6 (overdue), 7 (due today), 8 (upcoming).
const items: OpenInstallment[] = [
  { id: 'i6', no: 6, dueDate: '2026-09-05', penalty: '50', fee: '0', interest: '300', principal: '900' },
  { id: 'i7', no: 7, dueDate: '2026-10-05', penalty: '0', fee: '0', interest: '300', principal: '900' },
  { id: 'i8', no: 8, dueDate: '2026-11-05', penalty: '0', fee: '0', interest: '300', principal: '900' },
];
const asOf = '2026-10-05';
const brief = (a: ReturnType<typeof allocate>) => a.lines.map((l) => `${l.installmentNo ?? '-'}:${l.component}:${l.amount}`);

describe('allocation — doc 08 worked examples', () => {
  it('a) exact installment ₹1,250 clears #6', () => {
    expect(brief(allocate(items, '1250', STD, asOf))).toEqual(['6:PENALTY:50.00', '6:INTEREST:300.00', '6:PRINCIPAL:900.00']);
  });
  it('b) partial ₹500 → penalty, interest, then principal 150', () => {
    expect(brief(allocate(items, '500', STD, asOf))).toEqual(['6:PENALTY:50.00', '6:INTEREST:300.00', '6:PRINCIPAL:150.00']);
  });
  it('c) ₹2,450 clears #6 and #7', () => {
    const a = allocate(items, '2450', STD, asOf);
    expect(brief(a)).toEqual(['6:PENALTY:50.00', '6:INTEREST:300.00', '6:PRINCIPAL:900.00', '7:INTEREST:300.00', '7:PRINCIPAL:900.00']);
    expect(a.advance).toBe('0.00');
  });
  it('d) overpayment ₹3,000 → ₹550 customer advance (installment 8 is not yet due)', () => {
    const a = allocate(items, '3000', STD, asOf);
    expect(a.advance).toBe('550.00');
    expect(a.lines.at(-1)).toMatchObject({ component: 'ADVANCE', installmentId: null, amount: '550.00' });
  });
  it('e) component-wise ₹500 → all penalties, then interest oldest first', () => {
    expect(brief(allocate(items, '500', CW, asOf))).toEqual(['6:PENALTY:50.00', '6:INTEREST:300.00', '7:INTEREST:150.00']);
  });
  it('REJECT excess handling refuses overpayment', () => {
    expect(() => allocate(items, '3000', { ...STD, excessHandling: 'REJECT' }, asOf)).toThrow(EngineError);
    try {
      allocate(items, '3000', { ...STD, excessHandling: 'REJECT' }, asOf);
    } catch (e) {
      expect((e as EngineError).code).toBe('OVERPAYMENT_NOT_ALLOWED');
    }
  });
  it('custom order (principal before interest) is honoured', () => {
    const a = allocate(items, '1000', { ...STD, order: ['PENALTY', 'FEE', 'PRINCIPAL', 'INTEREST'] }, asOf);
    expect(brief(a)).toEqual(['6:PENALTY:50.00', '6:PRINCIPAL:900.00', '6:INTEREST:50.00']);
  });
  it('fees (e.g. documentation fee with installment 1) are settled in order', () => {
    const a = allocate([{ id: 'x', no: 1, dueDate: '2026-10-01', penalty: '0', fee: '590', interest: '1400', principal: '5833' }], '1000', STD, asOf);
    expect(brief(a)).toEqual(['1:FEE:590.00', '1:INTEREST:410.00']);
  });
  it('nothing due yet → whole payment is an advance', () => {
    const a = allocate(items, '1000', STD, '2026-08-01');
    expect(brief(a)).toEqual(['-:ADVANCE:1000.00']);
  });
  it('rejects zero, negative and sub-paisa amounts', () => {
    for (const bad of ['0', '-5']) expect(() => allocate(items, bad, STD, asOf)).toThrow();
    expect(() => allocate(items, '10.005', STD, asOf)).toThrow();
  });
  it('rejects an invalid rule', () => {
    expect(() => allocate(items, '10', { ...STD, order: ['PENALTY', 'PENALTY', 'INTEREST', 'PRINCIPAL'] }, asOf)).toThrow(EngineError);
  });
});

describe('allocation — properties', () => {
  const money = fc.integer({ min: 0, max: 5_000_000 }).map((p) => (p / 100).toFixed(2));
  const inst = fc.record({
    no: fc.integer({ min: 1, max: 60 }),
    day: fc.integer({ min: 1, max: 60 }),
    penalty: money,
    fee: money,
    interest: money,
    principal: money,
  });
  const arb = fc.record({
    list: fc.uniqueArray(inst, { selector: (i) => i.no, maxLength: 12 }),
    amount: fc.integer({ min: 1, max: 30_000_000 }).map((p) => (p / 100).toFixed(2)),
    mode: fc.constantFrom('INSTALLMENT_WISE' as const, 'COMPONENT_WISE' as const),
    order: fc.shuffledSubarray(['PENALTY', 'FEE', 'INTEREST', 'PRINCIPAL'] as const, { minLength: 4, maxLength: 4 }),
    asOfDay: fc.integer({ min: 1, max: 60 }),
  });
  const day = (d: number) => `2026-${String(1 + Math.floor((d - 1) / 28)).padStart(2, '0')}-${String(((d - 1) % 28) + 1).padStart(2, '0')}`;

  it('sums exactly, never over-settles, never negative, order-independent and repeatable', () => {
    fc.assert(
      fc.property(arb, ({ list, amount, mode, order, asOfDay }) => {
        const items: OpenInstallment[] = list.map((i) => ({ id: `id${i.no}`, no: i.no, dueDate: day(i.day), penalty: i.penalty, fee: i.fee, interest: i.interest, principal: i.principal }));
        const rule: AllocationRule = { mode, order: [...order], excessHandling: 'ADVANCE' };
        const asOf = day(asOfDay);
        const a = allocate(items, amount, rule, asOf);
        // Σ lines = payment
        expect(Money.sum(a.lines.map((l) => Money.of(l.amount))).eq(Money.of(amount))).toBe(true);
        // no line exceeds what was outstanding; nothing allocated to a not-yet-due installment
        const used = new Map<string, Money>();
        for (const l of a.lines) {
          expect(Money.of(l.amount).isPositive()).toBe(true);
          if (l.component === 'ADVANCE') continue;
          const it = items.find((i) => i.id === l.installmentId)!;
          expect(it.dueDate <= asOf).toBe(true);
          const k = `${l.installmentId}:${l.component}`;
          const v = (used.get(k) ?? Money.zero()).plus(Money.of(l.amount));
          used.set(k, v);
          const key = { PENALTY: 'penalty', FEE: 'fee', INTEREST: 'interest', PRINCIPAL: 'principal' }[l.component] as 'penalty';
          expect(v.lte(Money.of(it[key]))).toBe(true);
        }
        // advance only when everything eligible is fully settled
        if (Money.of(a.advance).isPositive()) {
          const dueTotal = Money.sum(items.filter((i) => i.dueDate <= asOf).flatMap((i) => [i.penalty, i.fee, i.interest, i.principal].map((x) => Money.of(x))));
          expect(Money.of(amount).minus(Money.of(a.advance)).eq(dueTotal)).toBe(true);
        }
        // independent of input order, and byte-identical on re-run
        expect(allocate([...items].reverse(), amount, rule, asOf)).toEqual(a);
        expect(JSON.stringify(allocate(items, amount, rule, asOf))).toBe(JSON.stringify(a));
      }),
      { numRuns: 500 },
    );
  });
});
