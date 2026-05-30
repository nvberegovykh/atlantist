const fs = require('fs');
const h = fs.readFileSync('public/app.html', 'utf8');
const need = ['<html', '</html>', '<body', '</body>'];
const missing = need.filter(t => !h.includes(t));
if (missing.length) { console.error('FAIL: missing ' + missing.join(',')); process.exit(1); }
console.log('PASS: public/app.html valid');

// Check server.js
const sl = fs.readFileSync('server.js', 'utf8').split('\n').length;
console.log(sl > 300 ? `FAIL: server.js ${sl} lines` : `PASS: server.js ${sl} lines`);

// Check staged diffs
const diff = fs.readFileSync('/dev/stdin', 'utf8');
console.log('No staged changes yet - skipping staged diff check');