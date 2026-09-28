'use client';

import type { Permission } from '@fin/contracts';
import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { api, ApiError } from './api';

export interface Me {
  id: string;
  username: string;
  fullName: string;
  email: string | null;
  mobile: string | null;
  mfaEnabled: boolean;
  lastLoginAt: string | null;
  roles: string[];
  permissions: Permission[];
  scope: 'ALL' | 'BRANCH' | 'ASSIGNED';
  branches: { id: string; code: string; name: string }[];
  employee: { id: string; code: string; isCollector: boolean; branchId: string } | null;
  restriction: 'MFA_PENDING' | 'PASSWORD_CHANGE' | 'MFA_SETUP' | null;
}

interface SessionState {
  me: Me | null;
  loading: boolean;
  error: ApiError | null;
  reload: () => Promise<void>;
  can: (...permissions: Permission[]) => boolean;
}

const Ctx = createContext<SessionState | null>(null);

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ApiError | null>(null);

  const reload = useCallback(async () => {
    try {
      // The shell decides where to send a signed-out user; don't redirect from here.
      setMe(await api<Me>('GET', '/auth/me', { noAuthRedirect: true }));
      setError(null);
    } catch (e) {
      setError(e as ApiError);
      setMe(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const can = useCallback((...p: Permission[]) => !!me && p.every((x) => me.permissions.includes(x)), [me]);

  return <Ctx.Provider value={{ me, loading, error, reload, can }}>{children}</Ctx.Provider>;
}

export function useSession(): SessionState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useSession outside SessionProvider');
  return v;
}

export const ROLE_LABELS: Record<string, string> = {
  SUPER_ADMIN: 'Super Admin',
  MANAGEMENT: 'Management',
  BRANCH_MANAGER: 'Branch Manager',
  ACCOUNTANT: 'Accountant',
  COLLECTION_EMPLOYEE: 'Collection Employee',
};
