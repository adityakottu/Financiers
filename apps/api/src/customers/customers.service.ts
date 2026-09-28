import { Inject, Injectable } from '@nestjs/common';
import {
  CustomerCreateInput,
  CustomerUpdateInput,
  KYC_DOC_TYPES,
  kycInputSchema,
  mask,
} from '@fin/contracts';
import { sql } from 'kysely';
import type { z } from 'zod';
import { AuditService, diff } from '../audit/audit.service';
import { scope } from '../auth/access.service';
import type { AuthContext, RequestContext } from '../auth/context';
import { CryptoService } from '../common/crypto.service';
import { conflict, notFound, preconditionFailed, unprocessable } from '../common/errors';
import { DB_TOKEN, Db, Executor, Tx, isUniqueViolation, pgConstraint } from '../db/db';
import { NumberingService } from '../numbering/numbering.service';

type KycType = (typeof KYC_DOC_TYPES)[number];
type KycInput = z.infer<typeof kycInputSchema>;

const NONE = '00000000-0000-0000-0000-000000000000';

export function normaliseId(v: string): string {
  return v.toUpperCase().replace(/[\s-]/g, '');
}

const kycAad = (docType: string) => `customer_kyc.${docType}`;

/** Business rule (configurable later ⚖): 2+ verified identity documents = VERIFIED. */
export function kycStatusFor(docs: { verified_at: Date | null }[]): 'PENDING' | 'PARTIAL' | 'VERIFIED' {
  if (docs.length === 0) return 'PENDING';
  return docs.filter((d) => d.verified_at).length >= 2 ? 'VERIFIED' : 'PARTIAL';
}

@Injectable()
export class CustomersService {
  constructor(
    @Inject(DB_TOKEN) private readonly db: Db,
    private readonly crypto: CryptoService,
    private readonly numbering: NumberingService,
    private readonly audit: AuditService,
  ) {}

  /* ------------------------------ scope ------------------------------ */

  /** Customers visible to the caller. Collectors (ASSIGNED) see customers of their assigned loans — added in Phase 4. */
  private scoped(db: Executor, auth: AuthContext) {
    const branches = scope.branchFilter(auth);
    let q = db.selectFrom('customers as c').innerJoin('branches as b', 'b.id', 'c.branch_id');
    if (branches) q = q.where('c.branch_id', 'in', branches.length ? branches : [NONE]);
    return q;
  }

  private async loadScoped(db: Executor, auth: AuthContext, id: string) {
    const row = await this.scoped(db, auth).selectAll('c').select('b.code as branch_code').where('c.id', '=', id).executeTakeFirst();
    if (!row) throw notFound('Customer');
    return row;
  }

  private mobile(auth: AuthContext, m: string | null) {
    return auth.permissions.has('customer.view_contact') ? m : mask.mobile(m);
  }

  /* ------------------------------ reads ------------------------------ */

  async list(
    auth: AuthContext,
    q: { limit: number; cursor?: string; q?: string; branchId?: string; status?: string; kycStatus?: string },
  ) {
    let sel = this.scoped(this.db, auth)
      .select([
        'c.id',
        'c.customer_no',
        'c.full_name',
        'c.mobile',
        'c.village_town',
        'c.district',
        'c.kyc_status',
        'c.status',
        'c.created_at',
        'b.code as branch_code',
      ])
      .orderBy('c.id', 'desc')
      .limit(q.limit + 1);
    if (q.cursor) sel = sel.where('c.id', '<', q.cursor);
    if (q.branchId) sel = sel.where('c.branch_id', '=', q.branchId);
    if (q.status) sel = sel.where('c.status', '=', q.status);
    if (q.kycStatus) sel = sel.where('c.kyc_status', '=', q.kycStatus);
    if (q.q) {
      const term = q.q.replace(/[%_\\]/g, '');
      const digits = term.replace(/\D/g, '');
      sel = sel.where((eb) =>
        eb.or([
          eb('c.full_name', 'ilike', `%${term}%`),
          eb('c.customer_no', 'ilike', `${term}%`),
          ...(digits.length >= 4 ? [eb('c.mobile', 'like', `%${digits}%`)] : []),
        ]),
      );
    }
    const rows = await sel.execute();
    const hasMore = rows.length > q.limit;
    const data = rows.slice(0, q.limit).map((r) => ({ ...r, mobile: this.mobile(auth, r.mobile) }));
    return { data, nextCursor: hasMore ? data[data.length - 1]!.id : null };
  }

  async get(auth: AuthContext, id: string) {
    const c = await this.loadScoped(this.db, auth, id);
    const [kyc, refs, docs] = await Promise.all([
      this.db
        .selectFrom('customer_kyc_documents')
        .select(['doc_type', 'number_last4', 'verified_at', 'verification_method'])
        .where('customer_id', '=', id)
        .orderBy('doc_type')
        .execute(),
      this.db
        .selectFrom('customer_references')
        .select(['id', 'name', 'relationship', 'mobile', 'address'])
        .where('customer_id', '=', id)
        .orderBy('sort_order')
        .execute(),
      this.db
        .selectFrom('customer_documents as d')
        .innerJoin('files as f', 'f.id', 'd.file_id')
        .select(['d.id', 'd.category', 'd.notes', 'd.created_at', 'f.id as file_id', 'f.original_name', 'f.mime_type', 'f.size_bytes', 'f.scan_status'])
        .where('d.customer_id', '=', id)
        .orderBy('d.created_at', 'desc')
        .execute(),
    ]);
    const showKyc = auth.permissions.has('kyc.view_masked');
    const showKycDocs = auth.permissions.has('document.view_kyc');
    return {
      id: c.id,
      customerNo: c.customer_no,
      branchId: c.branch_id,
      branchCode: c.branch_code,
      fullName: c.full_name,
      relationType: c.relation_type,
      relationName: c.relation_name,
      dob: c.dob,
      gender: c.gender,
      mobile: this.mobile(auth, c.mobile),
      altMobile: this.mobile(auth, c.alt_mobile),
      email: c.email,
      addressLine1: c.address_line1,
      addressLine2: c.address_line2,
      villageTown: c.village_town,
      mandal: c.mandal,
      district: c.district,
      state: c.state,
      pincode: c.pincode,
      occupation: c.occupation,
      employerBusinessName: c.employer_business_name,
      businessType: c.business_type,
      monthlyIncome: c.monthly_income,
      workAddress: c.work_address,
      kycStatus: c.kyc_status,
      riskCategory: c.risk_category,
      whatsappOptIn: c.whatsapp_opt_in,
      status: c.status,
      version: c.version,
      createdAt: c.created_at,
      kyc: showKyc
        ? kyc.map((k) => ({
            docType: k.doc_type,
            masked:
              k.doc_type === 'AADHAAR' ? mask.aadhaar(k.number_last4) : k.doc_type === 'PAN' ? mask.pan(k.number_last4) : mask.generic(k.number_last4),
            verified: k.verified_at !== null,
            verifiedAt: k.verified_at,
            verificationMethod: k.verification_method,
            revealable: k.doc_type !== 'AADHAAR' && auth.permissions.has('kyc.reveal'),
          }))
        : null,
      references: refs.map((r) => ({ ...r, mobile: this.mobile(auth, r.mobile) })),
      documents: docs.filter((d) => d.category !== 'KYC' || showKycDocs),
    };
  }

  async timeline(auth: AuthContext, id: string) {
    await this.loadScoped(this.db, auth, id);
    return this.db
      .selectFrom('customer_events as e')
      .leftJoin('users as u', 'u.id', 'e.actor_id')
      .select(['e.id', 'e.at', 'e.event_type', 'e.summary', 'e.ref_type', 'e.ref_id', 'u.full_name as actor'])
      .where('e.customer_id', '=', id)
      .orderBy('e.at', 'desc')
      .orderBy('e.id', 'desc')
      .limit(200)
      .execute();
  }

  /* ------------------------------ writes ------------------------------ */

  async event(tx: Executor, customerId: string, actorId: string, eventType: string, summary: string, ref?: { type: string; id: string }) {
    await tx
      .insertInto('customer_events')
      .values({ customer_id: customerId, actor_id: actorId, event_type: eventType, summary, ref_type: ref?.type ?? null, ref_id: ref?.id ?? null })
      .execute();
  }

  private async writeKyc(tx: Tx, customerId: string, userId: string, kyc: KycInput): Promise<string[]> {
    const changed: string[] = [];
    const entries: [KycType, string | undefined][] = [
      ['PAN', kyc.pan],
      ['AADHAAR', kyc.aadhaarLast4],
      ['DRIVING_LICENCE', kyc.drivingLicence],
      ['VOTER_ID', kyc.voterId],
    ];
    for (const [docType, raw] of entries) {
      if (!raw) continue;
      const value = normaliseId(raw);
      const isAadhaar = docType === 'AADHAAR';
      const row = {
        number_enc: isAadhaar ? null : this.crypto.encrypt(value, kycAad(docType)),
        number_last4: value.slice(-4),
        number_bidx: isAadhaar ? null : this.crypto.blindIndex(docType, value),
        key_version: isAadhaar ? null : this.crypto.keyVersion,
      };
      const existing = await tx
        .selectFrom('customer_kyc_documents')
        .select(['id', 'number_bidx', 'number_last4'])
        .where('customer_id', '=', customerId)
        .where('doc_type', '=', docType)
        .executeTakeFirst();
      if (existing) {
        const same = isAadhaar ? existing.number_last4 === row.number_last4 : existing.number_bidx?.equals(row.number_bidx!);
        if (same) continue;
        // A changed number invalidates the previous verification.
        await tx
          .updateTable('customer_kyc_documents')
          .set({ ...row, verified_at: null, verified_by: null, verification_method: null, updated_at: new Date() })
          .where('id', '=', existing.id)
          .execute();
      } else {
        await tx.insertInto('customer_kyc_documents').values({ ...row, customer_id: customerId, doc_type: docType, created_by: userId }).execute();
      }
      changed.push(docType);
    }
    return changed;
  }

  private async refreshKycStatus(tx: Tx, customerId: string) {
    const docs = await tx.selectFrom('customer_kyc_documents').select('verified_at').where('customer_id', '=', customerId).execute();
    const status = kycStatusFor(docs);
    await tx
      .updateTable('customers')
      .set({ kyc_status: status })
      .where('id', '=', customerId)
      .where('kyc_status', '<>', 'REJECTED')
      .execute();
    return status;
  }

  private rethrowDuplicate(e: unknown): never {
    if (isUniqueViolation(e) && pgConstraint(e) === 'kyc_pan_unique_idx') {
      throw conflict('DUPLICATE_PAN', 'Another customer already has this PAN. Search for the existing customer instead.');
    }
    throw e;
  }

  async create(tx: Tx, ctx: RequestContext, input: CustomerCreateInput) {
    scope.assertBranchWritable(ctx.auth, input.branchId);
    const branch = await tx
      .selectFrom('branches')
      .select(['code', 'is_active'])
      .where('id', '=', input.branchId)
      .executeTakeFirst();
    if (!branch || !branch.is_active) throw unprocessable('BRANCH_INACTIVE', 'Choose an active branch');
    try {
      const customerNo = await this.numbering.next(tx, 'CUSTOMER', { branchCode: branch.code });
      const c = await tx
        .insertInto('customers')
        .values({
          customer_no: customerNo,
          branch_id: input.branchId,
          full_name: input.fullName,
          relation_type: input.relationType ?? null,
          relation_name: input.relationName ?? null,
          dob: input.dob ?? null,
          gender: input.gender ?? null,
          mobile: input.mobile,
          alt_mobile: input.altMobile ?? null,
          email: input.email ?? null,
          address_line1: input.addressLine1 ?? null,
          address_line2: input.addressLine2 ?? null,
          village_town: input.villageTown ?? null,
          mandal: input.mandal ?? null,
          district: input.district ?? null,
          state: input.state ?? null,
          pincode: input.pincode ?? null,
          occupation: input.occupation ?? null,
          employer_business_name: input.employerBusinessName ?? null,
          business_type: input.businessType ?? null,
          monthly_income: input.monthlyIncome ?? null,
          work_address: input.workAddress ?? null,
          whatsapp_opt_in: input.whatsappOptIn,
          whatsapp_opt_in_at: input.whatsappOptIn ? new Date() : null,
          created_by: ctx.auth.userId,
          updated_by: ctx.auth.userId,
        })
        .returning(['id', 'customer_no'])
        .executeTakeFirstOrThrow();
      if (input.references.length) {
        await tx
          .insertInto('customer_references')
          .values(
            input.references.map((r, i) => ({
              customer_id: c.id,
              name: r.name,
              relationship: r.relationship,
              mobile: r.mobile,
              address: r.address ?? null,
              sort_order: i,
            })),
          )
          .execute();
      }
      const kycDocs = await this.writeKyc(tx, c.id, ctx.auth.userId, input.kyc);
      const kycStatus = await this.refreshKycStatus(tx, c.id);
      await this.event(tx, c.id, ctx.auth.userId, 'CUSTOMER_CREATED', `Customer ${c.customer_no} created`);
      await this.audit.record(tx, ctx, {
        action: 'customer.created',
        entityType: 'customer',
        entityId: c.id,
        branchId: input.branchId,
        newValues: {
          customerNo: c.customer_no,
          fullName: input.fullName,
          mobile: input.mobile,
          kycDocs,
          kycStatus,
          references: input.references.length,
        },
      });
      return { id: c.id, customerNo: c.customer_no };
    } catch (e) {
      this.rethrowDuplicate(e);
    }
  }

  async update(ctx: RequestContext, id: string, input: CustomerUpdateInput, version: number) {
    return this.db.transaction().execute(async (tx) => {
      const before = await this.scoped(tx, ctx.auth).selectAll('c').where('c.id', '=', id).forUpdate().executeTakeFirst();
      if (!before) throw notFound('Customer');
      if (before.version !== version) throw preconditionFailed();
      if (input.branchId && input.branchId !== before.branch_id) scope.assertBranchWritable(ctx.auth, input.branchId);
      // undefined = leave unchanged; null = clear the field.
      const pick = <K extends keyof CustomerUpdateInput>(k: K, cur: unknown) => (input[k] === undefined ? cur : input[k]);
      const next = {
        branch_id: pick('branchId', before.branch_id) as string,
        full_name: pick('fullName', before.full_name) as string,
        relation_type: pick('relationType', before.relation_type) as string | null,
        relation_name: pick('relationName', before.relation_name) as string | null,
        dob: pick('dob', before.dob) as string | null,
        gender: pick('gender', before.gender) as string | null,
        mobile: pick('mobile', before.mobile) as string,
        alt_mobile: pick('altMobile', before.alt_mobile) as string | null,
        email: pick('email', before.email) as string | null,
        address_line1: pick('addressLine1', before.address_line1) as string | null,
        address_line2: pick('addressLine2', before.address_line2) as string | null,
        village_town: pick('villageTown', before.village_town) as string | null,
        mandal: pick('mandal', before.mandal) as string | null,
        district: pick('district', before.district) as string | null,
        state: pick('state', before.state) as string | null,
        pincode: pick('pincode', before.pincode) as string | null,
        occupation: pick('occupation', before.occupation) as string | null,
        employer_business_name: pick('employerBusinessName', before.employer_business_name) as string | null,
        business_type: pick('businessType', before.business_type) as string | null,
        monthly_income: pick('monthlyIncome', before.monthly_income) as string | null,
        work_address: pick('workAddress', before.work_address) as string | null,
        whatsapp_opt_in: pick('whatsappOptIn', before.whatsapp_opt_in) as boolean,
        status: pick('status', before.status) as string,
      };
      const d = diff(before, next);
      if (!d.changed) return { id, version: before.version };
      const optInChanged = next.whatsapp_opt_in !== before.whatsapp_opt_in;
      const row = await tx
        .updateTable('customers')
        .set({
          ...next,
          ...(optInChanged ? { whatsapp_opt_in_at: next.whatsapp_opt_in ? new Date() : null } : {}),
          version: before.version + 1,
          updated_at: new Date(),
          updated_by: ctx.auth.userId,
        })
        .where('id', '=', id)
        .returning('version')
        .executeTakeFirstOrThrow();
      await this.event(tx, id, ctx.auth.userId, 'CUSTOMER_UPDATED', `Updated: ${Object.keys(d.newValues).join(', ')}`);
      if (optInChanged) {
        await this.event(tx, id, ctx.auth.userId, next.whatsapp_opt_in ? 'WHATSAPP_OPT_IN' : 'WHATSAPP_OPT_OUT', next.whatsapp_opt_in ? 'WhatsApp consent recorded' : 'WhatsApp consent withdrawn');
      }
      await this.audit.record(tx, ctx, {
        action: 'customer.updated',
        entityType: 'customer',
        entityId: id,
        branchId: next.branch_id,
        oldValues: d.oldValues,
        newValues: d.newValues,
      });
      return { id, version: row.version };
    });
  }

  async upsertKyc(ctx: RequestContext, id: string, kyc: KycInput) {
    try {
      return await this.db.transaction().execute(async (tx) => {
        const c = await this.loadScoped(tx, ctx.auth, id);
        const changed = await this.writeKyc(tx, id, ctx.auth.userId, kyc);
        const status = await this.refreshKycStatus(tx, id);
        if (changed.length) {
          await this.event(tx, id, ctx.auth.userId, 'KYC_UPDATED', `KYC updated: ${changed.join(', ')}`);
          await this.audit.record(tx, ctx, {
            action: 'customer.kyc_updated',
            entityType: 'customer',
            entityId: id,
            branchId: c.branch_id,
            newValues: { docTypes: changed, kycStatus: status },
          });
        }
        return { changed, kycStatus: status };
      });
    } catch (e) {
      this.rethrowDuplicate(e);
    }
  }

  async verifyKyc(ctx: RequestContext, id: string, docType: KycType, method: string) {
    return this.db.transaction().execute(async (tx) => {
      const c = await this.loadScoped(tx, ctx.auth, id);
      const r = await tx
        .updateTable('customer_kyc_documents')
        .set({ verified_at: new Date(), verified_by: ctx.auth.userId, verification_method: method, updated_at: new Date() })
        .where('customer_id', '=', id)
        .where('doc_type', '=', docType)
        .executeTakeFirst();
      if (Number(r.numUpdatedRows) === 0) throw notFound(`${docType} record`);
      const status = await this.refreshKycStatus(tx, id);
      await this.event(tx, id, ctx.auth.userId, 'KYC_VERIFIED', `${docType} verified (${method})`);
      await this.audit.record(tx, ctx, {
        action: 'customer.kyc_verified',
        entityType: 'customer',
        entityId: id,
        branchId: c.branch_id,
        newValues: { docType, method, kycStatus: status },
      });
      return { kycStatus: status };
    });
  }

  /** Full identifier, only with kyc.reveal + recent re-authentication. Every reveal is audited. */
  async revealKyc(ctx: RequestContext, id: string, docType: KycType) {
    if (docType === 'AADHAAR') throw unprocessable('NOT_STORED', 'Full Aadhaar numbers are never stored');
    return this.db.transaction().execute(async (tx) => {
      const c = await this.loadScoped(tx, ctx.auth, id);
      const doc = await tx
        .selectFrom('customer_kyc_documents')
        .select('number_enc')
        .where('customer_id', '=', id)
        .where('doc_type', '=', docType)
        .executeTakeFirst();
      if (!doc?.number_enc) throw notFound(`${docType} record`);
      await this.audit.record(tx, ctx, {
        action: 'customer.kyc_revealed',
        entityType: 'customer',
        entityId: id,
        branchId: c.branch_id,
        newValues: { docType },
      });
      return { docType, value: this.crypto.decrypt(doc.number_enc, kycAad(docType)) };
    });
  }

  /* ------------------------------ search ------------------------------ */

  /**
   * Global search (doc 01 §8). Detects the kind of term and uses the matching index:
   * mobile → btree, PAN/DL/Voter → blind index, Aadhaar last-4 → partial index, name → trigram.
   */
  async search(auth: AuthContext, term: string, limit: number) {
    const t = term.trim();
    const upper = normaliseId(t);
    const digits = t.replace(/\D/g, '');
    let base = this.scoped(this.db, auth).select([
      'c.id',
      'c.customer_no',
      'c.full_name',
      'c.mobile',
      'c.village_town',
      'c.kyc_status',
      'c.status',
      'b.code as branch_code',
    ]);
    let matchedBy: string;

    if (/^[A-Z]{5}\d{4}[A-Z]$/.test(upper)) {
      matchedBy = 'PAN';
      const bidx = this.crypto.blindIndex('PAN', upper);
      base = base.where('c.id', 'in', (eb) =>
        eb.selectFrom('customer_kyc_documents').select('customer_id').where('doc_type', '=', 'PAN').where('number_bidx', '=', bidx),
      );
    } else if (/^[\d\s+-]+$/.test(t) && /^[6-9]\d{9}$/.test(digits.replace(/^(91|0)(?=\d{10}$)/, ''))) {
      matchedBy = 'MOBILE';
      const m = digits.slice(-10);
      base = base.where((eb) => eb.or([eb('c.mobile', '=', m), eb('c.alt_mobile', '=', m)]));
    } else if (/^\d{4}$/.test(t)) {
      matchedBy = 'AADHAAR_LAST4_OR_MOBILE';
      base = base.where((eb) =>
        eb.or([
          eb('c.id', 'in', eb.selectFrom('customer_kyc_documents').select('customer_id').where('doc_type', '=', 'AADHAAR').where('number_last4', '=', t)),
          eb('c.mobile', 'like', `%${t}`),
        ]),
      );
    } else if (/^CUST/i.test(t) || /^[A-Z]{2,5}[-/]\d/i.test(t)) {
      matchedBy = 'CUSTOMER_NO';
      base = base.where('c.customer_no', 'ilike', `${t.replace(/[%_\\]/g, '')}%`);
    } else if (/^[A-Z0-9]{8,20}$/.test(upper) && /\d/.test(upper)) {
      matchedBy = 'ID_DOCUMENT';
      base = base.where('c.id', 'in', (eb) =>
        eb
          .selectFrom('customer_kyc_documents')
          .select('customer_id')
          .where((w) =>
            w.or([
              w.and([w('doc_type', '=', 'DRIVING_LICENCE'), w('number_bidx', '=', this.crypto.blindIndex('DRIVING_LICENCE', upper))]),
              w.and([w('doc_type', '=', 'VOTER_ID'), w('number_bidx', '=', this.crypto.blindIndex('VOTER_ID', upper))]),
            ]),
          ),
      );
    } else {
      matchedBy = 'NAME';
      const clean = t.replace(/[%_\\]/g, '');
      base = base
        // `%` = whole-name similarity (typos); `<%` = best-matching part of the name (partial input
        // like "lakshmi r"). Both use the trigram GIN index.
        .where((eb) =>
          eb.or([eb('c.full_name', 'ilike', `%${clean}%`), sql<boolean>`c.full_name % ${clean}`, sql<boolean>`${clean} <% c.full_name`]),
        )
        .orderBy(sql`greatest(similarity(c.full_name, ${clean}), word_similarity(${clean}, c.full_name))`, 'desc');
    }

    const rows = await base.orderBy('c.id', 'desc').limit(limit).execute();
    return {
      matchedBy,
      data: rows.map((r) => ({
        type: 'customer' as const,
        id: r.id,
        customerNo: r.customer_no,
        fullName: r.full_name,
        mobile: this.mobile(auth, r.mobile),
        villageTown: r.village_town,
        branchCode: r.branch_code,
        kycStatus: r.kyc_status,
        status: r.status,
        // Loan summary (active loan → outstanding → next due) is added in Phase 3.
        activeLoan: null,
      })),
    };
  }
}
