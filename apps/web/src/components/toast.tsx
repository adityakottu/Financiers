'use client';

import { CheckCircle2, AlertTriangle } from 'lucide-react';
import { createContext, useCallback, useContext, useState } from 'react';

type Toast = { id: number; tone: 'ok' | 'bad'; message: string };
const Ctx = createContext<(tone: Toast['tone'], message: string) => void>(() => undefined);

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((tone: Toast['tone'], message: string) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, tone, message }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4500);
  }, []);
  return (
    <Ctx.Provider value={push}>
      {children}
      <div className="pointer-events-none fixed inset-x-0 bottom-20 z-50 flex flex-col items-center gap-2 px-4 md:bottom-6 md:items-end md:px-6" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className="pointer-events-auto flex max-w-sm items-start gap-2 rounded-lg bg-ink-950 px-4 py-3 text-sm text-white shadow-lg">
            {t.tone === 'ok' ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-300" /> : <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-300" />}
            <span>{t.message}</span>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

export function useToast() {
  return useContext(Ctx);
}
