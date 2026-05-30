// Remove the dead first 'parametric-templates' entry
// The first entry (line 1633-1895) is shadowed by the second at 1898
const fs = require('fs');
const content = fs.readFileSync('./public/docs/index.html', 'utf8');

const marker1 = '// ── PARAMETRIC TEMPLATES ─────────────────────────────────────────────────';
const marker2 = '// ── Parametric Templates — the recreatable scaffold ────────────────────────';

const i1 = content.indexOf(marker1);
const i2 = content.indexOf(marker2);

if (i1 === -1 || i2 === -1) { console.log('markers not found'); process.exit(1); }
console.log('Dead block: char ' + i1 + ' to ' + i2 + ' (' + (i2-i1) + ' chars)');

const fixed = content.substring(0, i1) + '// [DEDUPED] first parametric-templates removed (shadowed by second instance)\n' + content.substring(i2);
fs.writeFileSync('./public/docs/index.html', fixed);
console.log('Saved. New size:', fixed.length);