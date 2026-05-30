const fs = require('fs');
const content = fs.readFileSync('./public/docs/index.html', 'utf8');
const start = content.indexOf('const pages = {');
const end = content.indexOf('// ── Render engine');
const pages = content.substring(start, end);
// Find all occurrences of page key pattern
const re = /'([^']+)':\t`/g;
let m;
while ((m = re.exec(pages)) !== null) {
  console.log(m[1]);
}
console.log('total:', (pages.match(/'\n/g) || []).length);