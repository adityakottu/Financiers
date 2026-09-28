'use client';

import Link from 'next/link';
import { CustomerForm } from '@/components/customer-form';
import { EmptyState, PageHeader } from '@/components/ui';
import { useSession } from '@/lib/session';

export default function NewCustomerPage() {
  const { can } = useSession();
  if (!can('customer.create')) return <EmptyState title="You don’t have permission to add customers" />;
  return (
    <>
      <PageHeader
        title="New customer"
        breadcrumb={
          <Link href="/customers" className="hover:underline">
            Customers
          </Link>
        }
      />
      <CustomerForm />
    </>
  );
}
