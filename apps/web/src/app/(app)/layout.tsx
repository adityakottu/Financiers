import { Shell } from '@/components/shell';
import { StepUpProvider } from '@/components/step-up';
import { SessionProvider } from '@/lib/session';

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <SessionProvider>
      <StepUpProvider>
        <Shell>{children}</Shell>
      </StepUpProvider>
    </SessionProvider>
  );
}
