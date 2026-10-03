import Decimal from 'decimal.js';

/**
 * Decimal configured for money work: high precision, and every rounding is explicit.
 * Never use JS `number` for amounts.
 */
export const D = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });
export type Dec = InstanceType<typeof D>;

export type DecimalInput = string | number | Dec;

const MONEY_RE = /^-?\d{1,16}(\.\d{1,2})?$/;

/** Immutable INR amount, always held at exactly 2 decimal places. */
export class Money {
  private constructor(private readonly value: Dec) {}

  static of(input: DecimalInput): Money {
    if (typeof input === 'number') {
      // Numbers are only accepted when they are exact integers (e.g. 0, 100) — never fractions.
      if (!Number.isSafeInteger(input)) {
        throw new MoneyError(`Refusing non-integer number ${input}; pass a string`);
      }
      return new Money(new D(input).toDecimalPlaces(2));
    }
    if (typeof input === 'string') {
      const s = input.trim();
      if (!MONEY_RE.test(s)) throw new MoneyError(`Invalid money amount "${input}"`);
      return new Money(new D(s));
    }
    return new Money(input.toDecimalPlaces(2, D.ROUND_HALF_UP));
  }

  static zero(): Money {
    return new Money(new D(0));
  }

  static sum(items: Money[]): Money {
    return items.reduce((acc, m) => acc.plus(m), Money.zero());
  }

  plus(o: Money): Money {
    return new Money(this.value.plus(o.value));
  }
  minus(o: Money): Money {
    return new Money(this.value.minus(o.value));
  }
  /** Multiply by a factor and round to paise (HALF_UP). */
  times(factor: DecimalInput): Money {
    return Money.of(this.value.times(new D(factor)));
  }
  /** Round to a unit such as 1 or 10 rupees (HALF_UP). */
  roundTo(unit: DecimalInput): Money {
    const u = new D(unit);
    return Money.of(this.value.dividedBy(u).toDecimalPlaces(0, D.ROUND_HALF_UP).times(u));
  }
  min(o: Money): Money {
    return this.lte(o) ? this : o;
  }

  cmp(o: Money): number {
    return this.value.comparedTo(o.value);
  }
  eq(o: Money): boolean {
    return this.cmp(o) === 0;
  }
  lt(o: Money): boolean {
    return this.cmp(o) < 0;
  }
  lte(o: Money): boolean {
    return this.cmp(o) <= 0;
  }
  gt(o: Money): boolean {
    return this.cmp(o) > 0;
  }
  gte(o: Money): boolean {
    return this.cmp(o) >= 0;
  }
  isZero(): boolean {
    return this.value.isZero();
  }
  isNegative(): boolean {
    return this.value.isNegative() && !this.value.isZero();
  }
  isPositive(): boolean {
    return this.value.isPositive() && !this.value.isZero();
  }

  toDecimal(): Dec {
    return this.value;
  }
  /** Canonical wire/DB format: "1250.00". */
  toString(): string {
    return this.value.toFixed(2);
  }
  toJSON(): string {
    return this.toString();
  }
  /** Display format with Indian digit grouping: "₹1,24,000.00". */
  format(opts: { symbol?: boolean; decimals?: boolean } = {}): string {
    return formatINR(this.toString(), opts);
  }
}

export class MoneyError extends Error {
  override name = 'MoneyError';
}

/** Group digits the Indian way: 12,34,56,789. */
export function groupIndian(intPart: string): string {
  if (intPart.length <= 3) return intPart;
  const last3 = intPart.slice(-3);
  const rest = intPart.slice(0, -3);
  return rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + last3;
}

export function formatINR(
  amount: string,
  { symbol = true, decimals = true }: { symbol?: boolean; decimals?: boolean } = {},
): string {
  const neg = amount.startsWith('-');
  const [i = '0', f = '00'] = (neg ? amount.slice(1) : amount).split('.');
  const body = groupIndian(i) + (decimals ? '.' + f.padEnd(2, '0').slice(0, 2) : '');
  return (neg ? '-' : '') + (symbol ? '₹' : '') + body;
}
