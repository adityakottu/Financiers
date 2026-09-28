'use client';

import { cloneElement, forwardRef, isValidElement, useEffect, useId, useRef } from 'react';
import { Loader2, X } from 'lucide-react';

export function cx(...parts: (string | false | null | undefined)[]) {
  return parts.filter(Boolean).join(' ');
}

/* ------------------------------ Button ------------------------------ */

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
const VARIANTS: Record<Variant, string> = {
  primary: 'bg-ink-900 text-white hover:bg-ink-800 disabled:bg-ink-600/60',
  secondary: 'bg-surface text-text border border-line-strong hover:bg-canvas disabled:text-subtle',
  ghost: 'text-ink-700 hover:bg-ink-900/5 disabled:text-subtle',
  danger: 'bg-bad text-white hover:bg-bad/90 disabled:bg-bad/50',
};

export const Button = forwardRef<
  HTMLButtonElement,
  React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md'; loading?: boolean }
>(function Button({ variant = 'primary', size = 'md', loading, className, children, disabled, ...rest }, ref) {
  return (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={cx(
        'inline-flex items-center justify-center gap-2 rounded-md font-medium transition-colors disabled:cursor-not-allowed',
        size === 'sm' ? 'h-8 px-3 text-[13px]' : 'h-10 px-4 text-sm',
        VARIANTS[variant],
        className,
      )}
      {...rest}
    >
      {loading && <Loader2 className="size-4 animate-spin" aria-hidden />}
      {children}
    </button>
  );
});

/* ------------------------------ Form fields ------------------------------ */

export function Field({
  label,
  error,
  hint,
  required,
  children,
  className,
}: {
  label: string;
  error?: string;
  hint?: string;
  required?: boolean;
  children: React.ReactNode;
  className?: string;
}) {
  // The label names the control; hint/error describe it (aria-describedby), so screen readers
  // announce "Mobile" rather than "Mobile Enter a valid 10-digit…".
  const autoId = useId();
  // Only form controls are labelable; a wrapper like <div> keeps its children as they are.
  const child =
    isValidElement<{ id?: string; 'aria-describedby'?: string; 'aria-invalid'?: unknown }>(children) &&
    (typeof children.type !== 'string' || ['input', 'select', 'textarea'].includes(children.type))
      ? children
      : null;
  const id = child?.props.id ?? autoId;
  const noteId = `${id}-note`;
  const note = error ?? hint;
  return (
    <div className={cx('block', className)}>
      <label htmlFor={child ? id : undefined} className="mb-1 block text-[13px] font-medium text-ink-800">
        {label}
        {required && (
          <span className="ml-0.5 text-bad" aria-hidden>
            *
          </span>
        )}
      </label>
      {child
        ? cloneElement(child, {
            id,
            'aria-describedby': note ? noteId : undefined,
            ...(error ? { 'aria-invalid': true } : {}),
          })
        : children}
      {note && (
        <span id={noteId} role={error ? 'alert' : undefined} className={cx('mt-1 block text-[12px]', error ? 'text-bad' : 'text-subtle')}>
          {note}
        </span>
      )}
    </div>
  );
}

const inputBase =
  'block w-full rounded-md border border-line-strong bg-surface px-3 text-sm text-text placeholder:text-subtle focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20 disabled:bg-canvas disabled:text-muted aria-[invalid=true]:border-bad';

export const Input = forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(function Input(
  { className, ...rest },
  ref,
) {
  return <input ref={ref} className={cx(inputBase, 'h-10', className)} {...rest} />;
});

export const Select = forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement>>(function Select(
  { className, children, ...rest },
  ref,
) {
  return (
    <select ref={ref} className={cx(inputBase, 'h-10 pr-8', className)} {...rest}>
      {children}
    </select>
  );
});

export const Textarea = forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function Textarea({ className, ...rest }, ref) {
    return <textarea ref={ref} className={cx(inputBase, 'min-h-20 py-2', className)} {...rest} />;
  },
);

export function Checkbox({ label, ...rest }: React.InputHTMLAttributes<HTMLInputElement> & { label: React.ReactNode }) {
  return (
    <label className="inline-flex cursor-pointer items-center gap-2 text-sm text-ink-800">
      <input type="checkbox" className="size-4 rounded border-line-strong accent-accent" {...rest} />
      {label}
    </label>
  );
}

/* ------------------------------ Layout ------------------------------ */

export function Card({ className, children, ...rest }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cx('rounded-[var(--radius-card)] border border-line bg-surface', className)} {...rest}>
      {children}
    </div>
  );
}

export function CardHeader({ title, description, actions }: { title: React.ReactNode; description?: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
      <div>
        <h2 className="text-[15px] font-semibold text-ink-900">{title}</h2>
        {description && <p className="mt-0.5 text-[13px] text-muted">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}

export function PageHeader({
  title,
  subtitle,
  actions,
  breadcrumb,
}: {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  actions?: React.ReactNode;
  breadcrumb?: React.ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        {breadcrumb && <div className="mb-1 text-[13px] text-muted">{breadcrumb}</div>}
        <h1 className="truncate text-[22px] font-semibold tracking-tight text-ink-950">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-muted">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

/* ------------------------------ Status ------------------------------ */

type Tone = 'neutral' | 'ok' | 'warn' | 'bad' | 'info' | 'accent';
const TONES: Record<Tone, string> = {
  neutral: 'bg-canvas text-muted ring-line-strong',
  ok: 'bg-ok-soft text-ok ring-ok/20',
  warn: 'bg-warn-soft text-warn ring-warn/25',
  bad: 'bg-bad-soft text-bad ring-bad/20',
  info: 'bg-info-soft text-info ring-info/20',
  accent: 'bg-accent-soft text-accent-strong ring-accent/20',
};

export function Badge({ tone = 'neutral', children, className }: { tone?: Tone; children: React.ReactNode; className?: string }) {
  return (
    <span className={cx('inline-flex items-center gap-1 whitespace-nowrap rounded px-1.5 py-0.5 text-[12px] font-medium ring-1 ring-inset', TONES[tone], className)}>
      {children}
    </span>
  );
}

export const STATUS_TONE: Record<string, Tone> = {
  ACTIVE: 'ok',
  VERIFIED: 'ok',
  CLEAN: 'ok',
  PARTIAL: 'warn',
  PENDING: 'warn',
  INACTIVE: 'neutral',
  DISABLED: 'neutral',
  BLACKLISTED: 'bad',
  REJECTED: 'bad',
  INFECTED: 'bad',
  LOCKED: 'bad',
};

export function StatusBadge({ status }: { status: string }) {
  const label = status.charAt(0) + status.slice(1).toLowerCase().replace(/_/g, ' ');
  return <Badge tone={STATUS_TONE[status] ?? 'neutral'}>{label}</Badge>;
}

export function Spinner({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-12 text-sm text-muted" role="status">
      <Loader2 className="size-4 animate-spin" aria-hidden /> {label}…
    </div>
  );
}

export function EmptyState({ icon, title, body, action }: { icon?: React.ReactNode; title: string; body?: string; action?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-14 text-center">
      {icon && <div className="mb-3 text-subtle">{icon}</div>}
      <p className="text-sm font-medium text-ink-900">{title}</p>
      {body && <p className="mt-1 max-w-sm text-[13px] text-muted">{body}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function Alert({ tone = 'bad', children }: { tone?: 'bad' | 'warn' | 'info' | 'ok'; children: React.ReactNode }) {
  const t = { bad: 'border-bad/25 bg-bad-soft text-bad', warn: 'border-warn/25 bg-warn-soft text-warn', info: 'border-info/20 bg-info-soft text-info', ok: 'border-ok/20 bg-ok-soft text-ok' }[tone];
  return (
    <div role={tone === 'bad' ? 'alert' : 'status'} className={cx('rounded-md border px-3 py-2 text-[13px]', t)}>
      {children}
    </div>
  );
}

/* ------------------------------ Table ------------------------------ */

export function Table({ children }: { children: React.ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-left text-[13px]">{children}</table>
    </div>
  );
}
export function Th({ children, className }: { children?: React.ReactNode; className?: string }) {
  return (
    <th className={cx('sticky top-0 border-b border-line bg-canvas/80 px-4 py-2.5 text-[12px] font-semibold uppercase tracking-wide text-muted backdrop-blur', className)}>
      {children}
    </th>
  );
}
export function Td({ children, className, ...rest }: React.TdHTMLAttributes<HTMLTableCellElement>) {
  return (
    <td className={cx('border-b border-line px-4 py-3 align-middle', className)} {...rest}>
      {children}
    </td>
  );
}

/* ------------------------------ Dialog ------------------------------ */

export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  wide,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      className={cx('m-auto w-[calc(100%-2rem)] rounded-xl border border-line bg-surface p-0 text-text shadow-2xl', wide ? 'max-w-2xl' : 'max-w-md')}
    >
      {open && (
        <div>
          <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
            <div>
              <h2 className="text-base font-semibold text-ink-950">{title}</h2>
              {description && <p className="mt-0.5 text-[13px] text-muted">{description}</p>}
            </div>
            <button type="button" onClick={onClose} className="rounded p-1 text-muted hover:bg-canvas" aria-label="Close">
              <X className="size-4" />
            </button>
          </div>
          <div className="max-h-[70vh] overflow-y-auto px-5 py-4">{children}</div>
          {footer && <div className="flex justify-end gap-2 border-t border-line bg-canvas/50 px-5 py-3">{footer}</div>}
        </div>
      )}
    </dialog>
  );
}

/* ------------------------------ Tabs ------------------------------ */

export function Tabs<T extends string>({ value, onChange, tabs }: { value: T; onChange: (v: T) => void; tabs: { id: T; label: string; count?: number }[] }) {
  return (
    <div className="flex gap-1 overflow-x-auto border-b border-line" role="tablist">
      {tabs.map((t) => (
        <button
          key={t.id}
          role="tab"
          aria-selected={value === t.id}
          onClick={() => onChange(t.id)}
          className={cx(
            '-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium transition-colors',
            value === t.id ? 'border-accent text-ink-950' : 'border-transparent text-muted hover:text-ink-800',
          )}
        >
          {t.label}
          {t.count !== undefined && <span className="ml-1.5 rounded bg-canvas px-1.5 text-[11px] text-muted">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

/* ------------------------------ Definition list ------------------------------ */

export function Detail({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-[12px] font-medium uppercase tracking-wide text-subtle">{label}</dt>
      <dd className={cx('mt-0.5 break-words text-sm text-text', mono && 'num font-mono text-[13px]')}>{value ?? '—'}</dd>
    </div>
  );
}
