import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CASES as installCases } from './test-package-install.mjs';
import { CASES as validateCases } from './test-validate-package.mjs';

export class Skip extends Error {
  constructor(reason) {
    super(reason);
    this.name = 'Skip';
    this.reason = reason;
  }
}

export async function runCases(cases) {
  const summary = { found: cases.length, executed: 0, passed: 0, failed: 0, skipped: 0, failures: [], skips: [] };
  if (!cases.length) {
    throw new Error('package tests: zero found');
  }
  for (const testCase of cases) {
    if (!testCase?.id || typeof testCase.run !== 'function') {
      summary.failed += 1;
      summary.failures.push({ id: testCase?.id ?? '<missing>', message: 'case must have id and run()' });
      continue;
    }
    summary.executed += 1;
    try {
      await testCase.run();
      summary.passed += 1;
    } catch (error) {
      if (error?.name === 'Skip') {
        summary.skipped += 1;
        summary.skips.push({ id: testCase.id, reason: error.reason || error.message });
        continue;
      }
      summary.failed += 1;
      summary.failures.push({ id: testCase.id, message: error?.message ?? String(error) });
    }
  }
  return summary;
}

function render(summary) {
  const skipText = summary.skips.length
    ? `; skipped=${summary.skips.map((item) => `${item.id}:${item.reason}`).join('; ')}`
    : '';
  return `found=${summary.found} executed=${summary.executed} passed=${summary.passed} failed=${summary.failed} skipped=${summary.skipped}${skipText}`;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const cases = [...validateCases, ...installCases];
  const summary = await runCases(cases);
  if (summary.found === 0 || summary.executed === 0 || summary.passed + summary.skipped === 0) {
    console.error(`package tests: empty run (${render(summary)})`);
    process.exit(1);
  }
  if (summary.failed) {
    for (const failure of summary.failures) console.error(`FAIL ${failure.id}: ${failure.message}`);
    console.error(`package tests: FAIL (${render(summary)})`);
    process.exit(1);
  }
  console.log(`package tests: PASS (${render(summary)})`);
}
