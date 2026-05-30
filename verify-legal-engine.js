const fs = require('fs');
const h = fs.readFileSync('public/app.html', 'utf8');
const need = ['<html', '</html>', '<body', '</body>'];
const missing = need.filter(t => !h.includes(t));
if (missing.length) {
  console.error('FAIL: app.html missing: ' + missing.join(', '));
  process.exit(1);
}
console.log('PASS: app.html OK');

// Also test the legal engine can be required
const svc = require('./services/rect-legal-engine');
console.log('PASS: rect-legal-engine.js loads, exports:', Object.keys(svc));

const wallt = require('./routes/wallt');
console.log('PASS: wallt.js loads');