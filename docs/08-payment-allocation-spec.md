# 08 — Payment Allocation Specification

## 1. Purpose

Decide, deterministically and auditably, which dues a payment settles. The
payment is **never** simply subtracted from a total balance.

## 2. Allocation rule (configurable, versioned)

Stored in `allocation_rules` and referenced by the loan product:

```jsonc
{
  "id": "AR-STD-v3",
  "mode": "INSTALLMENT_WISE",          // or COMPONENT_WISE
  "order": ["PENALTY", "FEE", "INTEREST", "PRINCIPAL"],
  "installmentOrder": "OLDEST_DUE_FIRST",
  "includeNotYetDue": false,           // false → excess goes to ADVANCE
  "excessHandling": "ADVANCE",         // ADVANCE | PREPAY_PRINCIPAL | REJECT
  "minPartialAmount": "1.00",
  "applyAdvanceOnDueDate": true
}
```

Changing a rule creates a new version; existing loans keep their version unless
Management explicitly migrates them (audited). Every allocation stores a
`rule_snapshot`, so any historical allocation can be explained later.

### Modes

**INSTALLMENT_WISE (default, D2)** — settle the oldest open installment completely
(in `order` of components), then the next.

**COMPONENT_WISE** — across *all* overdue installments, settle every PENALTY first
(oldest first), then every FEE, then INTEREST, then PRINCIPAL. Some lenders prefer
this to maximise income recovery; it leaves older installments showing unpaid
principal longer, which affects DPD. ⚖ Confirm which your policy/regulator expects.

## 3. Algorithm (pure function)

```
allocate(openItems, amount, rule, asOfDate) → { lines[], excess }

eligible = openItems where
            installment.status ∈ {DUE_TODAY, OVERDUE, PARTIALLY_PAID}
            or (rule.includeNotYetDue and status = UPCOMING)
          plus loan-level charges (e.g. bounce charges) as FEE items dated on assessment

sort:
  INSTALLMENT_WISE: by (due_date, installment_no), then component index in rule.order
  COMPONENT_WISE:   by (component index in rule.order, due_date, installment_no)

remaining = amount
for item in sorted:
   take = min(remaining, item.outstanding)
   if take > 0: lines.push({installmentId, component, amount: take, seq})
   remaining -= take
   if remaining = 0: break

if remaining > 0:
   ADVANCE          → lines.push({component: ADVANCE, amount: remaining})
   PREPAY_PRINCIPAL → allocate to future principal (reducing: new schedule version)
   REJECT           → error OVERPAYMENT_NOT_ALLOWED
```

Invariants (property-tested):
- Σ lines.amount = payment amount.
- No line exceeds its item outstanding; no negative line.
- Result is independent of input order (sort is total).
- Re-running on same inputs yields byte-identical output.

## 4. Worked examples

Loan with installments (INSTALLMENT_WISE, order P→F→I→Pr):

| # | Due | Penalty | Fee | Interest | Principal | Status |
|---|---|---|---|---|---|---|
| 6 | 05/09 | 50 | 0 | 300 | 900 | OVERDUE |
| 7 | 05/10 | 0 | 0 | 300 | 900 | DUE_TODAY |
| 8 | 05/11 | 0 | 0 | 300 | 900 | UPCOMING |

**a) Exact installment: ₹1,250** → #6 penalty 50, interest 300, principal 900. #6 PAID.

**b) Partial: ₹500** → #6 penalty 50, interest 300, principal 150. #6 PARTIALLY_PAID
(balance 750, still overdue, DPD unchanged).

**c) Multiple installments: ₹2,450** → #6 1,250 (PAID), #7 interest 300 + principal 900 (PAID). Total 2,450.

**d) Overpayment: ₹3,000** → #6 1,250, #7 1,200, **₹550 → Customer Advance**.
On 05/11, `applyAdvanceOnDueDate` applies 550 to #8 (interest 300, principal 250)
via an internal allocation (payment_id = advance application record), journal
`Dr 2200 / Cr 1320 300 / Cr 1310 250`.

**e) COMPONENT_WISE ₹500** → #6 penalty 50, then interest #6 300, interest #7 150.

## 5. Late payment & penalties

Penalties are assessed nightly (doc 06 §8) and appear as `penalty_due` on the
installment before the payment is allocated. A payment recorded at 11:00 on a
day when a penalty is scheduled to be assessed at 00:15 already sees it. A
payment received *within* the grace period never incurs the penalty, because
assessment checks `DPD > grace_days` at run time and skips paid installments.
Backdated payments (value date < today, allowed only within an open business
day and with permission `payment.backdate`) trigger re-evaluation of penalties
assessed after the value date: such penalties are reversed automatically (E12-style
with reason `BACKDATED_PAYMENT`) before allocation.

## 6. Reversal

1. Load payment's allocations (immutable).
2. For each line, decrement the corresponding `*_paid` on its installment;
   recompute status (PAID → PARTIALLY_PAID/OVERDUE/DUE_TODAY as dates dictate).
3. ADVANCE lines: reverse advance; if the advance was already applied, the
   application is reversed first (cascade, same transaction).
4. Post REVERSAL journal (exact mirror).
5. Receipt → CANCELLED (number kept, PDF watermarked "CANCELLED").
6. Loan denormalised balances recomputed; if loan was CLOSED by this payment it
   returns to ACTIVE and the closure record is voided (audited).
7. Employee settlement for that date: if still open, figures update; if closed,
   the reversal is counted on today's settlement as a negative line with
   reference to the original date.

Payments are never edited. "Wrong amount" = reverse + re-record.

## 7. Allocation display

- Collector UI: "₹1,250 received — Installment 6 cleared. Next due ₹1,200 on 05/10."
- Receipt: component table (Penalty / Fees / Interest / Principal / Advance).
- Accountant UI: allocation lines + journal lines side by side.
