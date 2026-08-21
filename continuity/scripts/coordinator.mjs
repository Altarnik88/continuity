#!/usr/bin/env node

import { main } from './lib/coordinator/cli.mjs';

process.exitCode = await main(process.argv.slice(2), {
  stdout: process.stdout,
  stderr: process.stderr,
});
