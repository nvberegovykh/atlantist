/**
 * Tax compliance for Atlantist contributor payouts.
 *
 * US rules:
 * - W-9 required for all US persons before payout
 * - 1099-NEC required for US persons paid >= $600/year (non-employee compensation)
 * - Backup withholding: 24% if W-9 not submitted or TIN invalid
 *
 * International rules:
 * - W-8BEN required for foreign individuals before payout
 * - Default withholding: 30% on US-source income (NRA withholding)
 * - Treaty rates: varies by country (see TREATY_RATES below)
 * - W-8BEN expires 3 years after signing year; must be renewed
 * - FATCA: report foreign accounts with $50k+ annual payments
 *
 * State rules (US):
 * - We do NOT withhold state income tax (contributor handles state filing)
 * - We flag states with mandatory state withholding for reference
 * - Documentation only — we note the state obligation in payout records
 */
'use strict';

// US income tax treaty withholding rates on royalties/services income
// Source: IRS Publication 901
const TREATY_RATES = {
  CA: 0.00, // Canada — 0% under treaty Art. XII (services)
  GB: 0.00, // UK — 0% under treaty
  DE: 0.00, // Germany — 0%
  FR: 0.00, // France — 0%
  AU: 0.00, // Australia — 0%
  NL: 0.00, // Netherlands — 0%
  SE: 0.00, // Sweden — 0%
  CH: 0.00, // Switzerland — 0%
  JP: 0.10, // Japan — 10%
  IN: 0.15, // India — 15%
  CN: 0.10, // China — 10%
  MX: 0.10, // Mexico — 10%
  BR: 0.15, // Brazil — no treaty, standard 30% applies — flag for review
  RU: 0.00, // Russia — treaty suspended 2023, use 30%
  // Default for unlisted: 0.30 (30% NRA withholding)
};

// States with mandatory withholding on non-employee compensation
const MANDATORY_STATE_WITHHOLDING = {
  CA: { rate: 0.07, note: 'California: 7% mandatory backup withholding on non-employee comp over $1,500/year' },
  CT: { rate: 0.065, note: 'Connecticut: 6.5% withholding required' },
  ME: { rate: 0.05, note: 'Maine: 5% withholding on non-resident payments' },
  VT: { rate: 0.0666, note: 'Vermont: 6.66% withholding' },
};

/**
 * Determine the applicable withholding rate for a contributor.
 * @param {object} contributor - Contributor row from DB
 * @returns {{ rate: number, reason: string, requiresAction?: string, note1099?: boolean, fatcaFlag?: boolean }}
 */
function getWithholdingRate(contributor) {
  // No tax form = backup withholding
  if (!contributor.tax_form_status || contributor.tax_form_status === 'not_submitted') {
    return { rate: 0.24, reason: 'backup_withholding_no_form', requiresAction: 'submit_w9_or_w8ben' };
  }

  if (contributor.is_us_person) {
    // US person with valid W-9
    if (contributor.tax_form_status === 'verified') {
      return { rate: 0.00, reason: 'us_person_valid_w9', note1099: contributor.ytd_payout_cents >= 60000 };
    }
    // W-9 pending verification
    return { rate: 0.24, reason: 'backup_withholding_pending_verification' };
  } else {
    // Foreign person
    if (contributor.tax_form_status === 'w8ben_submitted' || contributor.tax_form_status === 'verified') {
      const country = contributor.tax_country || 'XX';
      const treatyRate = TREATY_RATES.hasOwnProperty(country) ? TREATY_RATES[country] : 0.30;
      // Special case: Russia treaty suspended 2023
      const effectiveRate = (country === 'RU') ? 0.30 : treatyRate;
      return {
        rate: effectiveRate,
        reason: `treaty_${country}`,
        fatcaFlag: contributor.ytd_payout_cents >= 5000000 // $50k FATCA threshold
      };
    }
    // No W-8BEN = 30% NRA withholding
    return { rate: 0.30, reason: 'nra_withholding_no_w8ben', requiresAction: 'submit_w8ben' };
  }
}

/**
 * Calculate gross, withheld, and net payout amounts.
 * @param {number} grossCents
 * @param {number} withholdingRate - e.g. 0.24 for 24%
 * @returns {{ grossCents: number, withheldCents: number, netCents: number }}
 */
function calculateNetPayout(grossCents, withholdingRate) {
  const withheld = Math.floor(grossCents * withholdingRate);
  const net = grossCents - withheld;
  return { grossCents, withheldCents: withheld, netCents: net };
}

/**
 * Determine whether a 1099-NEC is required for a US contributor.
 * Threshold: $600 (60000 cents) in a calendar year.
 * @param {object} contributor
 * @returns {boolean}
 */
function needs1099(contributor) {
  return !!(contributor.is_us_person && contributor.ytd_payout_cents >= 60000);
}

/**
 * Check whether a W-8BEN has expired.
 * W-8BEN expires at end of the 3rd year after the year of signing.
 * e.g. signed Jan 2024 → expires Dec 31, 2026.
 * @param {object} contributor - must have w8ben_signed_at field
 * @returns {{ expired: boolean, expiryDate?: Date }}
 */
function checkW8BENExpiry(contributor) {
  if (!contributor.w8ben_signed_at) return { expired: false };
  const signed = new Date(contributor.w8ben_signed_at);
  const expiryYear = signed.getFullYear() + 3;
  const expiry = new Date(expiryYear, 11, 31); // Dec 31
  return { expired: new Date() > expiry, expiryDate: expiry };
}

/**
 * Return state withholding note for a US state, if applicable.
 * @param {string} usState - Two-letter state code
 * @returns {{ rate: number, note: string } | null}
 */
function getStateWithholdingNote(usState) {
  return MANDATORY_STATE_WITHHOLDING[usState] || null;
}

module.exports = {
  getWithholdingRate,
  calculateNetPayout,
  needs1099,
  checkW8BENExpiry,
  getStateWithholdingNote,
  TREATY_RATES
};
