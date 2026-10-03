'use client';

import { CATEGORY_LABELS, LoanCategory } from '@fin/contracts';
import { Download, Upload } from 'lucide-react';
import Link from 'next/link';
import { use, useRef, useState } from 'react';
import { useToast } from '@/components/toast';
import { Button, Card, CardHeader, Detail, EmptyState, Field, Input, PageHeader, Select, Spinner, StatusBadge } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { date, dateTime, inr, titleCase } from '@/lib/format';
import { useApi } from '@/lib/hooks';
import { useSession } from '@/lib/session';

interface Asset {
  id: string;
  asset_no: string;
  loan_id: string;
  category: string;
  status: string;
  version: number;
  description: string | null;
  make: string | null;
  model: string | null;
  variant: string | null;
  manufacture_year: number | null;
  colour: string | null;
  serial_no: string | null;
  registration_no: string | null;
  chassis_no: string | null;
  engine_no: string | null;
  vehicle_type: string | null;
  asset_value: string | null;
  dealer_name: string | null;
  invoice_no: string | null;
  hypothecation_marked: boolean;
  insurer: string | null;
  insurance_policy_no: string | null;
  insurance_expiry: string | null;
  permit_no: string | null;
  permit_expiry: string | null;
  fitness_expiry: string | null;
  documents: { id: string; doc_type: string; expiry_date: string | null; created_at: string; original_name: string; size_bytes: number; scan_status: string }[];
  events: { id: string; at: string; from_status: string | null; to_status: string; reason: string | null }[];
}

export default function AssetPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { can } = useSession();
  const toast = useToast();
  const { data: a, loading, reload } = useApi<Asset>(`/assets/${id}`);
  const fileRef = useRef<HTMLInputElement>(null);
  const [docType, setDocType] = useState('RC');
  const [expiry, setExpiry] = useState('');
  const [busy, setBusy] = useState(false);
  const [ins, setIns] = useState<{ insurer: string; policy: string; expiry: string } | null>(null);

  if (loading && !a) return <Spinner />;
  if (!a) return <EmptyState title="Asset not found" />;

  async function upload(file: File) {
    const fd = new FormData();
    fd.set('docType', docType);
    if (expiry) fd.set('expiryDate', expiry);
    fd.set('file', file);
    setBusy(true);
    try {
      await api('POST', `/assets/${id}/documents`, { body: fd });
      toast('ok', 'Document uploaded');
      reload();
    } catch (e) {
      toast('bad', (e as ApiError).message);
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  async function saveInsurance() {
    try {
      await api('PATCH', `/assets/${id}`, { body: { insurer: ins!.insurer || undefined, insurancePolicyNo: ins!.policy || undefined, insuranceExpiry: ins!.expiry || undefined }, ifMatch: a!.version });
      toast('ok', 'Insurance updated');
      setIns(null);
      reload();
    } catch (e) {
      toast('bad', (e as ApiError).message);
    }
  }

  const vehicle = !!a.chassis_no;
  return (
    <>
      <PageHeader
        breadcrumb={
          <Link href="/assets" className="hover:underline">
            Assets
          </Link>
        }
        title={
          <span className="flex items-center gap-3">
            {[a.make, a.model].filter(Boolean).join(' ') || a.description} <StatusBadge status={a.status} />
          </span>
        }
        subtitle={
          <>
            {a.asset_no} · {CATEGORY_LABELS[a.category as LoanCategory]} ·{' '}
            <Link href={`/loans/${a.loan_id}`} className="text-ink-700 hover:underline">
              View loan
            </Link>
          </>
        }
      />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader title="Details" />
          <dl className="grid grid-cols-2 gap-x-6 gap-y-4 p-5">
            {(
              [
                ['Registration', a.registration_no, true],
                ['Chassis', a.chassis_no, true],
                ['Engine', a.engine_no, true],
                ['Serial', a.serial_no, true],
                ['Variant', a.variant],
                ['Year', a.manufacture_year ? String(a.manufacture_year) : null],
                ['Colour', a.colour],
                ['Vehicle type', a.vehicle_type],
                ['Value', a.asset_value ? inr(a.asset_value) : null],
                ['Dealer', a.dealer_name],
                ['Invoice', a.invoice_no],
                ['Hypothecation', vehicle ? (a.hypothecation_marked ? 'Marked on RC' : 'Not marked') : null],
                ['Permit', a.permit_no ? `${a.permit_no} till ${date(a.permit_expiry)}` : null],
                ['Fitness until', a.fitness_expiry ? date(a.fitness_expiry) : null],
              ] as [string, string | null, boolean?][]
            )
              .filter(([, v]) => v)
              .map(([k, v, mono]) => (
                <Detail key={k} label={k} value={v} mono={mono} />
              ))}
          </dl>
        </Card>
        <Card>
          <CardHeader
            title="Insurance"
            actions={
              can('asset.edit') &&
              !ins && (
                <Button size="sm" variant="secondary" onClick={() => setIns({ insurer: a.insurer ?? '', policy: a.insurance_policy_no ?? '', expiry: a.insurance_expiry ?? '' })}>
                  Update
                </Button>
              )
            }
          />
          {ins ? (
            <div className="grid gap-3 p-5 sm:grid-cols-3">
              <Field label="Insurer">
                <Input value={ins.insurer} onChange={(e) => setIns({ ...ins, insurer: e.target.value })} />
              </Field>
              <Field label="Policy no.">
                <Input value={ins.policy} onChange={(e) => setIns({ ...ins, policy: e.target.value })} />
              </Field>
              <Field label="Expiry">
                <Input type="date" value={ins.expiry} onChange={(e) => setIns({ ...ins, expiry: e.target.value })} />
              </Field>
              <div className="flex gap-2 sm:col-span-3">
                <Button size="sm" onClick={saveInsurance}>
                  Save
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setIns(null)}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <dl className="grid grid-cols-2 gap-x-6 gap-y-4 p-5">
              <Detail label="Insurer" value={a.insurer} />
              <Detail label="Policy" value={a.insurance_policy_no} mono />
              <Detail label="Expiry" value={date(a.insurance_expiry)} />
            </dl>
          )}
        </Card>
        <Card className="lg:col-span-2">
          <CardHeader
            title="Documents"
            description="RC, insurance, invoice, permits and photos"
            actions={
              can('asset.edit') && (
                <div className="flex flex-wrap items-center gap-2">
                  <Select value={docType} onChange={(e) => setDocType(e.target.value)} className="h-8 w-36 text-[13px]" aria-label="Document type">
                    {['RC', 'INSURANCE', 'INVOICE', 'PERMIT', 'FITNESS', 'NOC', 'PHOTO', 'OTHER'].map((d) => (
                      <option key={d} value={d}>
                        {d === 'RC' || d === 'NOC' ? d : titleCase(d)}
                      </option>
                    ))}
                  </Select>
                  <Input type="date" value={expiry} onChange={(e) => setExpiry(e.target.value)} className="h-8 w-40 text-[13px]" aria-label="Expiry date (optional)" />
                  <input ref={fileRef} type="file" hidden accept="application/pdf,image/jpeg,image/png" onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
                  <Button size="sm" onClick={() => fileRef.current?.click()} loading={busy}>
                    <Upload className="size-3.5" /> Upload
                  </Button>
                </div>
              )
            }
          />
          {a.documents.length === 0 ? (
            <EmptyState title="No documents yet" />
          ) : (
            <ul className="divide-y divide-line">
              {a.documents.map((d) => (
                <li key={d.id} className="flex items-center justify-between gap-3 px-5 py-3">
                  <div>
                    <p className="text-sm font-medium text-ink-950">{d.original_name}</p>
                    <p className="text-[12px] text-muted">
                      {d.doc_type} · {(d.size_bytes / 1024).toFixed(0)} KB{d.expiry_date ? ` · valid till ${date(d.expiry_date)}` : ''}
                    </p>
                  </div>
                  {d.scan_status === 'CLEAN' ? (
                    <a href={`/api/v1/assets/${id}/documents/${d.id}/download`} target="_blank" rel="noopener noreferrer">
                      <Button size="sm" variant="ghost">
                        <Download className="size-3.5" /> Open
                      </Button>
                    </a>
                  ) : (
                    <StatusBadge status={d.scan_status} />
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card className="lg:col-span-2">
          <CardHeader title="Status history" />
          <ul className="divide-y divide-line">
            {a.events.map((e) => (
              <li key={e.id} className="flex items-center justify-between px-5 py-2.5 text-sm">
                <span>
                  {e.from_status ? `${titleCase(e.from_status)} → ` : ''}
                  <span className="font-medium">{titleCase(e.to_status)}</span> <span className="text-muted">· {e.reason}</span>
                </span>
                <span className="text-[12px] text-muted">{dateTime(e.at)}</span>
              </li>
            ))}
          </ul>
          <p className="border-t border-line px-5 py-2 text-[12px] text-subtle">Repossession, release and sale workflows arrive with the recovery module.</p>
        </Card>
      </div>
    </>
  );
}
