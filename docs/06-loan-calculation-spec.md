# 06 — Loan Calculation Specification

## 1. Principles

1. **Pure engine.** `packages/loan-engine` exposes
   `generateSchedule(input: LoanTerms, method: MethodKey, engineVersion) → Schedule`.
   No DB, no clock, no globals. The server and the UI preview call the same code.
2. **No floats.** All arithmetic in `Decimal` with 28 significant digits; values are
   rounded **only** at defined points (§6).
3. **Pluggable methods.** Methods are registered strategies implementing
   `InterestMethod { key; periodInterest(ctx): Decimal; buildSchedule(input): Row[] }`.
   New methods (e.g. step-up EMI, balloon, seasonal) are added by registering a
   strategy + product config — no change to loan, payment or ledger code.
4. **Reproducibility.** Every loan stores `calc_snapshot` = full input + method key +
   `engineVersion`. Re-running the snapshot must reproduce the stored schedule
   to the paisa (verified by a nightly job on a sample and by tests).
5. **Formulas are data-driven by product**, never hard-coded per loan category.

## 2. Inputs

| Field | Type | Notes |
|---|---|---|
| assetValue | Money | informational; LTV check |
| downPayment | Money | informational; `principal = financed amount` |
| principal | Money > 0 | amount financed |
| annualRate | Decimal (% p.a.) | within product bounds |
| method | `FLAT` \| `REDUCING_EMI` \| `SIMPLE` \| future | |
| frequency | `DAILY` \| `WEEKLY` \| `FORTNIGHTLY` \| `MONTHLY` \| `CUSTOM(nDays)` | |
| numInstallments | int ≥ 1 | |
| disbursementDate | date | |
| firstDueDate | date | ≥ disbursementDate |
| dayCount | `ACT_365` (default) \| `30_360` | |
| fees[] | code, amount, collectionMode, gstRate | |
| rounding | `{ unit: 0.01 \| 1 \| 10, mode: HALF_UP, adjust: LAST }` | |
| holidayRule | `NONE` (default) \| `NEXT_WORKING_DAY` | uses branch holiday calendar |

## 3. Periods per year & due dates

| Frequency | Periods/yr (m) | Due date n |
|---|---|---|
| DAILY | 365 | firstDue + (n−1) days (option: skip Sundays → collection-day calendar) |
| WEEKLY | 52 | firstDue + 7(n−1) days |
| FORTNIGHTLY | 26 | firstDue + 14(n−1) days |
| MONTHLY | 12 | firstDue + (n−1) months; day clamped to month end (31 Jan → 28/29 Feb → 31 Mar keeps anchor day 31) |
| CUSTOM(d) | 365/d | firstDue + d(n−1) days |

Tenure in years `T = numInstallments / m` (for FLAT total-interest calculation).

## 4. Methods

### 4.1 FLAT

Interest is charged on the original principal for the whole tenure.

```
totalInterest   = round2( P × (R/100) × T )
installment     = roundU( (P + totalInterest) / N )           // U = rounding unit
principal_k     = roundU( P / N )           for k < N;  P − Σ others     for k = N
interest_k      = installment − principal_k  for k < N; totalInterest − Σ others for k = N
last installment= (P + totalInterest) − installment × (N − 1)
```

Interest split per installment is equal (straight-line). ⚖ Some lenders use the
Rule of 78 split; available as option `flatSplit: RULE_OF_78` but **not default**.

**Example A — ₹1,00,000, 24% flat p.a., 12 monthly, round to ₹1**

- Total interest = 1,00,000 × 0.24 × 1 = **₹24,000**; total payable ₹1,24,000
- Installment = 1,24,000 / 12 = 10,333.33 → **₹10,333** × 11, last **₹10,337**
- Principal part 8,333 × 11 + 8,337; interest part 2,000 × 12

**Example B — same, 52 weekly**: total ₹1,24,000; ₹2,385 × 51 + last ₹2,365.

**Example C — ₹1,00,000, 24% flat, 100 daily installments**: T = 100/365;
interest = round2(100000 × 0.24 × 100/365) = ₹6,575.34; total ₹1,06,575.34;
₹1,066 × 99 + last ₹1,041.34.

### 4.2 REDUCING_EMI

Equal installments; interest on declining balance.

```
i        = (R/100) / m                                  // periodic rate
EMI      = roundU( P × i × (1+i)^N / ((1+i)^N − 1) )    // i = 0 → P/N
for k in 1..N:
  interest_k  = round2( balance_{k−1} × i )
  principal_k = EMI − interest_k            (k < N)
  principal_N = balance_{N−1}               (last clears exactly)
  installment_N = principal_N + interest_N
  balance_k   = balance_{k−1} − principal_k
```

Option `periodRate: ACTUAL_DAYS` computes `interest_k = balance × R × days_k / 365`
for irregular first periods (broken-period interest); default is the
periodic-rate formula above, with **broken-period interest** for a first period
longer than one frequency charged as a separate first-installment component.

**Example D — ₹1,00,000, 24% p.a. reducing, 12 monthly, round to ₹1**

i = 0.02, (1.02)^12 = 1.268241795, EMI = 9,455.96 → **₹9,456**

| # | Opening | Interest | Principal | Installment | Closing |
|---|---|---|---|---|---|
| 1 | 1,00,000.00 | 2,000.00 | 7,456.00 | 9,456 | 92,544.00 |
| 2 | 92,544.00 | 1,850.88 | 7,605.12 | 9,456 | 84,938.88 |
| 3 | 84,938.88 | 1,698.78 | 7,757.22 | 9,456 | 77,181.66 |
| … | | | | | |
| 12 | | | clears balance | adjusted | 0.00 |

Total interest ≈ ₹13,471 (exact figure is a golden test fixture). Compare
Example A: the same "24%" costs ₹24,000 flat — the UI **always shows both the
nominal rate and the APR** so this is never ambiguous to customers or staff.

### 4.3 SIMPLE (equal principal, interest on outstanding for actual days)

```
principal_k = roundU(P / N) (last absorbs remainder)
interest_k  = round2( balance_{k−1} × (R/100) × days(due_{k−1}, due_k) / 365 )
installment_k = principal_k + interest_k       (declining installments)
```
`due_0` = disbursement date. Suited to daily/weekly collection products where
staff prefer "principal + that period's interest".

## 5. Fees, GST, down payment

- Fees are **not** interest and are never inside the interest formula.
- `collectionMode`:
  - `UPFRONT` — collected at disbursal as a separate receipt.
  - `DEDUCT_FROM_DISBURSAL` — net cash paid = principal − fees (customer still owes full principal).
  - `ADD_TO_FIRST_INSTALLMENT` — appears as `fees_due` on installment 1.
- GST on fees (if applicable ⚖): `gst = round2(fee × gstRate)`; posted to GST
  Output liability, shown separately on receipt.
- Down payment is recorded as information (paid to dealer) unless the business
  collects it, in which case it's a separate receipt that does not touch the loan receivable.

## 6. Rounding rules

| Quantity | Rounding |
|---|---|
| Periodic interest (reducing, simple) | 2 dp, HALF_UP, per row |
| Total interest (flat) | 2 dp, HALF_UP |
| Installment amount | product `rounding.unit` (default ₹1), HALF_UP |
| Last installment | exact residual (can include paise) so Σ = total payable exactly |
| Penalties | 2 dp, HALF_UP, then optional product unit |
| Display | Indian grouping: `₹1,24,000.00` |

Invariant tests: `Σ principal_k = P`, `Σ interest_k = totalInterest`,
`closing_N = 0`, every component ≥ 0.

## 7. APR (for Key Facts Statement ⚖)

APR is the annualised internal rate of return of the customer's actual cash flows:

```
cashflows: t0 = +(principal − fees deducted/collected upfront)  (customer receives)
           t_k = −installment_k (+ fees added to installments)
solve periodic IRR r by Newton–Raphson (fallback bisection), tolerance 1e-10
APR = r × m   (nominal, as commonly disclosed)    — also store effective (1+r)^m − 1
```
Computed with `Decimal`, stored to 4 dp on the loan. Exact disclosure basis
(nominal vs effective, which charges included) must be confirmed ⚖.

## 8. Penalties (penal charges)

Configured per product (`penalty_rule`), assessed nightly by `penalty.assess`:

| Type | Formula |
|---|---|
| `FLAT_PER_INSTALLMENT` | once per installment when DPD > grace: `value` |
| `PCT_OF_OVERDUE_PER_DAY` | daily: `round2(overdue_amount × value/100)` |
| `PCT_PA_ON_OVERDUE` | daily: `round2(overdue_principal+interest × value/100 / 365)` |

Optional `cap` (absolute or % of installment). Penal charges are a separate
component (`penalty_due`), **never added to principal and never compounded** ⚖.
Each assessment is a row in `loan_charges` + a journal entry (doc 07), so
waivers are auditable.

## 9. Installment status machine

```
UPCOMING ──(due_date = today)──▶ DUE_TODAY ──(end of day, balance>0)──▶ OVERDUE
    │                               │                                      │
    └───── partial payment ─────────┴──▶ PARTIALLY_PAID ◀──────────────────┘
                     full payment (balance = 0) ──▶ PAID
                     approved waiver of balance    ──▶ WAIVED
                     reschedule approved           ──▶ RESCHEDULED (superseded)
```
`PARTIALLY_PAID` + past due date is displayed as "Overdue (partial)"; DPD counts
from the oldest unpaid due date. Loan DPD = max DPD of open installments.

## 10. Prepayment, foreclosure, reschedule

- **Foreclosure quote** = principal outstanding + interest due to date (per
  product rule: `ACCRUED_TO_DATE` for reducing, `REMAINING_FLAT_WITH_REBATE` or
  `ALL_REMAINING` for flat ⚖) + penalties + foreclosure charge − advance balance.
  Quote is valid for the day and stored.
- **Part-prepayment** (reducing only): reduce tenure (default) or reduce EMI;
  generates a new `loan_schedule_version`.
- **Reschedule/restructure**: requires approval; old open installments →
  `RESCHEDULED`; new version created; ledger unaffected unless capitalisation is
  explicitly chosen and approved ⚖.

## 11. Preview contract (UI ⇄ API)

`POST /loans/calculate` returns exactly what will be persisted:
`{ totals: {principal, interest, fees, gst, totalPayable, apr, installment},
  rows: [{no, dueDate, opening, principal, interest, fees, total, closing}],
  engineVersion, warnings: [ltvExceeded, rateOutOfBounds, …] }`.
On `POST /loans` the server recomputes and rejects if the client's
`previewHash` differs (prevents stale previews being confirmed).
