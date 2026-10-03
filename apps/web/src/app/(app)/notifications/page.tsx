'use client';

import { ArrowUpRight, BellOff, RefreshCw } from 'lucide-react';
import Link from 'next/link';
import { Badge, Button, Card, EmptyState, PageHeader, Spinner } from '@/components/ui';
import { count } from '@/lib/format';
import { useApi } from '@/lib/hooks';

interface Item { key: string; title: string; detail: string; count: number; href: string; tone: 'warn' | 'info' | 'ok' }

/** What is waiting for you — computed live, so it is never stale and never needs clearing. */
export default function NotificationsPage() {
  const { data, loading, reload } = useApi<{ items: Item[]; total: number }>('/notifications');
  return (
    <>
      <PageHeader
        title="Waiting for you"
        subtitle="Approvals and work in your branches that need your decision. Your own requests never appear here — someone else decides them."
        actions={
          <Button variant="secondary" size="sm" onClick={reload}>
            <RefreshCw className="size-3.5" /> Refresh
          </Button>
        }
      />
      {loading && !data ? (
        <Spinner />
      ) : !data?.items.length ? (
        <Card>
          <EmptyState icon={<BellOff className="size-8" />} title="Nothing is waiting for you" body="New approvals and ready exports will show here." />
        </Card>
      ) : (
        <Card>
          <ul className="divide-y divide-line">
            {data.items.map((i) => (
              <li key={i.key}>
                <Link href={i.href} className="flex items-center justify-between gap-4 px-5 py-4 hover:bg-canvas">
                  <span>
                    <span className="font-medium text-ink-950">{i.title}</span>
                    <span className="block text-[13px] text-muted">{i.detail}</span>
                  </span>
                  <span className="flex items-center gap-3">
                    <Badge tone={i.tone}>{count(i.count)}</Badge>
                    <ArrowUpRight className="size-4 text-subtle" />
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </>
  );
}
