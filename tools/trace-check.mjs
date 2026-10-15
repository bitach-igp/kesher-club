// Fails if a task cites an unknown REQ, or a REQ cited by a task has no test file mentioning its TST id.
// The REQ catalogue is the union of REQ ids in specs/requirements.md.
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const reqFile = path.join(root, 'specs/requirements.md');
const known = new Set((fs.readFileSync(reqFile, 'utf8').match(/REQ-[A-Z]+-\d{3}/g) ?? []));

const tasksDir = path.join(root, 'specs/tasks');
const cited = new Map();
for (const f of fs.readdirSync(tasksDir).filter((f) => /^T-\d{4}\.md$/.test(f))) {
  for (const r of fs.readFileSync(path.join(tasksDir, f), 'utf8').match(/REQ-[A-Z]+-\d{3}/g) ?? []) {
    if (!cited.has(r)) cited.set(r, []);
    cited.get(r).push(f.replace('.md', ''));
  }
}

const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
  e.name === 'node_modules' || e.name.startsWith('.') ? [] : e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
const testText = walk(root).filter((f) => /\.test\.ts$/.test(f)).map((f) => fs.readFileSync(f, 'utf8')).join('\n');

const errors = [];
for (const [r, tasks] of cited) if (!known.has(r)) errors.push(`${tasks.join(',')} cites unknown ${r}`);
const uncovered = [...known].filter((r) => !cited.has(r));
const tested = [...known].filter((r) => testText.includes(r) || testText.includes(r.replace('REQ-', 'TST-')));

console.log(`requirements: ${known.size} · cited by tasks: ${cited.size} · with tests so far: ${tested.length}`);
if (uncovered.length) console.log(`not yet in any task (E04/E05 pending ADR-006): ${uncovered.join(', ')}`);
if (errors.length) { console.error(errors.join('\n')); process.exit(1); }
