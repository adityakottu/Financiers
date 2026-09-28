import { D, Dec } from '@fin/money';
import { daysBetween } from './dates';
import { EngineError } from './types';

/** Lower precision is ample for a rate quoted to 4 decimals and keeps exp/ln fast. */
const R = D.clone({ precision: 30 });

interface Flow {
  date: string;
  amount: Dec;
}

/**
 * Annual effective rate r such that Σ amount_i / (1 + r)^(days_i / 365) = 0 (XIRR).
 * Decimal arithmetic throughout; Newton's method with a bisection fallback.
 */
export function xirr(flows: Flow[], opts: { solver?: 'auto' | 'bisection' } = {}): Dec {
  if (flows.length < 2) throw new EngineError('APR', 'Need at least two cash flows');
  const t0 = flows[0]!.date;
  const fs = flows.map((f) => ({ t: new R(daysBetween(t0, f.date)).dividedBy(365), a: new R(f.amount.toString()) }));
  const outflow = fs.reduce((s, f) => (f.a.isNegative() ? s.plus(f.a.negated()) : s), new R(0));
  const inflow = fs.reduce((s, f) => (f.a.isPositive() ? s.plus(f.a) : s), new R(0));
  if (outflow.lessThanOrEqualTo(inflow)) return new D(0); // no cost of credit (or negative): report 0

  const npv = (r: InstanceType<typeof R>) => {
    const ln = r.plus(1).ln();
    let v = new R(0);
    let dv = new R(0);
    for (const f of fs) {
      const disc = ln.times(f.t).negated().exp(); // (1+r)^-t
      v = v.plus(f.a.times(disc));
      dv = dv.minus(f.a.times(f.t).times(disc).dividedBy(r.plus(1)));
    }
    return { v, dv };
  };

  const tol = new R('1e-12');
  let r = new R('0.2');
  for (let i = 0; opts.solver !== 'bisection' && i < 50; i++) {
    const { v, dv } = npv(r);
    if (v.abs().lessThan(tol)) return new D(r.toString());
    if (dv.isZero()) break;
    const next = r.minus(v.dividedBy(dv));
    if (next.lessThanOrEqualTo(-0.99) || !next.isFinite()) break;
    if (next.minus(r).abs().lessThan('1e-14')) return new D(next.toString());
    r = next;
  }

  // Bisection: for a loan (money received first, repaid later) NPV rises with r, because
  // higher rates discount the repayments more. Positive NPV means r is too high.
  let lo = new R('-0.99');
  let hi = new R('1000');
  for (let i = 0; i < 200; i++) {
    const mid = lo.plus(hi).dividedBy(2);
    if (npv(mid).v.isPositive()) hi = mid;
    else lo = mid;
    if (hi.minus(lo).lessThan('1e-12')) break;
  }
  return new D(lo.plus(hi).dividedBy(2).toString());
}
