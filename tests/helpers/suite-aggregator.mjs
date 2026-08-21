import { readdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const SUITE_NAMES = Object.freeze(['core', 'migration', 'continuity', 'protocol', 'coordinator']);

export class SuiteSelectionError extends Error {
  constructor(reason) { super(reason); this.name = 'SuiteSelectionError'; this.reason = reason; }
}

export const discoverTests = (directory) => readdirSync(directory, { withFileTypes: true })
  .flatMap((entry) => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? discoverTests(target) : entry.isFile() && entry.name.endsWith('.test.mjs') ? [target] : [];
  })
  .sort();

export function suiteFiles(testsRoot, suiteName) {
  if (!SUITE_NAMES.includes(suiteName)) throw new SuiteSelectionError('unknown');
  let files;
  try { files = discoverTests(path.join(testsRoot, suiteName)); } catch { throw new SuiteSelectionError('missing'); }
  if (!files.length) throw new SuiteSelectionError('empty');
  return files;
}

export async function runTestFiles(files) {
  for (const file of files) {
    const test = await import(pathToFileURL(file).href);
    if (typeof test.run !== 'function') throw new Error('suite test must export run()');
    await test.run();
  }
}
