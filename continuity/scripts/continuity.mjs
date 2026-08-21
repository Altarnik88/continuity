#!/usr/bin/env node

import { main } from './lib/core/cli.mjs';

const argv = process.argv.slice(2);
process.exitCode = await main(argv, {
  stdout: process.stdout,
  stderr: process.stderr,
  clock: () => new Date(),
});
