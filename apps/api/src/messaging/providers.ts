import { createHmac, timingSafeEqual } from 'node:crypto';
import type { AppConfig } from '../config/config';

export interface OutgoingMessage {
  /** 10-digit Indian mobile number. */
  to: string;
  body: string;
  /** Template values in the template's variable order. */
  params: string[];
  dltTemplateId: string | null;
  waTemplateName: string | null;
  waLanguage: string;
}

export type SendResult = { status: 'SENT'; providerMessageId: string } | { status: 'SIMULATED'; providerMessageId: null };

export class ProviderError extends Error {
  constructor(
    message: string,
    /** False when retrying cannot help (bad number, unapproved template, bad credentials). */
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

export interface MessageProvider {
  readonly key: string;
  send(m: OutgoingMessage): Promise<SendResult>;
}

type Fetch = typeof fetch;

/** Development / not configured: nothing leaves the system. The message is marked SIMULATED, never SENT. */
export class LogProvider implements MessageProvider {
  constructor(readonly key: string) {}
  async send(): Promise<SendResult> {
    return { status: 'SIMULATED', providerMessageId: null };
  }
}

/**
 * MSG91 SMS via the Flow API with a DLT-registered template (TRAI rules: every commercial SMS in
 * India must use a registered header and template). Variables are sent as var1..varN in the order
 * of the template's placeholders.
 */
export class Msg91Provider implements MessageProvider {
  readonly key = 'msg91';
  constructor(
    private readonly authKey: string,
    private readonly fetchFn: Fetch = fetch,
  ) {}

  async send(m: OutgoingMessage): Promise<SendResult> {
    if (!m.dltTemplateId) throw new ProviderError('This SMS template has no DLT template ID. Add it under Communications → Templates.', false);
    const recipient: Record<string, string> = { mobiles: `91${m.to}` };
    m.params.forEach((p, i) => (recipient[`var${i + 1}`] = p));
    const res = await this.call('https://control.msg91.com/api/v5/flow', { template_id: m.dltTemplateId, short_url: '0', recipients: [recipient] });
    const id = (res as { message?: string; request_id?: string }).request_id ?? (res as { message?: string }).message;
    if (!id) throw new ProviderError('MSG91 did not return a request id', true);
    return { status: 'SENT', providerMessageId: String(id) };
  }

  private async call(url: string, body: unknown) {
    let r: Response;
    try {
      r = await this.fetchFn(url, {
        method: 'POST',
        headers: { authkey: this.authKey, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (e) {
      throw new ProviderError(`MSG91 unreachable: ${(e as Error).message}`, true);
    }
    const json = (await r.json().catch(() => ({}))) as { type?: string; message?: string };
    if (!r.ok || json.type === 'error') {
      throw new ProviderError(`MSG91 ${r.status}: ${json.message ?? 'request failed'}`, r.status >= 500 || r.status === 429);
    }
    return json;
  }
}

/**
 * WhatsApp Business Cloud API (Meta). Business-initiated messages must use a template approved in
 * WhatsApp Manager; the body parameters are filled in the template's variable order.
 */
export class MetaWhatsAppProvider implements MessageProvider {
  readonly key = 'meta';
  constructor(
    private readonly cfg: { phoneNumberId: string; accessToken: string; apiVersion: string },
    private readonly fetchFn: Fetch = fetch,
  ) {}

  payload(m: OutgoingMessage) {
    if (!m.waTemplateName) throw new ProviderError('This WhatsApp template has no approved template name. Add it under Communications → Templates.', false);
    return {
      messaging_product: 'whatsapp',
      to: `91${m.to}`,
      type: 'template',
      template: {
        name: m.waTemplateName,
        language: { code: m.waLanguage },
        components: m.params.length ? [{ type: 'body', parameters: m.params.map((text) => ({ type: 'text', text })) }] : [],
      },
    };
  }

  async send(m: OutgoingMessage): Promise<SendResult> {
    const url = `https://graph.facebook.com/${this.cfg.apiVersion}/${this.cfg.phoneNumberId}/messages`;
    let r: Response;
    try {
      r = await this.fetchFn(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.cfg.accessToken}`, 'content-type': 'application/json' },
        body: JSON.stringify(this.payload(m)),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (e) {
      throw new ProviderError(`WhatsApp API unreachable: ${(e as Error).message}`, true);
    }
    const json = (await r.json().catch(() => ({}))) as { messages?: { id: string }[]; error?: { message?: string; code?: number } };
    if (!r.ok || !json.messages?.[0]?.id) {
      throw new ProviderError(`WhatsApp API ${r.status}: ${json.error?.message ?? 'request failed'}`, r.status >= 500 || r.status === 429);
    }
    return { status: 'SENT', providerMessageId: json.messages[0].id };
  }
}

export function smsProvider(config: AppConfig, fetchFn?: Fetch): MessageProvider {
  return config.sms.provider === 'msg91' ? new Msg91Provider(config.sms.authKey!, fetchFn) : new LogProvider('log');
}

export function whatsappProvider(config: AppConfig, fetchFn?: Fetch): MessageProvider {
  return config.whatsapp.provider === 'meta'
    ? new MetaWhatsAppProvider({ phoneNumberId: config.whatsapp.phoneNumberId!, accessToken: config.whatsapp.accessToken!, apiVersion: config.whatsapp.apiVersion }, fetchFn)
    : new LogProvider('log');
}

/** Meta signs webhook bodies: X-Hub-Signature-256: sha256=<hex HMAC of the raw body with the app secret>. */
export function verifyMetaSignature(rawBody: Buffer, header: string | undefined, appSecret: string): boolean {
  if (!header?.startsWith('sha256=')) return false;
  const expected = createHmac('sha256', appSecret).update(rawBody).digest();
  const given = Buffer.from(header.slice(7), 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export function safeEqualText(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Never let delivery status go backwards (a late "sent" must not overwrite "read"). */
const RANK: Record<string, number> = { QUEUED: 0, SENDING: 1, SENT: 2, DELIVERED: 3, READ: 4, FAILED: 5 };
export function isForward(from: string, to: string): boolean {
  if (from === 'FAILED' || from === 'SIMULATED' || from === 'SKIPPED') return false;
  if (to === 'FAILED') return from !== 'READ' && from !== 'DELIVERED';
  return (RANK[to] ?? -1) > (RANK[from] ?? -1);
}
