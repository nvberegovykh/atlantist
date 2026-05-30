const fs = require('fs');
const h = fs.readFileSync('public/app.html', 'utf8');
const need = ['<html', '</html>', '<body', '</body>'];
const missing = need.filter(t => !h.includes(t));
if (missing.length) {
  console.error('FAIL: public/app.html missing required tags: ' + missing.join(', '));
  process.exit(1);
}
console.log('PASS: public/app.html has all required tags');
console.log('Wallt CSS:', h.includes('wallt.css') ? 'INJECTED' : 'MISSING');
console.log('Wallt JS:', h.includes('wallt.js') ? 'INJECTED' : 'MISSING');