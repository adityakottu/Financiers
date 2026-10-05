/**
 * The migration templates (doc 15, Phase 9). One header row; the column names below (case and a
 * trailing * ignored). A column that is not listed is refused — in particular there is no column
 * for Aadhaar / PAN / other ID numbers: KYC is collected in the app, never bulk-loaded (doc 11).
 */
export interface ImportColumn {
  key: string;
  header: string;
  required: boolean;
  note: string;
  example: string;
}

export const CUSTOMER_COLUMNS: ImportColumn[] = [
  { key: 'legacyNo', header: 'legacy_no', required: true, note: 'The customer’s number in the old system. Unique; stays searchable.', example: 'OLD-C-0042' },
  { key: 'branchCode', header: 'branch_code', required: true, note: 'Branch code as set up in the app (e.g. KKD).', example: 'KKD' },
  { key: 'fullName', header: 'full_name', required: true, note: 'As on the ID document.', example: 'Venkata Rao Kandula' },
  { key: 'mobile', header: 'mobile', required: true, note: '10-digit Indian mobile.', example: '9848012345' },
  { key: 'relationType', header: 'relation_type', required: false, note: 'S/O, D/O, W/O or C/O.', example: 'S/O' },
  { key: 'relationName', header: 'relation_name', required: false, note: 'Father’s / husband’s name.', example: 'Kandula Ramaiah' },
  { key: 'dob', header: 'dob', required: false, note: 'Date of birth, DD/MM/YYYY.', example: '14/08/1986' },
  { key: 'gender', header: 'gender', required: false, note: 'MALE, FEMALE or OTHER.', example: 'MALE' },
  { key: 'altMobile', header: 'alt_mobile', required: false, note: 'Second mobile.', example: '' },
  { key: 'addressLine1', header: 'address_line1', required: false, note: 'House / street.', example: '2-14, Main Road' },
  { key: 'addressLine2', header: 'address_line2', required: false, note: '', example: '' },
  { key: 'villageTown', header: 'village_town', required: false, note: '', example: 'Pithapuram' },
  { key: 'mandal', header: 'mandal', required: false, note: '', example: 'Pithapuram' },
  { key: 'district', header: 'district', required: false, note: '', example: 'Kakinada' },
  { key: 'state', header: 'state', required: false, note: '', example: 'Andhra Pradesh' },
  { key: 'pincode', header: 'pincode', required: false, note: '6 digits.', example: '533450' },
  { key: 'occupation', header: 'occupation', required: false, note: '', example: 'Auto driver' },
  { key: 'whatsappOptIn', header: 'whatsapp_opt_in', required: false, note: 'Y only if the customer agreed in writing to WhatsApp messages ⚖.', example: 'N' },
];

export const LOAN_COLUMNS: ImportColumn[] = [
  { key: 'legacyNo', header: 'legacy_loan_no', required: true, note: 'The loan’s number in the old system. Unique; stays searchable.', example: 'OLD-L-1187' },
  { key: 'customerRef', header: 'customer_ref', required: true, note: 'The customer’s legacy_no (imported first) or their customer number in the app.', example: 'OLD-C-0042' },
  { key: 'productCode', header: 'product_code', required: true, note: 'Product code in the app. Use a product whose limits fit the old loans (e.g. a LEGACY product per category).', example: 'TW-STD' },
  { key: 'principal', header: 'principal', required: true, note: 'Amount financed, rupees.', example: '60000' },
  { key: 'annualRate', header: 'annual_rate', required: true, note: 'Annual rate %, as the product’s method expects (flat or reducing).', example: '24' },
  { key: 'frequency', header: 'frequency', required: true, note: 'MONTHLY, WEEKLY, DAILY, FORTNIGHTLY or CUSTOM.', example: 'MONTHLY' },
  { key: 'customIntervalDays', header: 'custom_interval_days', required: false, note: 'Only for CUSTOM.', example: '' },
  { key: 'numInstallments', header: 'installments', required: true, note: 'Number of installments.', example: '18' },
  { key: 'disbursementDate', header: 'disbursement_date', required: true, note: 'DD/MM/YYYY; before the cut-over date.', example: '05/01/2026' },
  { key: 'firstDueDate', header: 'first_due_date', required: true, note: 'DD/MM/YYYY.', example: '05/02/2026' },
  { key: 'installmentAmount', header: 'installment_amount', required: false, note: 'The old system’s installment. If given, it must equal the app’s schedule.', example: '4333' },
  { key: 'installmentsPaid', header: 'installments_paid', required: true, note: 'Installments fully paid by the cut-over date.', example: '7' },
  { key: 'partPaid', header: 'part_paid', required: false, note: 'Amount paid towards the next installment (fees, then interest, then principal).', example: '1000' },
  { key: 'principalOutstanding', header: 'principal_outstanding', required: true, note: 'Principal outstanding in the old ledger at cut-over. Must equal the app’s figure.', example: '38512' },
  { key: 'penaltyOutstanding', header: 'penalty_outstanding', required: false, note: 'Unpaid penal charges at cut-over (needs an overdue installment).', example: '0' },
  { key: 'assetDescription', header: 'asset_description', required: false, note: 'For electronics.', example: '' },
  { key: 'assetMake', header: 'asset_make', required: false, note: '', example: 'Hero' },
  { key: 'assetModel', header: 'asset_model', required: false, note: '', example: 'Splendor Plus' },
  { key: 'manufactureYear', header: 'manufacture_year', required: false, note: '', example: '2025' },
  { key: 'registrationNo', header: 'registration_no', required: false, note: 'Like AP05AB1234.', example: 'AP05AB1234' },
  { key: 'chassisNo', header: 'chassis_no', required: false, note: '', example: 'MBLHAW123RHA00001' },
  { key: 'engineNo', header: 'engine_no', required: false, note: '', example: 'HA11EAR1234' },
  { key: 'serialNo', header: 'serial_no', required: false, note: 'For electronics.', example: '' },
  { key: 'assetValue', header: 'asset_value', required: false, note: 'Valuation at the time of the loan (for the product’s LTV check).', example: '90000' },
];

export const PARALLEL_COLUMNS: ImportColumn[] = [
  { key: 'loanRef', header: 'loan_ref', required: true, note: 'The loan’s legacy number or its loan number in the app.', example: 'OLD-L-1187' },
  { key: 'amount', header: 'amount', required: true, note: 'Amount collected, rupees.', example: '4333' },
  { key: 'method', header: 'method', required: true, note: 'CASH, UPI, BANK_TRANSFER or CHEQUE.', example: 'CASH' },
  { key: 'receiptNo', header: 'receipt_no', required: false, note: 'The old process’s receipt number.', example: 'BK-12/0457' },
  { key: 'collector', header: 'collector', required: false, note: 'Who collected (for your reference).', example: 'Ravi' },
];

export const COLUMNS = { CUSTOMERS: CUSTOMER_COLUMNS, LOANS: LOAN_COLUMNS, PARALLEL: PARALLEL_COLUMNS } as const;

/**
 * Map the header row to column keys. Returns the key for each position, or the file-level problems
 * (unknown or missing columns, duplicates).
 */
export function mapHeader(header: string[], cols: ImportColumn[]): { keys: (string | null)[]; problems: string[] } {
  const byName = new Map(cols.map((c) => [c.header, c]));
  const problems: string[] = [];
  const seen = new Set<string>();
  const keys = header.map((h) => {
    const name = h.trim().replace(/\*$/, '').trim().toLowerCase().replace(/\s+/g, '_');
    if (name === '') return null;
    const col = byName.get(name);
    if (!col) {
      problems.push(
        /a+dh?a+r|(^|_)pan($|_)|voter|licen[cs]e|passport|kyc/.test(name)
          ? `Column "${h}" is not accepted: ID numbers are never bulk-imported. Collect KYC in the app.`
          : `Column "${h}" is not part of the template`,
      );
      return null;
    }
    if (seen.has(col.key)) problems.push(`Column "${h}" appears twice`);
    seen.add(col.key);
    return col.key;
  });
  for (const c of cols) if (c.required && !seen.has(c.key)) problems.push(`Required column "${c.header}" is missing`);
  return { keys, problems };
}
