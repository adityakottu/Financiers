import { randomUUID } from 'node:crypto';
import { hashPassword } from '../auth/password';
import { CryptoService } from '../common/crypto.service';
import { loadConfig } from '../config/config';
import { NumberingService } from '../numbering/numbering.service';
import { createDb } from './db';
import { seed } from './seed';

/**
 * Synthetic demo data for local development and UI review (doc 12 §9).
 * Names, numbers and addresses are fictional. Refuses to run in production.
 */
const FIRST = ['Venkata', 'Srinivas', 'Lakshmi', 'Ramesh', 'Durga', 'Satyanarayana', 'Padma', 'Nagaraju', 'Sridevi', 'Suresh', 'Anjali', 'Chandra', 'Kishore', 'Bhavani', 'Prasad', 'Madhavi', 'Raju', 'Sunitha', 'Gopal', 'Vijaya'];
const LAST = ['Rao', 'Reddy', 'Naidu', 'Varma', 'Chowdary', 'Kumar', 'Devi', 'Murthy', 'Sastry', 'Babu'];
const PLACES: [string, string, string, string][] = [
  ['Pithapuram', 'Pithapuram', 'Kakinada', '533450'],
  ['Samalkot', 'Samalkot', 'Kakinada', '533440'],
  ['Peddapuram', 'Peddapuram', 'Kakinada', '533437'],
  ['Tuni', 'Tuni', 'Kakinada', '533401'],
  ['Kadiyam', 'Kadiyam', 'East Godavari', '533126'],
  ['Mandapeta', 'Mandapeta', 'Konaseema', '533308'],
  ['Kovvur', 'Kovvur', 'East Godavari', '534350'],
];
const JOBS = ['Auto driver', 'Kirana shop owner', 'Farmer', 'Tailor', 'Lorry owner', 'Teacher', 'Electrician', 'Vegetable vendor', 'Mechanic', 'Daily wage worker'];

const pick = <T>(a: T[], i: number) => a[i % a.length]!;

async function main() {
  const config = loadConfig();
  if (config.production) throw new Error('Refusing to load demo data in production');
  const demoPassword = process.env.DEMO_PASSWORD;
  if (!demoPassword) throw new Error('DEMO_PASSWORD is required');
  const db = createDb(config.databaseUrl, 2);
  const crypto = new CryptoService(config);
  const numbering = new NumberingService();

  await seed(db, {
    adminUsername: process.env.SEED_ADMIN_USERNAME ?? 'admin',
    adminPassword: process.env.SEED_ADMIN_PASSWORD ?? demoPassword,
    companyName: 'Godavari Finance Pvt Ltd',
  });

  await db.transaction().execute(async (tx) => {
    const company = await tx.selectFrom('companies').select('id').executeTakeFirstOrThrow();
    await tx
      .updateTable('companies')
      .set({ trade_name: 'Godavari Finance', address: 'Main Road, Kakinada, Andhra Pradesh 533001', phone: '0884-2345678', receipt_footer: 'Thank you. Please keep this receipt for your records.' })
      .execute();
    for (const [code, name] of [
      ['KKD', 'Kakinada'],
      ['RJY', 'Rajahmundry'],
    ]) {
      await tx.insertInto('branches').values({ company_id: company.id, code: code!, name: name!, address: `${name}, Andhra Pradesh` }).onConflict((oc) => oc.column('code').doNothing()).execute();
    }
    const branches = await tx.selectFrom('branches').select(['id', 'code']).execute();
    const byCode = Object.fromEntries(branches.map((b) => [b.code, b.id]));
    const roles = Object.fromEntries((await tx.selectFrom('roles').select(['id', 'code']).execute()).map((r) => [r.code, r.id]));
    const hash = await hashPassword(demoPassword);

    const users: [string, string, string, string[]][] = [
      ['manager.kkd', 'Ravi Shankar', 'BRANCH_MANAGER', ['KKD']],
      ['manager.rjy', 'Sarada Devi', 'BRANCH_MANAGER', ['RJY']],
      ['collector.kkd', 'Naresh Babu', 'COLLECTION_EMPLOYEE', ['KKD']],
    ];
    for (const [username, fullName, role, bcodes] of users) {
      const exists = await tx.selectFrom('users').select('id').where('username', '=', username).executeTakeFirst();
      if (exists) continue;
      const u = await tx.insertInto('users').values({ username, full_name: fullName, password_hash: hash, must_change_password: false }).returning('id').executeTakeFirstOrThrow();
      await tx.insertInto('user_roles').values({ user_id: u.id, role_id: roles[role]! }).execute();
      for (const bc of bcodes) await tx.insertInto('user_branches').values({ user_id: u.id, branch_id: byCode[bc]! }).execute();
      await tx
        .insertInto('employees')
        .values({ branch_id: byCode[bcodes[0]!]!, user_id: u.id, employee_code: `E-${username.split('.')[0]!.slice(0, 3).toUpperCase()}${bcodes[0]}`, full_name: fullName, designation: role === 'BRANCH_MANAGER' ? 'Branch Manager' : 'Field Officer', is_collector: role === 'COLLECTION_EMPLOYEE', mobile: '98480' + String(Math.floor(10000 + Math.random() * 89999)) })
        .onConflict((oc) => oc.column('employee_code').doNothing())
        .execute();
    }

    const existing = await tx.selectFrom('customers').select((eb) => eb.fn.countAll<string>().as('n')).executeTakeFirstOrThrow();
    if (Number(existing.n) > 0) return;
    const creator = await tx.selectFrom('users').select('id').where('username', '=', 'manager.kkd').executeTakeFirstOrThrow();
    for (let i = 0; i < 36; i++) {
      const branchCode = i % 3 === 2 ? 'RJY' : 'KKD';
      const [town, mandal, district, pin] = pick(PLACES, i * 7);
      const fullName = `${pick(FIRST, i * 3)} ${pick(LAST, i * 5)}`;
      const customerNo = await numbering.next(tx, 'CUSTOMER', { branchCode });
      const c = await tx
        .insertInto('customers')
        .values({
          id: undefined,
          customer_no: customerNo,
          branch_id: byCode[branchCode]!,
          full_name: fullName,
          relation_type: i % 4 === 1 ? 'W/O' : 'S/O',
          relation_name: `${pick(FIRST, i + 4)} ${pick(LAST, i * 5)}`,
          gender: i % 4 === 1 || i % 5 === 2 ? 'FEMALE' : 'MALE',
          dob: `19${70 + (i % 25)}-0${(i % 9) + 1}-1${i % 9}`,
          mobile: `9${String(700000000 + i * 1234567).slice(0, 9)}`,
          address_line1: `${10 + i}-${(i % 7) + 1}-${i + 3}, ${pick(['Gandhi Nagar', 'Ramalayam Street', 'Main Road', 'Rice Mill Road'], i)}`,
          village_town: town,
          mandal,
          district,
          state: 'Andhra Pradesh',
          pincode: pin,
          occupation: pick(JOBS, i),
          monthly_income: String(12000 + (i % 9) * 3500),
          whatsapp_opt_in: i % 3 !== 0,
          whatsapp_opt_in_at: i % 3 !== 0 ? new Date() : null,
          kyc_status: i % 4 === 0 ? 'VERIFIED' : i % 4 === 3 ? 'PENDING' : 'PARTIAL',
          created_by: creator.id,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      if (i % 4 !== 3) {
        const pan = `ABCPR${String(1000 + i).padStart(4, '0')}${String.fromCharCode(65 + (i % 26))}`;
        const verified = i % 4 === 0 ? new Date() : null;
        await tx
          .insertInto('customer_kyc_documents')
          .values([
            { customer_id: c.id, doc_type: 'PAN', number_enc: crypto.encrypt(pan, 'customer_kyc.PAN'), number_last4: pan.slice(-4), number_bidx: crypto.blindIndex('PAN', pan), key_version: 1, verified_at: verified, verified_by: verified ? creator.id : null, verification_method: verified ? 'Original document seen' : null },
            { customer_id: c.id, doc_type: 'AADHAAR', number_last4: String(1000 + ((i * 373) % 9000)), verified_at: verified, verified_by: verified ? creator.id : null, verification_method: verified ? 'Original document seen' : null },
          ])
          .execute();
      }
      await tx.insertInto('customer_references').values({ customer_id: c.id, name: `${pick(FIRST, i + 9)} ${pick(LAST, i + 2)}`, relationship: pick(['Brother', 'Neighbour', 'Employer', 'Cousin'], i), mobile: `8${String(500000000 + i * 7654321).slice(0, 9)}` }).execute();
      await tx.insertInto('customer_events').values({ customer_id: c.id, actor_id: creator.id, event_type: 'CUSTOMER_CREATED', summary: `Customer ${customerNo} created` }).execute();
    }
    await tx.insertInto('audit_logs').values({ action: 'system.demo_data_loaded', request_id: randomUUID(), hash: Buffer.alloc(0) }).execute();
  });
  await db.destroy();
  console.log('demo data loaded');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
