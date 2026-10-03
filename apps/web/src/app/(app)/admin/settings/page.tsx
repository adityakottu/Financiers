'use client';

import { useEffect, useState } from 'react';
import { useToast } from '@/components/toast';
import { Alert, Button, Card, CardHeader, EmptyState, Field, Input, PageHeader, Spinner, Table, Td, Textarea, Th } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { useApi } from '@/lib/hooks';
import { date, dateTime, inr } from '@/lib/format';
import { useSession } from '@/lib/session';

interface Company {
  legalName: string;
  tradeName: string | null;
  address: string | null;
  phone: string | null;
  email: string | null;
  gstin: string | null;
  receiptFooter: string | null;
  timezone: string;
  currency: string;
  fyStartMonth: number;
}
interface Numbering {
  seqType: string;
  format: string;
  perBranch: boolean;
  nextExample: string;
}

export default function SettingsPage() {
  const { can } = useSession();
  if (!can('settings.company')) return <EmptyState title="You don’t have access to settings" />;
  return (
    <>
      <PageHeader title="Settings" subtitle="Company details and document numbering" />
      <div className="space-y-6">
        <CompanyCard />
        {can('settings.numbering') && <NumberingCard />}
        {can('jobs.run') && <EndOfDayCard />}
      </div>
    </>
  );
}

function CompanyCard() {
  const toast = useToast();
  const { data, loading } = useApi<Company>('/settings/company');
  const [v, setV] = useState<Record<string, string>>({});
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (data)
      setV({
        legalName: data.legalName,
        tradeName: data.tradeName ?? '',
        address: data.address ?? '',
        phone: data.phone ?? '',
        email: data.email ?? '',
        gstin: data.gstin ?? '',
        receiptFooter: data.receiptFooter ?? '',
      });
  }, [data]);
  const fe = error?.fieldErrors() ?? {};

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('PUT', '/settings/company', { body: v });
      toast('ok', 'Company details saved');
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setBusy(false);
    }
  }

  if (loading || !data) return <Spinner />;
  const f = (k: string) => ({ value: v[k] ?? '', onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setV({ ...v, [k]: e.target.value }) });

  return (
    <Card>
      <CardHeader title="Company" description="Printed on receipts, statements and letters." />
      <form onSubmit={save} className="grid gap-4 p-5 sm:grid-cols-2">
        {error && !error.details && (
          <div className="sm:col-span-2">
            <Alert>{error.message}</Alert>
          </div>
        )}
        <Field label="Legal name" required error={fe.legalName}>
          <Input {...f('legalName')} />
        </Field>
        <Field label="Trade name" error={fe.tradeName}>
          <Input {...f('tradeName')} />
        </Field>
        <Field label="Phone" error={fe.phone}>
          <Input {...f('phone')} />
        </Field>
        <Field label="Email" error={fe.email}>
          <Input type="email" {...f('email')} />
        </Field>
        <Field label="GSTIN" hint="If registered ⚖ — confirm GST treatment of fees with your CA" error={fe.gstin}>
          <Input {...f('gstin')} className="num font-mono uppercase" maxLength={15} />
        </Field>
        <div className="grid grid-cols-3 gap-3 text-[13px]">
          <div>
            <p className="text-[12px] uppercase tracking-wide text-subtle">Currency</p>
            <p className="mt-2">{data.currency}</p>
          </div>
          <div>
            <p className="text-[12px] uppercase tracking-wide text-subtle">Timezone</p>
            <p className="mt-2">IST</p>
          </div>
          <div>
            <p className="text-[12px] uppercase tracking-wide text-subtle">Financial year</p>
            <p className="mt-2">Apr – Mar</p>
          </div>
        </div>
        <Field label="Address" className="sm:col-span-2" error={fe.address}>
          <Textarea rows={2} {...f('address')} />
        </Field>
        <Field label="Receipt footer" className="sm:col-span-2" error={fe.receiptFooter}>
          <Textarea rows={2} {...f('receiptFooter')} />
        </Field>
        <div className="flex justify-end sm:col-span-2">
          <Button type="submit" loading={busy}>
            Save
          </Button>
        </div>
      </form>
    </Card>
  );
}

function NumberingCard() {
  const toast = useToast();
  const { data, loading, reload } = useApi<{ data: Numbering[] }>('/settings/numbering');
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  async function save(seqType: string) {
    setError(null);
    try {
      await api('PUT', '/settings/numbering', { body: { seqType, format: edits[seqType] } });
      toast('ok', `${seqType} numbering updated`);
      setEdits((e) => {
        const { [seqType]: _, ...rest } = e;
        return rest;
      });
      reload();
    } catch (e) {
      setError((e as ApiError).message);
    }
  }

  return (
    <Card>
      <CardHeader
        title="Document numbering"
        description="Tokens: {FY} financial-year start (2026), {FYS} 2026-27, {YYYY} calendar year, {BR} branch code, {SEQ:6} counter padded to 6 digits. Numbers never repeat and never skip."
      />
      {error && (
        <div className="px-5 pt-4">
          <Alert>{error}</Alert>
        </div>
      )}
      {loading || !data ? (
        <Spinner />
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Document</Th>
              <Th>Format</Th>
              <Th>Next number</Th>
              <Th />
            </tr>
          </thead>
          <tbody>
            {data.data.map((n) => (
              <tr key={n.seqType}>
                <Td className="font-medium">{n.seqType.charAt(0) + n.seqType.slice(1).toLowerCase()}</Td>
                <Td>
                  <Input value={edits[n.seqType] ?? n.format} onChange={(e) => setEdits({ ...edits, [n.seqType]: e.target.value })} className="num h-8 max-w-xs font-mono text-[13px]" aria-label={`${n.seqType} format`} />
                </Td>
                <Td className="num font-mono text-[13px] text-muted">{n.nextExample}</Td>
                <Td className="text-right">
                  {edits[n.seqType] !== undefined && edits[n.seqType] !== n.format && (
                    <Button size="sm" onClick={() => save(n.seqType)}>
                      Save
                    </Button>
                  )}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </Card>
  );
}

interface JobRun {
  business_date: string;
  status: string;
  finished_at: string | null;
  details: { statusesUpdated: number; interestAccrued: number; accrualEntries: number; penaltiesAssessed: number; penaltyAmount: string } | null;
}

function EndOfDayCard() {
  const toast = useToast();
  const { data, loading, reload } = useApi<{ data: JobRun[] }>('/jobs/daily');
  const [busy, setBusy] = useState(false);
  async function run() {
    setBusy(true);
    try {
      const r = await api<{ skipped?: boolean; date: string }>('POST', '/jobs/daily', { body: {} });
      toast('ok', r.skipped ? `End-of-day for ${r.date} had already run` : `End-of-day completed for ${r.date}`);
      reload();
    } catch (e) {
      toast('bad', (e as ApiError).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card>
      <CardHeader
        title="End-of-day processing"
        description="Runs automatically after midnight (IST): updates installment status, accrues interest falling due, assesses penal charges and refreshes loan balances. Safe to repeat — a finished day is skipped."
        actions={
          <Button size="sm" variant="secondary" onClick={run} loading={busy}>
            Run for today
          </Button>
        }
      />
      {loading || !data ? (
        <Spinner />
      ) : data.data.length === 0 ? (
        <p className="p-5 text-[13px] text-muted">No runs yet.</p>
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Business date</Th>
              <Th className="text-right">Installments updated</Th>
              <Th className="text-right">Interest accrued</Th>
              <Th className="text-right">Penal charges</Th>
              <Th>Finished</Th>
            </tr>
          </thead>
          <tbody>
            {data.data.map((r) => (
              <tr key={r.business_date}>
                <Td className="num">{date(r.business_date)}</Td>
                <Td className="num text-right">{r.details?.statusesUpdated ?? '—'}</Td>
                <Td className="num text-right">{r.details ? `${r.details.interestAccrued} installments` : '—'}</Td>
                <Td className="num text-right">{r.details ? `${r.details.penaltiesAssessed} · ${inr(r.details.penaltyAmount)}` : '—'}</Td>
                <Td className="text-[12px] text-muted">{r.finished_at ? dateTime(r.finished_at) : r.status}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </Card>
  );
}
