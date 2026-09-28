import type { Metadata, Viewport } from 'next';
import { ToastProvider } from '@/components/toast';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'Financiers', template: '%s · Financiers' },
  description: 'Lending, collections, accounting and reconciliation',
  robots: { index: false, follow: false },
};

export const viewport: Viewport = { width: 'device-width', initialScale: 1, themeColor: '#10223a' };

// Every page carries a per-request CSP nonce, so pages render dynamically.
export const dynamic = 'force-dynamic';

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-IN">
      <body>
        <ToastProvider>{children}</ToastProvider>
      </body>
    </html>
  );
}
