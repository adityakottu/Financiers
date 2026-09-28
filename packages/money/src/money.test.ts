import { describe, expect, it } from 'vitest';
import { Money, MoneyError, formatINR, groupIndian } from './index';

describe('Money', () => {
  it('parses strings exactly and keeps 2dp', () => {
    expect(Money.of('1250').toString()).toBe('1250.00');
    expect(Money.of('0.1').plus(Money.of('0.2')).toString()).toBe('0.30');
  });

  it('rejects fractional JS numbers and malformed strings', () => {
    expect(() => Money.of(0.1)).toThrow(MoneyError);
    expect(() => Money.of('1.234')).toThrow(MoneyError);
    expect(() => Money.of('abc')).toThrow(MoneyError);
    expect(Money.of(100).toString()).toBe('100.00');
  });

  it('rounds half up on multiplication', () => {
    // 84,938.88 × 2% = 1,698.7776 → 1,698.78
    expect(Money.of('84938.88').times('0.02').toString()).toBe('1698.78');
    expect(Money.of('0.05').times('0.5').toString()).toBe('0.03');
  });

  it('rounds to rupee units', () => {
    expect(Money.of('10333.33').roundTo(1).toString()).toBe('10333.00');
    expect(Money.of('2384.62').roundTo(1).toString()).toBe('2385.00');
    expect(Money.of('1234.00').roundTo(10).toString()).toBe('1230.00');
  });

  it('sums and compares', () => {
    const s = Money.sum([Money.of('50'), Money.of('300'), Money.of('900')]);
    expect(s.eq(Money.of('1250'))).toBe(true);
    expect(Money.of('1').gt(Money.zero())).toBe(true);
    expect(Money.of('-1').isNegative()).toBe(true);
  });

  it('serialises to JSON as a string', () => {
    expect(JSON.stringify({ a: Money.of('5') })).toBe('{"a":"5.00"}');
  });
});

describe('Indian formatting', () => {
  it('groups digits in lakhs and crores', () => {
    expect(groupIndian('100000')).toBe('1,00,000');
    expect(groupIndian('123456789')).toBe('12,34,56,789');
    expect(groupIndian('999')).toBe('999');
  });
  it('formats rupees', () => {
    expect(formatINR('124000.00')).toBe('₹1,24,000.00');
    expect(formatINR('-500.5')).toBe('-₹500.50');
    expect(Money.of('97640').format({ decimals: false })).toBe('₹97,640');
  });
});
