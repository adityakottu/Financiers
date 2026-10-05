import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { createReadStream, createWriteStream, statSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';

/**
 * Tiny S3 copy for the backup and restore-drill scripts (no AWS CLI in the image):
 *   node dist/ops/s3-object.js put <file> s3://bucket/key
 *   node dist/ops/s3-object.js get s3://bucket/key <file>
 * Credentials come from the task role; uploads use SSE-KMS (BACKUP_KMS_KEY_ID, else the bucket key).
 */
function parse(uri: string) {
  const m = /^s3:\/\/([^/]+)\/(.+)$/.exec(uri);
  if (!m) throw new Error(`not an s3:// URI: ${uri}`);
  return { Bucket: m[1]!, Key: m[2]! };
}

async function main() {
  const [cmd, a, b] = process.argv.slice(2);
  const s3 = new S3Client({ region: process.env.AWS_REGION ?? 'ap-south-1', ...(process.env.S3_ENDPOINT ? { endpoint: process.env.S3_ENDPOINT, forcePathStyle: true } : {}) });
  if (cmd === 'put' && a && b) {
    await s3.send(
      new PutObjectCommand({
        ...parse(b),
        Body: createReadStream(a),
        ContentLength: statSync(a).size,
        ServerSideEncryption: 'aws:kms',
        ...(process.env.BACKUP_KMS_KEY_ID ? { SSEKMSKeyId: process.env.BACKUP_KMS_KEY_ID } : {}),
      }),
    );
  } else if (cmd === 'get' && a && b) {
    const r = await s3.send(new GetObjectCommand(parse(a)));
    await pipeline(r.Body as Readable, createWriteStream(b, { mode: 0o600 }));
  } else {
    throw new Error('usage: s3-object put <file> s3://bucket/key | get s3://bucket/key <file>');
  }
}

main().catch((e) => {
  process.stderr.write(`${(e as Error).message}\n`);
  process.exit(1);
});
