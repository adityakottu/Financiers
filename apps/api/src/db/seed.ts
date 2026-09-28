import { PERMISSIONS, SYSTEM_ROLES, passwordProblems } from '@fin/contracts';
import { sql } from 'kysely';
import { hashPassword } from '../auth/password';
import { createDb, Db } from './db';
import { ensureBranchAccounts } from '../ledger/ledger.service';

export const DEFAULT_NUMBERING: Record<string, string> = {
  CUSTOMER: 'CUST-{FY}-{SEQ:6}',
  LOAN: 'LN-{BR}-{FY}-{SEQ:6}',
  RECEIPT: 'REC-{BR}-{FY}-{SEQ:6}',
  PAYMENT: 'PAY-{FY}-{SEQ:6}',
  JOURNAL: 'JE-{FY}-{SEQ:6}',
  EXPENSE: 'EXP-{FY}-{SEQ:6}',
  ASSET: 'AST-{FY}-{SEQ:6}',
};

/** Reference data that must match the code: permissions, system roles and their grants. Safe to re-run. */
export async function syncReferenceData(db: Db) {
  await db.transaction().execute(async (tx) => {
    for (const [code, description] of Object.entries(PERMISSIONS)) {
      await tx
        .insertInto('permissions')
        .values({ code, description })
        .onConflict((oc) => oc.column('code').doUpdateSet({ description }))
        .execute();
    }
    for (const role of SYSTEM_ROLES) {
      const row = await tx
        .insertInto('roles')
        .values({ code: role.code, name: role.name, scope: role.scope, mfa_required: role.mfaRequired, is_system: true })
        .onConflict((oc) =>
          oc.column('code').doUpdateSet({ name: role.name, scope: role.scope, mfa_required: role.mfaRequired }),
        )
        .returning('id')
        .executeTakeFirstOrThrow();
      await tx.deleteFrom('role_permissions').where('role_id', '=', row.id).execute();
      await tx
        .insertInto('role_permissions')
        .values(role.permissions.map((p) => ({ role_id: row.id, permission_code: p })))
        .execute();
    }
    for (const b of await tx.selectFrom('branches').select(['id', 'code', 'name']).execute()) {
      await ensureBranchAccounts(tx, b);
    }
    for (const [seqType, format] of Object.entries(DEFAULT_NUMBERING)) {
      await tx
        .insertInto('numbering_formats')
        .values({ seq_type: seqType, format })
        .onConflict((oc) => oc.column('seq_type').doNothing())
        .execute();
    }
  });
}

export async function seed(db: Db, opts: { adminUsername: string; adminPassword: string; companyName: string }) {
  await syncReferenceData(db);
  await db.transaction().execute(async (tx) => {
    let company = await tx.selectFrom('companies').select('id').executeTakeFirst();
    if (!company) {
      company = await tx
        .insertInto('companies')
        .values({ legal_name: opts.companyName })
        .returning('id')
        .executeTakeFirstOrThrow();
    }
    const hq = await tx
      .insertInto('branches')
      .values({ company_id: company.id, code: 'HQ', name: 'Head Office' })
      .onConflict((oc) => oc.column('code').doNothing())
      .returning('id')
      .executeTakeFirst();

    for (const b of await tx.selectFrom('branches').select(['id', 'code', 'name']).execute()) {
      await ensureBranchAccounts(tx, b);
    }
    const existingAdmin = await tx
      .selectFrom('user_roles as ur')
      .innerJoin('roles as r', 'r.id', 'ur.role_id')
      .select('ur.user_id')
      .where('r.code', '=', 'SUPER_ADMIN')
      .executeTakeFirst();
    if (existingAdmin) return;

    const problems = passwordProblems(opts.adminPassword, opts.adminUsername);
    if (problems.length) throw new Error(`SEED_ADMIN_PASSWORD is too weak: ${problems.join('; ')}`);
    const admin = await tx
      .insertInto('users')
      .values({
        username: opts.adminUsername,
        full_name: 'System Administrator',
        password_hash: await hashPassword(opts.adminPassword),
        must_change_password: true,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const role = await tx.selectFrom('roles').select('id').where('code', '=', 'SUPER_ADMIN').executeTakeFirstOrThrow();
    await tx.insertInto('user_roles').values({ user_id: admin.id, role_id: role.id }).execute();
    const branchId = hq?.id ?? (await tx.selectFrom('branches').select('id').where('code', '=', 'HQ').executeTakeFirstOrThrow()).id;
    await tx.insertInto('user_branches').values({ user_id: admin.id, branch_id: branchId }).execute();
    await tx
      .insertInto('audit_logs')
      .values({
        action: 'system.seed_admin',
        entity_type: 'user',
        entity_id: admin.id,
        new_values: sql`jsonb_build_object('username', ${opts.adminUsername}::text)`,
        hash: Buffer.alloc(0),
      })
      .execute();
  });
}

if (require.main === module) {
  const url = process.env.DATABASE_URL;
  const adminPassword = process.env.SEED_ADMIN_PASSWORD;
  if (!url) throw new Error('DATABASE_URL is required');
  if (!adminPassword) throw new Error('SEED_ADMIN_PASSWORD is required (it must be changed at first login)');
  const db = createDb(url, 2);
  seed(db, {
    adminUsername: process.env.SEED_ADMIN_USERNAME ?? 'admin',
    adminPassword,
    companyName: process.env.SEED_COMPANY_NAME ?? 'Financiers Pvt Ltd',
  })
    .then(() => console.log('seed complete'))
    .catch((e) => {
      console.error(e);
      process.exitCode = 1;
    })
    .finally(() => db.destroy());
}
