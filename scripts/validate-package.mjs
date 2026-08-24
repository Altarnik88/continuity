import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DISTRIBUTABLE_FILES,
  PUBLIC_DIAGRAM_FILES,
  SKILL_PREFIX,
  assertExactSkillManifest,
  assertInventoryContract,
  assertNpmPackEqualsDistributable,
  inventoryFromWorktree,
  runNpmPackDryRun,
} from './package-inventory.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const skill = SKILL_PREFIX.slice(0, -1);

export const EXPECTED_PACKAGE_SCRIPTS = Object.freeze({
  test: 'node scripts/test-continuity.mjs',
  validate: 'node scripts/validate-package.mjs',
  'test:package': 'node scripts/test-package.mjs',
  'test:forward': 'node scripts/test-forward-acceptance.mjs',
  'test:protocol': 'node scripts/test-protocol.mjs',
  'test:coordinator': 'node scripts/test-coordinator.mjs',
  'test:release': 'node scripts/test-release.mjs',
  'package:release': 'node scripts/package-release.mjs',
  start: 'node continuity/scripts/launch.mjs',
  launch: 'node continuity/scripts/launch.mjs',
  'test:swarm': 'node tests/swarm/run.mjs',
  check: 'npm run validate && npm test && npm run test:package && npm run test:forward && npm run test:protocol && npm run test:coordinator && npm run test:release && npm run test:swarm',
  'audit:dev': 'npm audit --audit-level=high',
});

export function assertCiWorkflowYaml(ci) {
  if (typeof ci !== 'string' || ci.length === 0) throw new Error('CI workflow text is invalid');
  const normalized = ci.replaceAll('\r\n', '\n');
  const checkoutUses = normalized.match(/uses:\s*actions\/checkout@[a-f0-9]{40}/g) ?? [];
  if (checkoutUses.length !== 1) {
    throw new Error('CI must use exactly one pinned checkout of this repository');
  }
  if (/^\s+(?:repository|sparse-checkout|path):\s*/m.test(normalized)
    || /openai\/skills|official-installer|\.ci\/openai-skills/i.test(normalized)) {
    throw new Error('CI must not fetch or provision another Skill repository');
  }
}

const expectedFrontmatter = /^---\nname: continuity\ndescription: [^\n]+\n---\n/;

function fail(message) {
  console.error(`package validation failed: ${message}`);
  process.exit(1);
}

function readText(repoPath) {
  try {
    return readFileSync(path.join(root, ...repoPath.split('/')), 'utf8');
  } catch {
    fail(`unable to read required text file (${repoPath})`);
  }
}

function parseJson(repoPath) {
  try {
    return JSON.parse(readText(repoPath));
  } catch {
    fail(`invalid JSON (${repoPath})`);
  }
}

function sameJson(actual, expected) {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

export function validatePackage(repoRoot = root) {
  let inventory;
  try {
    inventory = inventoryFromWorktree(repoRoot);
    assertInventoryContract(inventory);
    assertExactSkillManifest(inventory);
  } catch (error) {
    fail(error.message);
  }

  if (!expectedFrontmatter.test(readText(`${skill}/SKILL.md`).replaceAll('\r\n', '\n'))) {
    fail('SKILL.md frontmatter must use the public Skill name continuity');
  }
  if (inventory.skill.includes(`${skill}/agents/openai.yaml`)) {
    fail('provider-specific agents/openai.yaml must not be distributed');
  }
  if (!inventory.skill.includes(`${skill}/scripts/continuity.mjs`)) {
    fail('public continuity CLI entry point is missing');
  }

  const packageJson = parseJson('package.json');
  const exactPackageKeys = [
    'name', 'version', 'private', 'description', 'type', 'license', 'repository', 'homepage',
    'bugs', 'packageManager', 'engines', 'files', 'scripts', 'devDependencies',
  ];
  if (Object.keys(packageJson).join('\0') !== exactPackageKeys.join('\0')) fail('package.json has unexpected metadata fields');
  if (packageJson.name !== 'continuity' || packageJson.version !== '3.0.0') fail('package identity is invalid');
  const skillPackage = parseJson(`${skill}/package.json`);
  if (Object.keys(skillPackage).join('\0') !== ['name', 'version', 'private', 'type'].join('\0')) {
    fail('skill package.json has unexpected metadata fields');
  }
  if (skillPackage.name !== 'continuity' || skillPackage.version !== packageJson.version) {
    fail('skill package identity does not match package.json');
  }
  if (skillPackage.private !== true || skillPackage.type !== 'module') fail('skill package.json metadata is invalid');
  if (packageJson.private !== true || packageJson.license !== 'MIT') fail('package publication/license boundary is invalid');
  const licenseText = readText('LICENSE').replaceAll('\r\n', '\n');
  if (!licenseText.startsWith('MIT License\n')
    || !licenseText.includes('Copyright (c) 2026 Altarnik88')
    || !licenseText.includes('Permission is hereby granted, free of charge')
    || !licenseText.includes('THE SOFTWARE IS PROVIDED "AS IS"')) {
    fail('LICENSE is not the canonical MIT text for Altarnik88');
  }
  if (!sameJson(packageJson.repository, {
    type: 'git',
    url: 'git+https://github.com/Altarnik88/continuity.git',
  })) fail('repository metadata is invalid');
  if (packageJson.homepage !== 'https://github.com/Altarnik88/continuity#readme') fail('homepage metadata is invalid');
  if (!sameJson(packageJson.bugs, { url: 'https://github.com/Altarnik88/continuity/issues' })) fail('bugs metadata is invalid');
  const productMetadata = JSON.stringify({
    name: packageJson.name,
    description: packageJson.description,
    repository: packageJson.repository,
    homepage: packageJson.homepage,
    bugs: packageJson.bugs,
  });
  if (/codex|mnemosyne/i.test(productMetadata)) fail('product metadata contains retired branding');
  if (packageJson.packageManager !== 'npm@11.17.0') fail('package manager metadata is invalid');
  if (packageJson.engines?.node !== '>=22 <25') fail('Node engine range is invalid');
  if (JSON.stringify(packageJson.files) !== JSON.stringify([...DISTRIBUTABLE_FILES])) {
    fail('package.json files[] is not the canonical DISTRIBUTABLE_FILES allowlist');
  }
  if (packageJson.files.includes('docs/assets') || DISTRIBUTABLE_FILES.includes('docs/assets')) {
    fail('docs/assets must not be a prefix allowlist entry');
  }
  for (const diagram of PUBLIC_DIAGRAM_FILES) {
    if (!packageJson.files.includes(diagram)) fail(`package.json files[] omitted a public diagram (${diagram})`);
  }
  const readme = readText('README.md');
  for (const diagram of PUBLIC_DIAGRAM_FILES) {
    if (!readme.includes(`](${diagram})`)) fail(`README is missing a pack-relative diagram reference (${diagram})`);
  }
  if (/project-memory-hero\.png|project-memory-architecture\.svg/.test(readme)) {
    fail('README still references retired diagram filenames');
  }
  if (!sameJson(packageJson.scripts, EXPECTED_PACKAGE_SCRIPTS)) fail('package scripts are invalid');
  if (!sameJson(packageJson.devDependencies, { ajv: '8.20.0' })) fail('development dependency set is invalid');
  const lifecycle = ['preinstall', 'install', 'postinstall', 'prepublish', 'prepare', 'prepack', 'postpack', 'prepublishOnly', 'publish', 'postpublish'];
  if (lifecycle.some((name) => Object.hasOwn(packageJson.scripts, name))) fail('lifecycle scripts are not allowed');

  const packageLock = parseJson('package-lock.json');
  if (!sameJson(Object.keys(packageLock), ['name', 'version', 'lockfileVersion', 'requires', 'packages'])) {
    fail('lockfile has unexpected top-level metadata');
  }
  if (packageLock.name !== packageJson.name || packageLock.version !== packageJson.version) fail('lockfile package identity is invalid');
  if (packageLock.lockfileVersion !== 3 || packageLock.requires !== true) fail('lockfile format is invalid');
  const expectedLockPackages = {
    '': {
      name: 'continuity',
      version: '3.0.0',
      license: 'MIT',
      devDependencies: { ajv: '8.20.0' },
      engines: { node: '>=22 <25' },
    },
    'node_modules/ajv': {
      version: '8.20.0',
      resolved: 'https://registry.npmjs.org/ajv/-/ajv-8.20.0.tgz',
      integrity: 'sha512-Thbli+OlOj+iMPYFBVBfJ3OmCAnaSyNn4M1vz9T6Gka5Jt9ba/HIR56joy65tY6kx/FCF5VXNB819Y7/GUrBGA==',
      dev: true,
      license: 'MIT',
      dependencies: {
        'fast-deep-equal': '^3.1.3',
        'fast-uri': '^3.0.1',
        'json-schema-traverse': '^1.0.0',
        'require-from-string': '^2.0.2',
      },
      funding: { type: 'github', url: 'https://github.com/sponsors/epoberezkin' },
    },
    'node_modules/fast-deep-equal': {
      version: '3.1.3',
      resolved: 'https://registry.npmjs.org/fast-deep-equal/-/fast-deep-equal-3.1.3.tgz',
      integrity: 'sha512-f3qQ9oQy9j2AhBe/H9VC91wLmKBCCU/gDOnKNAYG5hswO7BLKj09Hc5HYNz9cGI++xlpDCIgDaitVs03ATR84Q==',
      dev: true,
      license: 'MIT',
    },
    'node_modules/fast-uri': {
      version: '3.1.5',
      resolved: 'https://registry.npmjs.org/fast-uri/-/fast-uri-3.1.5.tgz',
      integrity: 'sha512-gHwA1O9LDIcKunMKhObS/HimwtehO1nPUECKAu5TpKgaO19fcWEl4bliWe1jWxVFvIXztJjjQ4L8XQ1EU9f7Jw==',
      dev: true,
      funding: [
        { type: 'github', url: 'https://github.com/sponsors/fastify' },
        { type: 'opencollective', url: 'https://opencollective.com/fastify' },
      ],
      license: 'BSD-3-Clause',
    },
    'node_modules/json-schema-traverse': {
      version: '1.0.0',
      resolved: 'https://registry.npmjs.org/json-schema-traverse/-/json-schema-traverse-1.0.0.tgz',
      integrity: 'sha512-NM8/P9n3XjXhIZn1lLhkFaACTOURQXjWhV4BA/RnOv8xvgqtqpAX9IO4mRQxSx1Rlo4tqzeqb0sOlruaOy3dug==',
      dev: true,
      license: 'MIT',
    },
    'node_modules/require-from-string': {
      version: '2.0.2',
      resolved: 'https://registry.npmjs.org/require-from-string/-/require-from-string-2.0.2.tgz',
      integrity: 'sha512-Xf0nWe6RseziFMu+Ap9biiUbmplq6S9/p+7w7YXP/JBHhrUDDUhwa+vANyubuqfZWTveU//DYVGsDG7RKL/vEw==',
      dev: true,
      license: 'MIT',
      engines: { node: '>=0.10.0' },
    },
  };
  if (!sameJson(packageLock.packages, expectedLockPackages)) {
    fail('lockfile dependencies, metadata, URLs, integrity values, or licenses are outside the allowed set');
  }

  const initTemplate = parseJson(`${skill}/assets/init-v3.template.json`);
  if (initTemplate.schemaVersion !== 3 || !initTemplate.project || !initTemplate.finalGoal) {
    fail('v3 init template is missing schemaVersion 3, project, or finalGoal');
  }

  const ci = readText('.github/workflows/ci.yml');
  if (/uses:\s*[^\s]+@(?![a-f0-9]{40}(?:\s|$))/i.test(ci)) fail('CI actions must use full commit SHA pins');
  if (!ci.includes('persist-credentials: false') || !ci.includes('timeout-minutes: 15')) fail('CI hardening settings are missing');
  if (!ci.includes('npm ci --ignore-scripts') || !ci.includes('npm run audit:dev')) fail('CI install or audit boundary is missing');
  if (!/^\s+run:\s*npm run check\s*$/m.test(ci.replaceAll('\r\n', '\n'))
    || !ci.includes('windows-latest') || !ci.includes('ubuntu-latest')) {
    fail('CI matrix or check command is missing');
  }
  if (!ci.includes('node: [22, 24]') && !ci.includes("node: ['22', '24']")) fail('CI Node matrix must include 22 and 24');
  try {
    assertCiWorkflowYaml(ci);
  } catch (error) {
    fail(error.message);
  }
  if (/npm publish|secrets:|telemetry|model download/i.test(ci)) fail('CI contains a forbidden publish, secret, or telemetry step');

  const genericLeakGuards = [
    /[A-Za-z]:[\\/](?:Users|Documents and Settings)[\\/][^\\/\s]+/i,
    /(?:^|[\s"'(=])\/(?:Users|home)\/[^/\\\s]+(?:[/\\]|$)/im,
    /https?:\/\/[^/\s:@]+:[^@\s/]+@/i,
    /"(?:resolved|version)"\s*:\s*"(?:file|link):/i,
  ];
  for (const repoPath of inventory.all) {
    const value = readText(repoPath);
    if (genericLeakGuards.some((pattern) => pattern.test(value))) {
      fail(`generic local-path, credentialed-URL, or local-dependency leakage detected (${repoPath})`);
    }
  }

  let pack;
  try {
    pack = runNpmPackDryRun(repoRoot);
    assertNpmPackEqualsDistributable(pack, inventory);
  } catch (error) {
    fail(error.message);
  }

  return { inventory, pack };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const { inventory, pack } = validatePackage(root);
  console.log(`package validation: ok (worktree ${inventory.all.length} files; skill ${inventory.skill.length}; repo-only ${inventory.repoOnly.length}; metadata ${inventory.repoMetadata.length}; npm-pack ${pack.files.length} files, not the standalone Skill artifact)`);
}
