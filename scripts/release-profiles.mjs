import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageJson = JSON.parse(
  readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8'),
);
export const RELEASE_VERSION = packageJson.version;

const MEMORY_PREFIXES = Object.freeze([
  'continuity/SKILL.md',
  'continuity/package.json',
  'continuity/assets/',
  'continuity/references/',
  'continuity/scripts/continuity.mjs',
  'continuity/scripts/project-memory.mjs',
  'continuity/scripts/lib/core/',
  'continuity/scripts/lib/protocol/',
  'continuity/scripts/smokes/memory.mjs',
]);

const COORDINATOR_PREFIXES = Object.freeze([
  'continuity/package.json',
  'continuity/scripts/coordinator.mjs',
  'continuity/scripts/lib/protocol/',
  'continuity/scripts/lib/coordinator/',
  'continuity/assets/coordinator.config.json',
  'continuity/scripts/smokes/coordinator.mjs',
]);

const SHARED_DOCS = Object.freeze([
  'LICENSE',
  'README.md',
  'README.ru.md',
  'SECURITY.md',
  'ARCHITECTURE.md',
  'PROTOCOL.md',
  'INSTALL.md',
  'MIGRATION.md',
  'RELEASE.md',
  'CHANGELOG.md',
  'COMPETITORS.md',
  'COMPETITORS.ru.md',
  'package.json',
]);

const MEMORY_DOCS = Object.freeze([...SHARED_DOCS]);
const COORDINATOR_DOCS = Object.freeze([
  ...SHARED_DOCS,
  'COORDINATOR.md',
  'ADAPTERS.md',
]);
const FULL_DOCS = Object.freeze([
  ...SHARED_DOCS,
  'COORDINATOR.md',
  'ADAPTERS.md',
]);

function matches(file, prefixes) {
  return prefixes.some((prefix) => file === prefix || (prefix.endsWith('/') && file.startsWith(prefix)));
}

export function filesForProfile(allFiles, profile) {
  if (profile === 'memory') {
    return allFiles.filter((file) => matches(file, MEMORY_PREFIXES) || MEMORY_DOCS.includes(file))
      .filter((file) => !file.startsWith('continuity/scripts/lib/coordinator/')
        && file !== 'continuity/scripts/coordinator.mjs'
        && file !== 'continuity/scripts/smokes/coordinator.mjs'
        && file !== 'continuity/scripts/smokes/full.mjs');
  }
  if (profile === 'coordinator') {
    return allFiles.filter((file) => matches(file, COORDINATOR_PREFIXES) || COORDINATOR_DOCS.includes(file)
      || file === 'continuity/scripts/smokes/coordinator.mjs');
  }
  if (profile === 'full') {
    return allFiles.filter((file) => file.startsWith('continuity/') || FULL_DOCS.includes(file));
  }
  throw new Error(`unknown profile ${profile}`);
}

export const PROFILE_NAMES = Object.freeze(['memory', 'coordinator', 'full']);
