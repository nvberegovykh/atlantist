/**
 * Tax compliance — implementation in @atlantist/core (private).
 * Treaty rates, withholding logic, FATCA thresholds are private.
 */
'use strict';
let _impl;
try {
  _impl = require('@atlantist/core').tax;
} catch {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('[tax-compliance] @atlantist/core required in production.');
  }
  // Dev stub
  _impl = {
    getWithholdingRate: () => ({ rate: 0, reason: 'dev_stub' }),
    calculateNetPayout: (grossCents) => ({ grossCents, withheldCents: 0, netCents: grossCents }),
    needs1099: () => false,
    needsFATCAReport: () => false,
    isW8BENExpired: () => false,
    getStateFlag: () => null,
    TREATY_RATES: {},
    BACKUP_WITHHOLDING_RATE: 0.24,
    NRA_DEFAULT_RATE: 0.30,
    IRS_1099_THRESHOLD_CENTS: 60000,
    FATCA_THRESHOLD_CENTS: 5000000,
  };
}
module.exports = _impl;
