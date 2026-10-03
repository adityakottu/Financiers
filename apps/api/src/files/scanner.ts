import { connect } from 'node:net';

export type ScanResult = { clean: true } | { clean: false; signature: string };

/**
 * Scan bytes with ClamAV's clamd over TCP (INSTREAM protocol): "zINSTREAM\0", then chunks of
 * <4-byte big-endian length><data>, ended by a zero-length chunk. clamd answers
 * "stream: OK" or "stream: <signature> FOUND". Throws if clamd is unreachable or answers oddly,
 * so the caller can keep the file PENDING (never treat "could not scan" as clean).
 */
export function clamScan(host: string, port: number, data: Buffer, timeoutMs = 30_000): Promise<ScanResult> {
  return new Promise((resolve, reject) => {
    const sock = connect({ host, port });
    const chunks: Buffer[] = [];
    const fail = (e: Error) => {
      sock.destroy();
      reject(e);
    };
    sock.setTimeout(timeoutMs, () => fail(new Error('clamd timed out')));
    sock.on('error', fail);
    sock.on('connect', () => {
      sock.write('zINSTREAM\0');
      const size = 64 * 1024;
      for (let i = 0; i < data.length; i += size) {
        const part = data.subarray(i, i + size);
        const len = Buffer.alloc(4);
        len.writeUInt32BE(part.length);
        sock.write(len);
        sock.write(part);
      }
      sock.write(Buffer.alloc(4));
    });
    sock.on('data', (c) => chunks.push(c));
    sock.on('end', () => {
      const reply = Buffer.concat(chunks).toString('utf8').replace(/\0/g, '').trim();
      if (/^stream: OK$/.test(reply)) return resolve({ clean: true });
      const m = /^stream: (.+) FOUND$/.exec(reply);
      if (m) return resolve({ clean: false, signature: m[1]! });
      reject(new Error(`unexpected clamd reply: ${reply.slice(0, 100)}`));
    });
  });
}
