import { Inject, Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { AppConfig, CONFIG } from '../config/config';
import { unprocessable } from '../common/errors';
import type { Executor } from '../db/db';

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
 * Malware scanning: files start PENDING and cannot be downloaded until marked CLEAN.
 * No scanner is wired yet — outside production, uploads are marked CLEAN immediately so the
 * workflow can be exercised; in production they stay PENDING until the ClamAV worker exists.
 */
@Injectable()
export class FilesService {
  private readonly root: string;

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
        scan_status: this.config.production ? 'PENDING' : 'CLEAN',
        classification,
        uploaded_by: userId,
      })
      .returning(['id', 'original_name', 'mime_type', 'size_bytes', 'scan_status'])
      .executeTakeFirstOrThrow();
  }

  async read(storageKey: string): Promise<Buffer> {
    const path = resolve(this.root, storageKey);
    if (!path.startsWith(this.root + '/')) throw new Error('Invalid storage key');
    return readFile(path);
  }
}
