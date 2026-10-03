'use client';

import { Landmark, Plus } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { todayIST } from '@/components/lending';
import { useStepUp } from '@/components/step-up';
import { useToast } from '@/components/toast';
import { Alert, Badge, Button, Card, CardHeader, Dialog, EmptyState, Field, Input, PageHeader, Select, Spinner, Table, Tabs, Td, Textarea, Th } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { date, dateTime, inr, titleCase } from '@/lib/format';
import { useApi, useSubmit } from '@/lib/hooks';
import { useSession } from '@/lib/session';

interface Account { id: string; code: string; name: string; subtype: string; branch_code: string | null; employee_id: string | null; balance: string; bank_name: string | null; account_no_last4: string | null }
interface Deposit { id: string; deposit_no: string; amount: string; deposited_on: string; slip_no: string | null; notes: string | null; status: string; recorded_at: string; from_code: string; from_name: string; to_code: string; to_name: string; recorded_by_name: string; branch_code: string; reverse_reason: string | null; canReverse: boolean }
interface Cheque { id: string; payment_no: string; amount: string; reference_no: string; cheque_bank: string; cheque_date: string; cheque_status: string; status: string; received_at: string; cheque_deposited_on: string | null; cheque_cleared_on: string | null; cheque_bounced_on: string | null; deposit_account: string | null; loan_id: string; loan_no: string; customer_name: string; branch_code: string }

const GROUP: Record<string, string> = { BANK: 'Bank accounts', CASH: 'Branch cash', EMPLOYEE_CASH: 'Cash with collectors', UPI_CLEARING: 'UPI received (awaiting bank match)', CHEQUES_IN_HAND: 'Cheques in hand' };
type Tab = 'balances' | 'deposits' | 'cheques';

export default function BankingPage() {
  const { can } = useSession();
  const [tab, setTab] = useState<Tab>('balances');
  const accounts = useApi<{ data: Account[] }>('/banking/accounts');
  if (!can('deposit.record') && !can('ledger.view') && !can('cheque.manage')) return <EmptyState title="You don’t have access to cash & bank" />;
  return (
    <>
      <PageHeader title="Cash & bank" subtitle="Where the money is: branch cash, collectors’ cash, UPI and cheques awaiting the bank, and bank balances" />
      <Tabs<Tab>
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'balances', label: 'Balances' },
          ...(can('deposit.record') || can('ledger.view') ? [{ id: 'deposits' as Tab, label: 'Deposits & hand-overs' }] : []),
          ...(can('cheque.manage') ? [{ id: 'cheques' as Tab, label: 'Cheques' }] : []),
        ]}
      />
      <div className="mt-5">
        {tab === 'balances' && <Balances accounts={accounts.data?.data ?? null} />}
        {tab === 'deposits' && <Deposits accounts={accounts.data?.data ?? []} onChanged={accounts.reload} />}
        {tab === 'cheques' && <Cheques accounts={accounts.data?.data ?? []} onChanged={accounts.reload} />}
      </div>
    </>
  );
}

function Balances({ accounts }: { accounts: Account[] | null }) {
  if (!accounts) return <Spinner />;
  return (
    <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
      {Object.entries(GROUP).map(([subtype, label]) => {
        const rows = accounts.filter((a) => a.subtype === subtype);
        if (!rows.length) return null;
        const total = rows.reduce((s, r) => s + Number(r.balance), 0);
        return (
          <Card key={subtype}>
            <CardHeader title={label} actions={<span className="num text-sm font-semibold">{inr(total.toFixed(2))}</span>} />
            <ul className="divide-y divide-line">
              {rows.map((a) => (
                <li key={a.id} className="flex items-center justify-between gap-3 px-5 py-2.5 text-[13px]">
                  <span className="min-w-0">
                    <span className="num font-mono text-[12px] text-muted">{a.code}</span> {a.name}
                    {a.account_no_last4 && <span className="text-muted"> (…{a.account_no_last4})</span>}
                  </span>
                  <span className={`num shrink-0 font-medium ${Number(a.balance) < 0 ? 'text-bad' : ''}`}>{inr(a.balance)}</span>
                </li>
              ))}
            </ul>
          </Card>
        );
      })}
      <p className="text-[12px] text-subtle xl:col-span-2">Balances come straight from the accounting entries. UPI and bank amounts are matched to bank statements in daily reconciliation (Phase 6).</p>
    </div>
  );
}

function Deposits({ accounts, onChanged }: { accounts: Account[]; onChanged: () => void }) {
  const { can } = useSession();
  const toast = useToast();
  const { data, reload } = useApi<{ data: Deposit[] }>('/banking/deposits');
  const [record, setRecord] = useState(false);
  const [reverse, setReverse] = useState<Deposit | null>(null);
  return (
    <Card>
      <CardHeader
        title="Deposits & hand-overs"
        description="Collectors’ cash paid into the bank or handed to the branch. You can’t deposit more than an account holds."
        actions={
          can('deposit.record') && (
            <Button size="sm" onClick={() => setRecord(true)}>
              <Plus className="size-3.5" /> Record deposit
            </Button>
          )
        }
      />
      {!data ? (
        <Spinner />
      ) : data.data.length === 0 ? (
        <EmptyState icon={<Landmark className="size-8" />} title="No deposits yet" />
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Date</Th>
              <Th>Deposit</Th>
              <Th>From</Th>
              <Th>To</Th>
              <Th className="text-right">Amount</Th>
              <Th>Recorded by</Th>
              <Th />
            </tr>
          </thead>
          <tbody>
            {data.data.map((d) => (
              <tr key={d.id} className={d.status === 'REVERSED' ? 'text-subtle' : ''}>
                <Td className="num whitespace-nowrap">{date(d.deposited_on)}</Td>
                <Td>
                  <span className="num font-mono text-[12px]">{d.deposit_no}</span>
                  {d.slip_no && <p className="text-[12px] text-muted">Slip {d.slip_no}</p>}
                  {d.status === 'REVERSED' && <Badge tone="bad">Reversed</Badge>}
                </Td>
                <Td className="text-[13px]">{d.from_name}</Td>
                <Td className="text-[13px]">{d.to_name}</Td>
                <Td className={`num text-right font-medium ${d.status === 'REVERSED' ? 'line-through' : ''}`}>{inr(d.amount)}</Td>
                <Td className="text-[12px] text-muted">
                  {d.recorded_by_name} · {dateTime(d.recorded_at)}
                </Td>
                <Td className="text-right">
                  {d.canReverse && (
                    <Button size="sm" variant="ghost" onClick={() => setReverse(d)}>
                      Reverse
                    </Button>
                  )}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      {record && (
        <DepositDialog
          accounts={accounts}
          onClose={() => setRecord(false)}
          onDone={() => {
            setRecord(false);
            reload();
            onChanged();
          }}
        />
      )}
      {reverse && (
        <ReasonDialog
          title={`Reverse ${reverse.deposit_no}`}
          description={`${inr(reverse.amount)} goes back to ${reverse.from_name}. Someone other than the person who recorded it must do this.`}
          action="Reverse deposit"
          onClose={() => setReverse(null)}
          onSubmit={async (reason) => {
            await api('POST', `/banking/deposits/${reverse.id}/reverse`, { body: { reason } });
            toast('ok', 'Deposit reversed');
            setReverse(null);
            reload();
            onChanged();
          }}
        />
      )}
    </Card>
  );
}

function DepositDialog({ accounts, onClose, onDone }: { accounts: Account[]; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const sources = accounts.filter((a) => (a.subtype === 'EMPLOYEE_CASH' || a.subtype === 'CASH') && Number(a.balance) > 0);
  const [from, setFrom] = useState(sources[0]?.id ?? '');
  const src = accounts.find((a) => a.id === from);
  const targets = accounts.filter((a) => a.subtype === 'BANK' || (a.subtype === 'CASH' && a.id !== from && a.branch_code === src?.branch_code));
  const [to, setTo] = useState(targets.find((t) => t.subtype === 'BANK')?.id ?? targets[0]?.id ?? '');
  const [amount, setAmount] = useState(src ? src.balance : '');
  const [on, setOn] = useState(todayIST());
  const [slip, setSlip] = useState('');
  const [error, setError] = useState<ApiError | null>(null);
  const [go, busy] = useSubmit(async () => {
    setError(null);
    try {
      const r = await api<{ depositNo: string }>('POST', '/banking/deposits', { body: { fromAccountId: from, toAccountId: to, amount, depositedOn: on, slipNo: slip || undefined } });
      toast('ok', `Deposit ${r.depositNo} recorded`);
      onDone();
    } catch (e) {
      setError(e as ApiError);
    }
  });
  const fe = error?.fieldErrors() ?? {};
  return (
    <Dialog
      open
      onClose={onClose}
      title="Record deposit"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => go()} loading={busy} disabled={!from || !to}>
            Record
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {error && !Object.keys(fe).length && <Alert>{error.message}</Alert>}
        {sources.length === 0 ? (
          <Alert tone="info">No cash account holds money right now.</Alert>
        ) : (
          <>
            <Field label="From" required>
              <Select
                value={from}
                onChange={(e) => {
                  setFrom(e.target.value);
                  setAmount(accounts.find((a) => a.id === e.target.value)?.balance ?? '');
                }}
              >
                {sources.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name} — holds {inr(a.balance)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="To" required error={fe.toAccountId}>
              <Select value={to} onChange={(e) => setTo(e.target.value)}>
                {targets.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                    {a.account_no_last4 ? ` (…${a.account_no_last4})` : ''}
                  </option>
                ))}
              </Select>
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Amount (₹)" required error={fe.amount}>
                <Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} className="num" />
              </Field>
              <Field label="Date" required error={fe.depositedOn}>
                <Input type="date" max={todayIST()} value={on} onChange={(e) => setOn(e.target.value)} />
              </Field>
            </div>
            <Field label="Bank slip / reference" hint="Optional">
              <Input value={slip} onChange={(e) => setSlip(e.target.value)} />
            </Field>
          </>
        )}
      </div>
    </Dialog>
  );
}

function Cheques({ accounts, onChanged }: { accounts: Account[]; onChanged: () => void }) {
  const toast = useToast();
  const withStepUp = useStepUp();
  const [status, setStatus] = useState('RECEIVED');
  const { data, reload } = useApi<{ data: Cheque[] }>(`/banking/cheques${status ? `?status=${status}` : ''}`);
  const [act, setAct] = useState<{ c: Cheque; kind: 'deposit' | 'clear' | 'bounce' } | null>(null);
  const banks = accounts.filter((a) => a.subtype === 'BANK');
  const done = () => {
    setAct(null);
    reload();
    onChanged();
  };
  return (
    <Card>
      <CardHeader
        title="Cheques"
        description="Received → deposited → cleared. A bounced cheque reverses the payment and cancels its receipt."
        actions={
          <Select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status" className="h-8 w-auto text-[13px]">
            <option value="RECEIVED">In hand</option>
            <option value="DEPOSITED">Deposited</option>
            <option value="CLEARED">Cleared</option>
            <option value="BOUNCED">Bounced</option>
            <option value="">All</option>
          </Select>
        }
      />
      {!data ? (
        <Spinner />
      ) : data.data.length === 0 ? (
        <EmptyState title="No cheques" />
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Cheque</Th>
              <Th>Customer · loan</Th>
              <Th className="text-right">Amount</Th>
              <Th>Status</Th>
              <Th />
            </tr>
          </thead>
          <tbody>
            {data.data.map((c) => (
              <tr key={c.id}>
                <Td>
                  <span className="num font-mono">{c.reference_no}</span>
                  <p className="text-[12px] text-muted">
                    {c.cheque_bank} · dated {date(c.cheque_date)}
                  </p>
                </Td>
                <Td>
                  <Link href={`/payments/${c.id}`} className="font-medium hover:underline">
                    {c.customer_name}
                  </Link>
                  <p className="num text-[12px] text-muted">
                    {c.loan_no} · {c.payment_no}
                  </p>
                </Td>
                <Td className="num text-right font-medium">{inr(c.amount)}</Td>
                <Td className="text-[12px]">
                  <Badge tone={c.cheque_status === 'CLEARED' ? 'ok' : c.cheque_status === 'BOUNCED' ? 'bad' : c.cheque_status === 'DEPOSITED' ? 'info' : 'warn'}>{titleCase(c.cheque_status)}</Badge>
                  <p className="mt-0.5 text-muted">
                    {c.cheque_bounced_on ? `bounced ${date(c.cheque_bounced_on)}` : c.cheque_cleared_on ? `cleared ${date(c.cheque_cleared_on)}` : c.cheque_deposited_on ? `in ${c.deposit_account} ${date(c.cheque_deposited_on)}` : `received ${date(c.received_at)}`}
                  </p>
                </Td>
                <Td className="whitespace-nowrap text-right">
                  {c.cheque_status === 'RECEIVED' && c.status === 'POSTED' && (
                    <Button size="sm" variant="secondary" onClick={() => setAct({ c, kind: 'deposit' })}>
                      Deposit
                    </Button>
                  )}
                  {c.cheque_status === 'DEPOSITED' && (
                    <Button size="sm" variant="secondary" onClick={() => setAct({ c, kind: 'clear' })}>
                      Cleared
                    </Button>
                  )}
                  {['RECEIVED', 'DEPOSITED'].includes(c.cheque_status) && c.status === 'POSTED' && (
                    <Button size="sm" variant="ghost" className="text-bad" onClick={() => setAct({ c, kind: 'bounce' })}>
                      Bounced
                    </Button>
                  )}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      {act && <ChequeDialog {...act} banks={banks} onClose={() => setAct(null)} onDone={done} withStepUp={withStepUp} toast={toast} />}
    </Card>
  );
}

function ChequeDialog({ c, kind, banks, onClose, onDone, withStepUp, toast }: { c: Cheque; kind: 'deposit' | 'clear' | 'bounce'; banks: Account[]; onClose: () => void; onDone: () => void; withStepUp: ReturnType<typeof useStepUp>; toast: ReturnType<typeof useToast> }) {
  const [accountId, setAccountId] = useState(banks[0]?.id ?? '');
  const [on, setOn] = useState(todayIST());
  const [reason, setReason] = useState('');
  const [charge, setCharge] = useState('');
  const [error, setError] = useState<ApiError | null>(null);
  const [go, busy] = useSubmit(async () => {
    setError(null);
    try {
      const body = kind === 'deposit' ? { accountId, depositedOn: on } : kind === 'clear' ? { clearedOn: on } : { bouncedOn: on, reason, charge: charge || undefined };
      const call = () => api('POST', `/banking/cheques/${c.id}/${kind}`, { body });
      await (kind === 'bounce' ? withStepUp(call) : call());
      toast('ok', kind === 'deposit' ? 'Cheque deposited' : kind === 'clear' ? 'Cheque cleared' : 'Cheque bounced — payment reversed and receipt cancelled');
      onDone();
    } catch (e) {
      if ((e as ApiError).code !== 'REAUTH_CANCELLED') setError(e as ApiError);
    }
  });
  const fe = error?.fieldErrors() ?? {};
  return (
    <Dialog
      open
      onClose={onClose}
      title={`${kind === 'deposit' ? 'Deposit' : kind === 'clear' ? 'Mark cleared' : 'Record bounce'} · cheque ${c.reference_no}`}
      description={`${inr(c.amount)} from ${c.customer_name}`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Back
          </Button>
          <Button variant={kind === 'bounce' ? 'danger' : 'primary'} onClick={() => go()} loading={busy}>
            {kind === 'deposit' ? 'Record deposit' : kind === 'clear' ? 'Mark cleared' : 'Record bounce'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {error && !Object.keys(fe).length && <Alert>{error.message}</Alert>}
        {kind === 'deposit' && (
          <Field label="Into" required>
            <Select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
              {banks.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <Field label="Date" required>
          <Input type="date" max={todayIST()} value={on} onChange={(e) => setOn(e.target.value)} />
        </Field>
        {kind === 'bounce' && (
          <>
            <Alert tone="warn">The payment will be reversed: installments go back to unpaid and the receipt is cancelled. The customer is informed by SMS.</Alert>
            <Field label="Bank’s reason" required error={fe.reason}>
              <Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
            </Field>
            <Field label="Bounce charge (₹)" hint="Optional, per your loan agreement ⚖ — added to the next installment" error={fe.charge}>
              <Input inputMode="decimal" value={charge} onChange={(e) => setCharge(e.target.value)} className="num" />
            </Field>
          </>
        )}
      </div>
    </Dialog>
  );
}

function ReasonDialog({ title, description, action, onClose, onSubmit }: { title: string; description: string; action: string; onClose: () => void; onSubmit: (reason: string) => Promise<void> }) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState<ApiError | null>(null);
  const [go, busy] = useSubmit(async () => {
    setError(null);
    try {
      await onSubmit(reason);
    } catch (e) {
      setError(e as ApiError);
    }
  });
  return (
    <Dialog
      open
      onClose={onClose}
      title={title}
      description={description}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Back
          </Button>
          <Button variant="danger" onClick={() => go()} loading={busy}>
            {action}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {error && <Alert>{error.fieldErrors().reason ?? error.message}</Alert>}
        <Field label="Reason" required>
          <Textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
      </div>
    </Dialog>
  );
}
