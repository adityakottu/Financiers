'use client';

import { Download, Eye, FileText, Landmark, Pencil, ShieldCheck, Upload } from 'lucide-react';
import Link from 'next/link';
import { use, useRef, useState } from 'react';
import { useStepUp } from '@/components/step-up';
import { useToast } from '@/components/toast';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardHeader,
  Detail,
  Dialog,
  EmptyState,
  Field,
  Input,
  PageHeader,
  Select,
  Spinner,
  StatusBadge,
  Tabs,
} from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { date, dateTime, inr, titleCase } from '@/lib/format';
import { useApi } from '@/lib/hooks';
import { useSession } from '@/lib/session';

interface KycDoc {
  docType: string;
  masked: string;
  verified: boolean;
  verifiedAt: string | null;
  verificationMethod: string | null;
  revealable: boolean;
}
interface CustomerDetail {
  id: string;
  customerNo: string;
  branchCode: string;
  fullName: string;
  relationType: string | null;
  relationName: string | null;
  dob: string | null;
  gender: string | null;
  mobile: string;
  altMobile: string | null;
  email: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  villageTown: string | null;
  mandal: string | null;
  district: string | null;
  state: string | null;
  pincode: string | null;
  occupation: string | null;
  employerBusinessName: string | null;
  businessType: string | null;
  monthlyIncome: string | null;
  workAddress: string | null;
  kycStatus: string;
  riskCategory: string;
  whatsappOptIn: boolean;
  status: string;
  version: number;
  createdAt: string;
  kyc: KycDoc[] | null;
  references: { id: string; name: string; relationship: string; mobile: string }[];
  documents: { id: string; category: string; notes: string | null; created_at: string; original_name: string; mime_type: string; size_bytes: number; scan_status: string }[];
}
interface Event {
  id: string;
  at: string;
  event_type: string;
  summary: string;
  actor: string | null;
}

const KYC_LABEL: Record<string, string> = { PAN: 'PAN', AADHAAR: 'Aadhaar', DRIVING_LICENCE: 'Driving licence', VOTER_ID: 'Voter ID' };

type Tab = 'overview' | 'kyc' | 'documents' | 'loans' | 'timeline';

export default function CustomerPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { can } = useSession();
  const { data: c, error, loading, reload } = useApi<CustomerDetail>(`/customers/${id}`);
  const [tab, setTab] = useState<Tab>('overview');

  if (loading && !c) return <Spinner />;
  if (error || !c) return <EmptyState title="Customer not found" body="It may not exist, or it belongs to a branch you can’t access." />;

  const address = [c.addressLine1, c.addressLine2, c.villageTown, c.mandal && `${c.mandal} Mandal`, c.district, c.state, c.pincode].filter(Boolean).join(', ');

  return (
    <>
      <PageHeader
        breadcrumb={
          <Link href="/customers" className="hover:underline">
            Customers
          </Link>
        }
        title={
          <span className="flex flex-wrap items-center gap-3">
            {c.fullName}
            <StatusBadge status={c.status} />
          </span>
        }
        subtitle={
          <span className="num font-mono text-[13px]">
            {c.customerNo} · {c.branchCode} · customer since {date(c.createdAt)}
          </span>
        }
        actions={
          can('customer.edit') && (
            <Link href={`/customers/${c.id}/edit`}>
              <Button variant="secondary">
                <Pencil className="size-4" /> Edit
              </Button>
            </Link>
          )
        }
      />

      <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">
        {[
          ['KYC', <StatusBadge key="k" status={c.kycStatus} />],
          ['Mobile', <span key="m" className="num">{c.mobile}</span>],
          ['WhatsApp', c.whatsappOptIn ? <Badge key="w" tone="ok">Consented</Badge> : <Badge key="w">No consent</Badge>],
          ['Active loan', <span key="l" className="text-subtle">— (Phase 3)</span>],
        ].map(([label, value]) => (
          <Card key={label as string} className="px-4 py-3">
            <p className="text-[12px] font-medium uppercase tracking-wide text-subtle">{label}</p>
            <div className="mt-1 text-sm">{value}</div>
          </Card>
        ))}
      </div>

      <Tabs<Tab>
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'overview', label: 'Overview' },
          ...(c.kyc ? [{ id: 'kyc' as Tab, label: 'KYC', count: c.kyc.length }] : []),
          { id: 'documents', label: 'Documents', count: c.documents.length },
          { id: 'loans', label: 'Loans' },
          { id: 'timeline', label: 'History' },
        ]}
      />
      <div className="mt-5">
        {tab === 'overview' && (
          <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
            <Card>
              <CardHeader title="Personal" />
              <dl className="grid grid-cols-2 gap-x-6 gap-y-4 p-5">
                <Detail label="Relation" value={c.relationType ? `${c.relationType} ${c.relationName ?? ''}` : '—'} />
                <Detail label="Date of birth" value={date(c.dob)} />
                <Detail label="Gender" value={titleCase(c.gender)} />
                <Detail label="Alternate mobile" value={c.altMobile} mono />
                <Detail label="Email" value={c.email} />
                <Detail label="Risk category" value={titleCase(c.riskCategory)} />
                <div className="col-span-2">
                  <Detail label="Address" value={address || '—'} />
                </div>
              </dl>
            </Card>
            <Card>
              <CardHeader title="Work & income" />
              <dl className="grid grid-cols-2 gap-x-6 gap-y-4 p-5">
                <Detail label="Occupation" value={c.occupation} />
                <Detail label="Monthly income" value={inr(c.monthlyIncome, { decimals: false })} mono />
                <Detail label="Employer / business" value={c.employerBusinessName} />
                <Detail label="Business type" value={c.businessType} />
                <div className="col-span-2">
                  <Detail label="Work address" value={c.workAddress} />
                </div>
              </dl>
            </Card>
            <Card className="lg:col-span-2">
              <CardHeader title="References" />
              {c.references.length === 0 ? (
                <p className="p-5 text-[13px] text-muted">No references recorded.</p>
              ) : (
                <ul className="divide-y divide-line">
                  {c.references.map((r) => (
                    <li key={r.id} className="flex items-center justify-between px-5 py-3 text-sm">
                      <span>
                        <span className="font-medium text-ink-950">{r.name}</span> <span className="text-muted">· {r.relationship}</span>
                      </span>
                      <span className="num text-muted">{r.mobile}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>
        )}
        {tab === 'kyc' && c.kyc && <KycPanel customer={c} onChange={reload} />}
        {tab === 'documents' && <DocumentsPanel customer={c} onChange={reload} />}
        {tab === 'loans' && (
          <Card>
            <EmptyState icon={<Landmark className="size-8" />} title="Loans arrive in Phase 3" body="Loan creation, schedules, statements and the loan summary on this page are built next." />
          </Card>
        )}
        {tab === 'timeline' && <Timeline id={c.id} />}
      </div>
    </>
  );
}

function KycPanel({ customer, onChange }: { customer: CustomerDetail; onChange: () => void }) {
  const { can } = useSession();
  const withStepUp = useStepUp();
  const toast = useToast();
  const [revealed, setRevealed] = useState<Record<string, string>>({});
  const [editOpen, setEditOpen] = useState(false);
  const [verifyDoc, setVerifyDoc] = useState<string | null>(null);
  const [method, setMethod] = useState('Original document seen');

  async function reveal(docType: string) {
    try {
      const r = await withStepUp(() => api<{ value: string }>('POST', `/customers/${customer.id}/kyc/${docType}/reveal`));
      setRevealed((s) => ({ ...s, [docType]: r.value }));
      setTimeout(() => setRevealed((s) => ({ ...s, [docType]: '' })), 30_000);
    } catch (e) {
      if ((e as ApiError).code !== 'REAUTH_CANCELLED') toast('bad', (e as ApiError).message);
    }
  }

  async function verify() {
    try {
      await api('POST', `/customers/${customer.id}/kyc/verify`, { body: { docType: verifyDoc, method } });
      toast('ok', `${KYC_LABEL[verifyDoc!]} marked verified`);
      setVerifyDoc(null);
      onChange();
    } catch (e) {
      toast('bad', (e as ApiError).message);
    }
  }

  return (
    <Card>
      <CardHeader
        title="Identity documents"
        description="Numbers are encrypted at rest. Revealing a full number requires your password and is recorded in the audit log."
        actions={
          can('customer.edit') && (
            <Button size="sm" variant="secondary" onClick={() => setEditOpen(true)}>
              <Pencil className="size-3.5" /> Update KYC
            </Button>
          )
        }
      />
      {customer.kyc!.length === 0 ? (
        <EmptyState icon={<ShieldCheck className="size-8" />} title="No KYC details recorded" />
      ) : (
        <ul className="divide-y divide-line">
          {customer.kyc!.map((k) => (
            <li key={k.docType} className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
              <div>
                <p className="text-[13px] font-medium text-muted">{KYC_LABEL[k.docType]}</p>
                <p className="num mt-0.5 font-mono text-[15px] text-ink-950">{revealed[k.docType] || k.masked}</p>
              </div>
              <div className="flex items-center gap-2">
                {k.verified ? (
                  <Badge tone="ok" className="py-1">
                    <ShieldCheck className="size-3.5" /> Verified {date(k.verifiedAt)}
                  </Badge>
                ) : (
                  <Badge tone="warn">Not verified</Badge>
                )}
                {!k.verified && can('customer.edit') && (
                  <Button size="sm" variant="secondary" onClick={() => setVerifyDoc(k.docType)}>
                    Mark verified
                  </Button>
                )}
                {k.revealable && !revealed[k.docType] && (
                  <Button size="sm" variant="ghost" onClick={() => reveal(k.docType)}>
                    <Eye className="size-3.5" /> Reveal
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      <Dialog
        open={!!verifyDoc}
        onClose={() => setVerifyDoc(null)}
        title={`Verify ${verifyDoc ? KYC_LABEL[verifyDoc] : ''}`}
        footer={
          <>
            <Button variant="secondary" onClick={() => setVerifyDoc(null)}>
              Cancel
            </Button>
            <Button onClick={verify}>Confirm verification</Button>
          </>
        }
      >
        <Field label="How was it verified?">
          <Select value={method} onChange={(e) => setMethod(e.target.value)}>
            <option>Original document seen</option>
            <option>Self-attested copy</option>
            <option>DigiLocker</option>
            <option>Online verification</option>
          </Select>
        </Field>
      </Dialog>
      <KycEditDialog customerId={customer.id} open={editOpen} onClose={() => setEditOpen(false)} onSaved={onChange} />
    </Card>
  );
}

function KycEditDialog({ customerId, open, onClose, onSaved }: { customerId: string; open: boolean; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [v, setV] = useState({ pan: '', aadhaarLast4: '', drivingLicence: '', voterId: '' });
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const fe = error?.fieldErrors() ?? {};

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const body = Object.fromEntries(Object.entries(v).filter(([, x]) => x.trim()));
      const r = await api<{ changed: string[] }>('PUT', `/customers/${customerId}/kyc`, { body });
      toast('ok', r.changed.length ? `Updated: ${r.changed.map((d) => KYC_LABEL[d]).join(', ')}` : 'No changes');
      setV({ pan: '', aadhaarLast4: '', drivingLicence: '', voterId: '' });
      onClose();
      onSaved();
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Update KYC"
      description="Enter only what’s new. Changing a number clears its previous verification."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} loading={busy}>
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {error && !error.details && <Alert>{error.message}</Alert>}
        <Field label="PAN" error={fe.pan}>
          <Input value={v.pan} onChange={(e) => setV({ ...v, pan: e.target.value.toUpperCase() })} maxLength={10} className="uppercase" />
        </Field>
        <Field label="Aadhaar — last 4 digits" error={fe.aadhaarLast4}>
          <Input value={v.aadhaarLast4} onChange={(e) => setV({ ...v, aadhaarLast4: e.target.value.replace(/\D/g, '').slice(0, 4) })} inputMode="numeric" />
        </Field>
        <Field label="Driving licence" error={fe.drivingLicence}>
          <Input value={v.drivingLicence} onChange={(e) => setV({ ...v, drivingLicence: e.target.value.toUpperCase() })} />
        </Field>
        <Field label="Voter ID" error={fe.voterId}>
          <Input value={v.voterId} onChange={(e) => setV({ ...v, voterId: e.target.value.toUpperCase() })} />
        </Field>
      </div>
    </Dialog>
  );
}

function DocumentsPanel({ customer, onChange }: { customer: CustomerDetail; onChange: () => void }) {
  const { can } = useSession();
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [category, setCategory] = useState('ADDRESS_PROOF');
  const [busy, setBusy] = useState(false);

  async function upload(file: File) {
    if (file.size > 10 * 1024 * 1024) return toast('bad', 'Files must be 10 MB or smaller');
    const fd = new FormData();
    fd.set('category', category);
    fd.set('file', file);
    setBusy(true);
    try {
      await api('POST', `/customers/${customer.id}/documents`, { body: fd });
      toast('ok', 'Document uploaded');
      onChange();
    } catch (e) {
      toast('bad', (e as ApiError).message);
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  return (
    <Card>
      <CardHeader
        title="Documents"
        description="PDF, JPEG or PNG up to 10 MB. Files are checked by content, not name."
        actions={
          can('document.upload') && (
            <div className="flex items-center gap-2">
              <Select value={category} onChange={(e) => setCategory(e.target.value)} className="h-8 w-40 text-[13px]" aria-label="Document type">
                <option value="ADDRESS_PROOF">Address proof</option>
                <option value="PHOTO">Photo</option>
                <option value="AGREEMENT">Agreement</option>
                {can('document.view_kyc') && <option value="KYC">KYC copy</option>}
                <option value="OTHER">Other</option>
              </Select>
              <input ref={fileRef} type="file" accept="application/pdf,image/jpeg,image/png" capture="environment" hidden onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
              <Button size="sm" onClick={() => fileRef.current?.click()} loading={busy}>
                <Upload className="size-3.5" /> Upload
              </Button>
            </div>
          )
        }
      />
      {customer.documents.length === 0 ? (
        <EmptyState icon={<FileText className="size-8" />} title="No documents yet" />
      ) : (
        <ul className="divide-y divide-line">
          {customer.documents.map((d) => (
            <li key={d.id} className="flex items-center justify-between gap-3 px-5 py-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-ink-950">{d.original_name}</p>
                <p className="text-[12px] text-muted">
                  {titleCase(d.category)} · {(d.size_bytes / 1024).toFixed(0)} KB · {dateTime(d.created_at)}
                </p>
              </div>
              {d.scan_status === 'CLEAN' ? (
                <a href={`/api/v1/customers/${customer.id}/documents/${d.id}/download`} target="_blank" rel="noopener noreferrer">
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
  );
}

function Timeline({ id }: { id: string }) {
  const { data, loading } = useApi<{ data: Event[] }>(`/customers/${id}/timeline`);
  if (loading || !data) return <Spinner />;
  return (
    <Card className="p-5">
      <ol className="relative space-y-5 border-l border-line pl-6">
        {data.data.map((e) => (
          <li key={e.id} className="relative">
            <span className="absolute -left-[29px] top-1.5 size-2.5 rounded-full border-2 border-surface bg-accent ring-1 ring-accent/30" />
            <p className="text-sm text-ink-950">{e.summary}</p>
            <p className="mt-0.5 text-[12px] text-muted">
              {dateTime(e.at)}
              {e.actor && ` · ${e.actor}`}
            </p>
          </li>
        ))}
      </ol>
      <p className="mt-6 text-[12px] text-subtle">Loan, payment, receipt, SMS/WhatsApp and visit events join this history as those modules arrive.</p>
    </Card>
  );
}
