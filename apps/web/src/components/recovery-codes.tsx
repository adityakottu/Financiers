'use client';

import { Copy, Download } from 'lucide-react';
import { Button } from './ui';

export function RecoveryCodes({ codes }: { codes: string[] }) {
  const text = codes.join('\n');
  function download() {
    const url = URL.createObjectURL(new Blob([`Financiers recovery codes\n\n${text}\n`], { type: 'text/plain' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: 'financiers-recovery-codes.txt' });
    a.click();
    URL.revokeObjectURL(url);
  }
  return (
    <div className="rounded-lg border border-line bg-surface p-4">
      <ol className="num grid grid-cols-2 gap-x-6 gap-y-1.5 font-mono text-[13px] text-ink-900">
        {codes.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ol>
      <div className="mt-4 flex gap-2">
        <Button type="button" size="sm" variant="secondary" onClick={() => navigator.clipboard.writeText(text)}>
          <Copy className="size-3.5" /> Copy
        </Button>
        <Button type="button" size="sm" variant="secondary" onClick={download}>
          <Download className="size-3.5" /> Download
        </Button>
      </div>
    </div>
  );
}
