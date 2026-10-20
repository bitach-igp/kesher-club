// T-0008: the 19 ports of Tab 3 §4 (18, and KybPort from T-0622) all exist, each with a contract suite and (where the spec says so)
// a simulator, and every flag they cite is in config/flags.json.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PORTS } from './catalogue.ts';
import { fileURLToPath } from 'node:url';

const src = path.dirname(fileURLToPath(import.meta.url));
const flags = new Set((JSON.parse(fs.readFileSync(path.resolve(src, '../../../config/flags.json'), 'utf8')) as { key: string }[]).map((f) => f.key));

describe('port catalogue', () => {
  it('lists exactly 19 ports with unique capabilities', () => {
    expect(PORTS.length).toBe(19);
    expect(new Set(PORTS.map((p) => p.capability)).size).toBe(19);
  });

  it.each(PORTS.map((p) => [p.capability, p] as const))('%s has its interface, contract suite and simulator files', (_c, p) => {
    expect(fs.existsSync(path.join(src, `${p.capability}.ts`))).toBe(true);
    expect(fs.existsSync(path.join(src, p.contract))).toBe(true);
    if (p.simulator) {
      expect(fs.existsSync(path.join(src, `${p.capability}.simulator.ts`))).toBe(true);
      expect(fs.existsSync(path.join(src, `${p.capability}.simulator.test.ts`))).toBe(true);
    }
  });

  it('only cites flags that exist in config/flags.json (constitution art. 8)', () => {
    for (const p of PORTS) for (const f of p.flags) expect(flags.has(f), `${p.capability} cites unknown flag ${f}`).toBe(true);
  });

  it('every port is exported from the package index', () => {
    const index = fs.readFileSync(path.join(src, 'index.ts'), 'utf8');
    for (const p of PORTS) expect(index, `index.ts lacks ${p.capability}`).toContain(`./${p.capability}.ts`);
  });
});
