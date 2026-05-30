const fs = require('fs');
const html = fs.readFileSync('public/wallt-landing.html', 'utf8');
const need = ['<html', '</html>', '<body', '</body>'];
const missing = need.filter(t => !html.includes(t));
if (missing.length) {
  console.error('FAIL: wallt-landing.html missing required tags:', missing.join(', '));
  process.exit(1);
}
console.log('PASS: wallt-landing.html structure');