#!/usr/bin/env node

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runTestFiles, suiteFiles } from '../tests/helpers/suite-aggregator.mjs';

const testsDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'tests');
const files = suiteFiles(testsDirectory, 'coordinator');
await runTestFiles(files);
console.log(`coordinator suite: PASS (${files.length} file(s))`);
