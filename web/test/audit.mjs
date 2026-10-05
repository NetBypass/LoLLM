// Audit statis: pastikan semua komponen JSX yang dipakai di-import/didefinisikan lokal.
// Menangkap bug kelas "SectionTitle is not defined" (build sukses, runtime crash).
// Jalankan: npm run test:audit
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const files = [];
(function walk(dir) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(jsx?|tsx?)$/.test(f)) files.push(p);
  }
})(root);

let bad = 0;
for (const file of files) {
  const src = readFileSync(file, 'utf8');
  const imports = new Set();
  for (const m of src.matchAll(/import\s+(?:\{([^}]+)\}|(\w+))\s+from/g)) {
    if (m[1]) m[1].split(',').forEach((s) => imports.add(s.trim().split(/\s+as\s+/).pop().trim()));
    if (m[2]) imports.add(m[2]);
  }
  const local = new Set();
  for (const m of src.matchAll(/(?:function|const|class)\s+([A-Z]\w+)/g)) local.add(m[1]);
  // prop destructuring rename: ({ icon: Icon, ... }) / { icon: Icon }
  for (const m of src.matchAll(/[({]\s*\w+\s*:\s*([A-Z]\w+)/g)) local.add(m[1]);
  // <Icon ...> di props destructuring ({ icon: Icon }) tercakup oleh "local"
  const used = new Set();
  for (const m of src.matchAll(/<([A-Z]\w+)/g)) used.add(m[1]);
  const missing = [...used].filter((u) => !imports.has(u) && !local.has(u));
  if (missing.length) {
    console.error(`✗ ${file.replace(root + '/', '')} → identifier tanpa import: ${missing.join(', ')}`);
    bad++;
  }
}

if (bad) { console.error(`\n${bad} file bermasalah`); process.exit(1); }
console.log(`✓ audit ok — ${files.length} file, semua identifier JSX ter-import`);
