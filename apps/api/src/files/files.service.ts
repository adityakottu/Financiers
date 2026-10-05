import { Inject, Injectable, Logger } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { AppConfig, CONFIG } from '../config/config';
import { unprocessable } from '../common/errors';
import type { Db, Executor } from '../db/db';
import { clamScan } from './scanner';
import { BlobStore, LocalStore, S3Store } from './storage';

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
 * Uploaded documents. Stored in a private local directory or a private S3 bucket (SSE-KMS) —
 * STORAGE_DRIVER; see storage.ts. Files are only ever read back through the API.
 *
 * Malware scanning (doc 11 §5): with CLAMAV_HOST set, every upload is scanned by clamd before it
 * is stored — infected files are refused and never written. If clamd cannot be reached the file is
 * kept PENDING (not downloadable) and rescanned by the background job. Without a scanner
 * configured, development marks files CLEAN; production keeps them PENDING (and refuses to start
 * without a scanner — see config).
 */
@Injectable()
export class FilesService {
  private readonly blobs: BlobStore;
  private readonly log = new Logger('Files');

  constructor(@Inject(CONFIG) private readonly config: AppConfig) {
    const s = config.storage;
    this.blobs = s.driver === 's3' ? new S3Store(s) : new LocalStore(s.dir);
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
    await this.blobs.put(key, file.buffer, mime);

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

  read(storageKey: string): Promise<Buffer> {
    return this.blobs.get(storageKey);
  }
}
