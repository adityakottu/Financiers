import { Lock } from 'lucide-react';

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid min-h-screen lg:grid-cols-[1fr_1.1fr]">
      <section className="relative hidden flex-col justify-between overflow-hidden bg-ink-950 p-12 text-white lg:flex">
        <div className="flex items-center gap-2.5">
          <span className="grid size-9 place-items-center rounded-md bg-accent text-sm font-bold">F</span>
          <span className="text-lg font-semibold tracking-tight">Financiers</span>
        </div>
        <div className="max-w-md">
          <p className="text-[28px] font-semibold leading-tight tracking-tight">Every rupee, traceable from customer to ledger.</p>
          <p className="mt-4 text-[15px] leading-relaxed text-white/60">
            Loans, collections, receipts, daily reconciliation and double-entry accounts — in one system your field staff and accountants can both trust.
          </p>
        </div>
        <p className="flex items-center gap-2 text-[12px] text-white/40">
          <Lock className="size-3.5" /> Access is monitored and every action is recorded in the audit log.
        </p>
        <div aria-hidden className="pointer-events-none absolute -right-24 top-1/3 size-96 rounded-full border border-white/5" />
        <div aria-hidden className="pointer-events-none absolute -right-8 top-1/2 size-64 rounded-full border border-white/5" />
      </section>
      <section className="flex items-center justify-center px-5 py-12">
        <div className="w-full max-w-sm">{children}</div>
      </section>
    </div>
  );
}
