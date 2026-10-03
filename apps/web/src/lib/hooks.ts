'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, get } from './api';

/** Fetch JSON for a path; refetches when the path changes. `null` path = skip. */
export function useApi<T>(path: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(!!path);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!path) return;
    const ctrl = new AbortController();
    setLoading(true);
    get<T>(path, ctrl.signal)
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((e) => {
        if ((e as Error).name !== 'AbortError') setError(e as ApiError);
      })
      .finally(() => {
        if (!ctrl.signal.aborted) setLoading(false);
      });
    return () => ctrl.abort();
  }, [path, tick]);

  const reload = useCallback(() => setTick((n) => n + 1), []);
  return { data, error, loading, reload, setData };
}

export function useDebounced<T>(value: T, ms = 250): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setV(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return v;
}

/**
 * Guards a submit handler against double clicks: while the promise is pending, further
 * calls are ignored. (The API's idempotency keys protect against retries across reloads.)
 */
export function useSubmit<A extends unknown[]>(fn: (...args: A) => Promise<void>) {
  const busy = useRef(false);
  const [pending, setPending] = useState(false);
  const run = useCallback(
    async (...args: A) => {
      if (busy.current) return;
      busy.current = true;
      setPending(true);
      try {
        await fn(...args);
      } finally {
        busy.current = false;
        setPending(false);
      }
    },
    [fn],
  );
  return [run, pending] as const;
}
