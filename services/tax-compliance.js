/**
 * Tax compliance helpers.
 * Uses @atlantist/core when installed; built-in fallback otherwise.
 * Treaty tables and withholding logic are in @atlantist/core (private).
 */
'use strict';

let _core = null;
try { _core = require('@atlantist/core').tax; } catch { /* not installed yet */ }

if (_core) {
  module.exports = _core;
} else {
  // Fallback — sufficient for runtime operation; full treaty logic in @atlantist/core
  const BACKUP_WITHHOLDING_RATE  = 0.24;
  const NRA_DEFAULT_RATE         = 0.30;
  const IRS_1099_THRESHOLD_CENTS = 60000;
  const FATCA_THRESHOLD_CENTS    = 5000000;

  module.exports = {
    BACKUP_WITHHOLDING_RATE, NRA_DEFAULT_RATE,
    IRS_1099_THRESHOLD_CENTS, FATCA_THRESHOLD_CENTS,
    TREATY_RATES: {},
    getWithholdingRate(c) {
      if (!c.tax_form_status || c.tax_form_status === 'not_submitted')
        return { rate: BACKUP_WITHHOLDING_RATE, reason: 'backup_withholding_no_form' };
      if (c.is_us_person && c.tax_form_status === 'verified')
        return { rate: 0, reason: 'us_person_valid_w9' };
      if (!c.is_us_person && (c.tax_form_status === 'w8ben_submitted' || c.tax_form_status === 'verified'))
        return { rate: NRA_DEFAULT_RATE, reason: 'nra_withholding' };
      return { rate: BACKUP_WITHHOLDING_RATE, reason: 'backup_withholding_pending' };
    },
    calculateNetPayout(grossCents, rate) {
      const withheldCents = Math.floor(grossCents * rate);
      return { grossCents, withheldCents, netCents: grossCents - withheldCents };
    },
    needs1099(c) { return !!(c.is_us_person && (c.ytd_payout_cents || 0) >= IRS_1099_THRESHOLD_CENTS); },
    needsFATCAReport(c) { return !!(c.is_us_person === false && (c.ytd_payout_cents || 0) >= FATCA_THRESHOLD_CENTS); },
    isW8BENExpired(c) {
      if (!c.w8ben_signed_at) return true;
      const exp = new Date(c.w8ben_signed_at);
      exp.setFullYear(exp.getFullYear() + 3);
      return new Date() > exp;
    },
    getStateFlag() { return null; },
  };
}
