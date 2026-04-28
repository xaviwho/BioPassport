/**
 * Diagnose synthetic dataset composition and the source of "baseline FA" claims.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const datasetDir = path.join(__dirname, '..', 'data');
const scenarios = ['normal', 'drift', 'adversarial'];

interface Material {
  materialId: string;
  anomalies?: string[];
  groundTruth?: { isValid: boolean; anomalies: string[] };
  expectedVerification?: { pass: boolean; reasons?: string[] };
}

function isValid(m: Material): boolean {
  if (m.groundTruth) return m.groundTruth.isValid;
  if (m.expectedVerification) return m.expectedVerification.pass;
  return (m.anomalies || []).length === 0;
}

function anomalies(m: Material): string[] {
  return m.groundTruth?.anomalies || m.expectedVerification?.reasons || m.anomalies || [];
}

const totals = { valid: 0, invalid: 0, total: 0 };
const perAnomaly: Record<string, number> = {};
const perScenario: Array<{ scenario: string; total: number; valid: number; invalid: number; invalidRate: number }> = [];

for (const scenario of scenarios) {
  const file = path.join(datasetDir, scenario, 'materials.json');
  if (!fs.existsSync(file)) {
    console.warn(`missing: ${file}`);
    continue;
  }
  const materials = JSON.parse(fs.readFileSync(file, 'utf8')) as Material[];
  const valid = materials.filter(isValid).length;
  const invalid = materials.length - valid;
  totals.valid += valid;
  totals.invalid += invalid;
  totals.total += materials.length;
  perScenario.push({ scenario, total: materials.length, valid, invalid, invalidRate: invalid / materials.length });
  for (const m of materials) {
    for (const a of anomalies(m)) {
      perAnomaly[a] = (perAnomaly[a] ?? 0) + 1;
    }
  }
  console.log(`scenario=${scenario.padEnd(12)} total=${materials.length} valid=${valid} invalid=${invalid} invalidRate=${(invalid / materials.length * 100).toFixed(1)}%`);
}

const rootSummary = path.join(datasetDir, 'summary.json');
if (fs.existsSync(rootSummary)) {
  const summary = JSON.parse(fs.readFileSync(rootSummary, 'utf8'));
  console.log('\n=== Existing summary.json ===');
  console.log(JSON.stringify(summary.expectedVerificationResults || summary, null, 2));
}

console.log('\n=== Dataset composition ===');
console.log('total:        ', totals.total);
console.log('total valid:  ', totals.valid);
console.log('total invalid:', totals.invalid);
console.log('invalid rate: ', totals.total ? `${(totals.invalid / totals.total * 100).toFixed(1)}%` : 'n/a');

console.log('\n=== Per-anomaly distribution ===');
for (const [k, v] of Object.entries(perAnomaly).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(28)} ${v}`);
}

console.log('\nInterpretation guide:');
console.log('- If invalid rate is near 30%, a reported "30.2% FA" may be dataset prevalence, not false acceptance.');
console.log('- True FPR must be computed over valid materials; true miss rate/FNR must be computed over invalid materials.');

const outDir = path.join(__dirname, '..', 'results', 'diagnostics');
fs.mkdirSync(outDir, { recursive: true });
const out = path.join(outDir, `dataset-composition-${Date.now()}.json`);
fs.writeFileSync(out, JSON.stringify({
  perScenario,
  totals: { ...totals, invalidRate: totals.total ? totals.invalid / totals.total : 0 },
  perAnomaly,
}, null, 2));
console.log(`\nWrote ${out}`);
