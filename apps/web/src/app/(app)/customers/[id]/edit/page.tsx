'use client';

import Link from 'next/link';
import { use } from 'react';
import { CustomerForm, CustomerInitial } from '@/components/customer-form';
import { EmptyState, PageHeader, Spinner } from '@/components/ui';
import { useApi } from '@/lib/hooks';
import { useSession } from '@/lib/session';

export default function EditCustomerPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { can } = useSession();
  const { data, loading, error } = useApi<CustomerInitial & { fullName: string; customerNo: string; branchId: string }>(`/customers/${id}`);
  if (!can('customer.edit')) return <EmptyState title="You don’t have permission to edit customers" />;
  if (loading) return <Spinner />;
  if (error || !data) return <EmptyState title="Customer not found" />;
  return (
    <>
      <PageHeader
        title={`Edit ${data.fullName}`}
        breadcrumb={
          <>
            <Link href="/customers" className="hover:underline">
              Customers
            </Link>{' '}
            /{' '}
            <Link href={`/customers/${id}`} className="hover:underline">
              {data.customerNo}
            </Link>
          </>
        }
      />
      <CustomerForm initial={data} />
    </>
  );
}
