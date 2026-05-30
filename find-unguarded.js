const fs = require('fs');
const path = require('path');

const dir = 'public/js';
const files = fs.readdirSync(dir).filter(f => f.endsWith('.js'));

const dangerous = ['addEventListener', 'classList.add', 'classList.remove', 'classList.toggle',
  'textContent =', 'innerHTML =', 'appendChild', 'insertBefore', 'setAttribute('];

files.forEach(f => {
  const content = fs.readFileSync(path.join(dir, f), 'utf8');
  const lines = content.split('\n');
  lines.forEach((line, i) => {
    const s = line.trim();
    if (s.startsWith('//') || s.startsWith('/*') || s.startsWith('*')) return;
    if (s.includes('?.')) return;
    const gebi = /getElementById|querySelectorAll/;
    if (gebi.test(s) === false) return;
    const hasDanger = dangerous.some(d => s.includes(d));
    if (hasDanger) {
      console.log(f + ':' + (i+1) + ' | ' + s.substring(0, 150));
    }
  });
});