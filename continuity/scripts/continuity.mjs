#!/usr/bin/env node

import { isV2Invocation, main as mainV2 } from './lib/core/cli.mjs';
import { runV1 } from './lib/core/legacy-v1.mjs';

const argv = process.argv.slice(2);
if (isV2Invocation(argv)) {
  process.exitCode = await mainV2(argv, {
    stdout: process.stdout,
    stderr: process.stderr,
    clock: () => new Date(),
  });
} else {
  runV1();
}
