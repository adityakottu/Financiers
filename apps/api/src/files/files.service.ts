import { Inject, Injectable, Logger } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { AppConfig, CONFIG } from '../config/config';
import { unprocessable } from '../common/errors';
import type { Db, Executor } from '../db/db';
import { clamScan } from './scanner';

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/** Detect the real type from the first bytes; the client-supplied name and MIME type are not trusted. */
export function sniffMime(buf: Buffer): 'application/pdf' | 'image/jpeg' | 'image/png' | null {
  if (buf.length >= 5 && buf.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  return null;
}

const EXT: Record<string, string> = { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png' };

export function safeFileName(name: string, mime: string): string {
  const base = name.replace(/\.[^.]*$/, '').replace(/[^\w\- ]+/g, '').trim().slice(0, 80) || 'document';
  return `${base}.${EXT[mime]}`;
}

/**
 * Storage adapter. V1 writes to a private local directory; production swaps in S3 (SSE-KMS,
 * private bucket, presigned URLs) behind the same interface.
 *
 * Malware scanning (doc 11 §5): with CLAMAV_HOST set, every upload is scanned by clamd before it
 * is stored — infected files are refused and never written. If clamd cannot be reached the file is
 * kept PENDING (not downloadable) and rescanned by the background job. Without a scanner
 * configured, development marks files CLEAN; production keeps them PENDING (and refuses to start
 * without a scanner — see config).
 */
@Injectable()
export class FilesService {
  private readonly root: string;
  private readonly log = new Logger('Files');

  constructor(@Inject(CONFIG) private readonly config: AppConfig) {
    this.root = resolve(config.fileStorageDir);
  }

  async store(
    db: Executor,
    file: { buffer: Buffer; originalname: string; size: number },
    classification: string,
    userId: string,
  ) {
    if (!file?.buffer?.length) throw unprocessable('EMPTY_FILE', 'Choose a file to upload');
    if (file.size > MAX_UPLOAD_BYTES) throw unprocessable('FILE_TOO_LARGE', 'Files must be 10 MB or smaller');
    const mime = sniffMime(file.buffer);
    if (!mime) throw unprocessable('UNSUPPORTED_FILE', 'Only PDF, JPEG and PNG files are accepted');
    const scan = await this.scan(file.buffer);
    if (scan.status === 'INFECTED') {
      this.log.warn(`upload refused: malware ${scan.result} (user ${userId})`);
      throw unprocessable('MALWARE_DETECTED', 'This file was flagged by the virus scanner and was not saved');
    }

    const now = new Date();
    const key = `${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${randomUUID()}`;
    const path = join(this.root, key);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, file.buffer, { mode: 0o600, flag: 'wx' });

    return db
      .insertInto('files')
      .values({
        storage_key: key,
        original_name: safeFileName(file.originalname, mime),
        mime_type: mime,
        size_bytes: file.size,
        sha256: createHash('sha256').update(file.buffer).digest(),
        scan_status: scan.status,
        scan_result: scan.result,
        scanned_at: scan.status === 'PENDING' ? null : new Date(),
        classification,
        uploaded_by: userId,
      })
      .returning(['id', 'original_name', 'mime_type', 'size_bytes', 'scan_status'])
      .executeTakeFirstOrThrow();
  }

  private async scan(buf: Buffer): Promise<{ status: 'CLEAN' | 'INFECTED' | 'PENDING'; result: string | null }> {
    if (!this.config.clamav) return this.config.production ? { status: 'PENDING', result: null } : { status: 'CLEAN', result: 'not scanned (development)' };
    try {
      const r = await clamScan(this.config.clamav.host, this.config.clamav.port, buf);
      return r.clean ? { status: 'CLEAN', result: 'OK' } : { status: 'INFECTED', result: r.signature };
    } catch (e) {
      this.log.error(`clamd unavailable: ${(e as Error).message}`);
      return { status: 'PENDING', result: null };
    }
  }

  /** Background: rescan files left PENDING (scanner was down). Infected ones are marked and stay blocked. */
  async rescanPending(db: Db, limit = 50) {
    if (!this.config.clamav) return { scanned: 0 };
    const pending = await db.selectFrom('files').select(['id', 'storage_key']).where('scan_status', '=', 'PENDING').orderBy('uploaded_at').limit(limit).execute();
    let scanned = 0;
    for (const f of pending) {
      const s = await this.scan(await this.read(f.storage_key));
      if (s.status === 'PENDING') break; // scanner still down
      await db.updateTable('files').set({ scan_status: s.status, scan_result: s.result, scanned_at: new Date() }).where('id', '=', f.id).execute();
      if (s.status === 'INFECTED') this.log.warn(`stored file ${f.id} flagged: ${s.result}`);
      scanned++;
    }
    return { scanned };
  }

  async read(storageKey: string): Promise<Buffer> {
    const path = resolve(this.root, storageKey);
    if (!path.startsWith(this.root + '/')) throw new Error('Invalid storage key');
    return readFile(path);
  }
}
