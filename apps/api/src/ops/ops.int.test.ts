import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LocalStore, S3Store } from '../files/storage';
import { createTestApp, TestApp } from '../test/harness';

/** Phase 10: health / readiness for the load balancer, and the document stores. */
describe('health and readiness', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => t.close());

  it('liveness needs no session; readiness also confirms the database and that every migration is applied', async () => {
    const live = await request(t.server).get('/api/v1/health');
    expect(live.status).toBe(200);
    expect(live.body).toEqual({ status: 'ok' });
    const ready = await request(t.server).get('/api/v1/health/ready');
    expect(ready.status).toBe(200);
    expect(ready.body).toEqual({ status: 'ready' });
  });
});

async function storeContract(store: LocalStore | S3Store) {
  const key = `2026/10/${Math.random().toString(36).slice(2)}`;
  await store.put(key, Buffer.from('%PDF-1.4 first'), 'application/pdf');
  expect((await store.get(key)).toString()).toBe('%PDF-1.4 first');
  // Write-once: an existing document is never overwritten.
  await expect(store.put(key, Buffer.from('%PDF-1.4 second'), 'application/pdf')).rejects.toThrow();
  expect((await store.get(key)).toString()).toBe('%PDF-1.4 first');
}

describe('document stores', () => {
  it('local: write-once, read back, and keys cannot escape the storage directory', async () => {
    const store = new LocalStore(mkdtempSync(join(tmpdir(), 'fin-store-')));
    await storeContract(store);
    await expect(store.put('../../etc/escape', Buffer.from('x'), 'text/plain')).rejects.toThrow(/Invalid storage key/);
    await expect(store.get('../outside')).rejects.toThrow(/Invalid storage key/);
  });

  // Runs when an S3-compatible endpoint is provided (CI starts one); production uses AWS S3 with SSE-KMS.
  it.runIf(!!process.env.S3_TEST_ENDPOINT)('s3: write-once with server-side encryption, read back', async () => {
    process.env.AWS_ACCESS_KEY_ID ??= 'test';
    process.env.AWS_SECRET_ACCESS_KEY ??= 'test';
    const store = new S3Store({ bucket: process.env.S3_TEST_BUCKET ?? 'fin-docs', region: 'ap-south-1', prefix: 'files/', kmsKeyId: null, endpoint: process.env.S3_TEST_ENDPOINT });
    await storeContract(store);
  });
});
