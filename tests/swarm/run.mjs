import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const directory = path.dirname(fileURLToPath(import.meta.url));
const files = readdirSync(directory).filter((name) => name.endsWith('.test.mjs')).sort();
for (const file of files) {
  const test = await import(pathToFileURL(path.join(directory, file)).href);
  if (typeof test.run !== 'function') throw new Error(`${file} must export run()`);
  await test.run();
  console.log(`swarm ${file}: PASS`);
}
console.log(`swarm suite: PASS (${files.length} file(s))`);
