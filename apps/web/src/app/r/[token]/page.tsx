'use client';

import { CheckCircle2, ShieldAlert, XCircle } from 'lucide-react';
import { use, useEffect, useState } from 'react';
import { Spinner } from '@/components/ui';
import { dateTime, inr } from '@/lib/format';

interface Verified {
  receiptNo: string;
  issuedAt: string;
  status: 'ISSUED' | 'CANCELLED';
  cancelledAt: string | null;
  company: string;
  branch: string;
  amount: string;
  method: string;
  customer: string;
  loanNo: string;
}

const METHOD: Record<string, string> = { CASH: 'Cash', UPI: 'UPI', BANK_TRANSFER: 'Bank transfer', CHEQUE: 'Cheque' };

/** Opened from the QR code on a receipt. Public, shows only what proves the receipt is genuine. */
export default function VerifyReceipt({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const [r, setR] = useState<Verified | null>(null);
  const [state, setState] = useState<'loading' | 'ok' | 'missing' | 'error'>('loading');

  useEffect(() => {
    fetch(`/api/v1/public/receipts/${encodeURIComponent(token)}`, { cache: 'no-store' })
      .then(async (res) => {
        if (res.status === 404) return setState('missing');
        if (!res.ok) return setState('error');
        setR(await res.json());
        setState('ok');
      })
      .catch(() => setState('error'));
  }, [token]);

  return (
    <main className="grid min-h-screen place-items-center bg-canvas px-4 py-10">
      <div className="w-full max-w-sm rounded-xl border border-line bg-surface p-6 shadow-sm">
        <p className="mb-4 text-[12px] font-semibold uppercase tracking-wider text-subtle">Receipt verification</p>
        {state === 'loading' && <Spinner label="Checking" />}
        {state === 'missing' && (
          <div className="text-center">
            <ShieldAlert className="mx-auto size-10 text-bad" />
            <p className="mt-3 font-semibold text-ink-950">Receipt not found</p>
            <p className="mt-1 text-[13px] text-muted">This link does not match any receipt we issued. If you were given this receipt, contact the branch.</p>
          </div>
        )}
        {state === 'error' && <p className="text-[13px] text-bad">Could not check right now. Please try again.</p>}
        {state === 'ok' && r && (
          <>
            <div className="text-center">
              {r.status === 'ISSUED' ? <CheckCircle2 className="mx-auto size-10 text-ok" /> : <XCircle className="mx-auto size-10 text-bad" />}
              <p className={`mt-3 text-lg font-semibold ${r.status === 'ISSUED' ? 'text-ok' : 'text-bad'}`}>{r.status === 'ISSUED' ? 'Genuine receipt' : 'Receipt cancelled'}</p>
              {r.status === 'CANCELLED' && <p className="mt-1 text-[13px] text-muted">This payment was reversed on {dateTime(r.cancelledAt)}. The receipt is no longer valid.</p>}
              <p className="num mt-4 text-3xl font-semibold text-ink-950">{inr(r.amount)}</p>
            </div>
            <dl className="mt-5 space-y-2 border-t border-line pt-4 text-[13px]">
              {[
                ['Receipt no.', r.receiptNo],
                ['Issued', dateTime(r.issuedAt)],
                ['Paid by', METHOD[r.method] ?? r.method],
                ['Customer', r.customer],
                ['Loan', r.loanNo],
                ['Issued by', `${r.company}, ${r.branch}`],
              ].map(([k, v]) => (
                <div key={k} className="flex justify-between gap-4">
                  <dt className="text-muted">{k}</dt>
                  <dd className="num text-right font-medium">{v}</dd>
                </div>
              ))}
            </dl>
          </>
        )}
      </div>
    </main>
  );
}
