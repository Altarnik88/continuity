import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DISTRIBUTABLE_FILES,
  REQUIRED_SKILL_FILES,
  RUNTIME_STORE_PREFIX,
  SKILL_PREFIX,
  assertInventoryContract,
  assertNpmPackEqualsDistributable,
  assertNpmPackIsNotSkillArtifact,
  assertNpmPackPurity,
  assertPortableGitPath,
  assertRepositoryBoundaries,
  assertSkillsDest,
  assertTempInstallHome,
  assertUninstallDest,
  buildInventory,
  classifyGitPath,
  expectedNpmPackFiles,
  inventoryFromGit,
  inventoryFromWorktree,
  listGitIndex,
  listRepositoryFiles,
  matchesDistributableAllowlist,
  parseNpmPackJson,
  runNpmPackDryRun,
} from './package-inventory.mjs';
import { assertCiWorkflowYaml } from './validate-package.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function git(root, args) {
  execFileSync('git', ['-C', root, ...args], {
    stdio: 'ignore',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
}

function makeGitRepo(label) {
  const root = mkdtempSync(path.join(os.tmpdir(), `continuity-pkg-${label}-`));
  git(root, ['init', '-q']);
  git(root, ['config', 'user.name', 'Package Test']);
  git(root, ['config', 'user.email', 'package-test@example.invalid']);
  return root;
}

function writeTracked(root, repoPath, body) {
  const absolute = path.join(root, ...repoPath.split('/'));
  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(absolute, body);
  git(root, ['add', '--', repoPath]);
}

function makeBoundaryRoot(label) {
  const root = mkdtempSync(path.join(os.tmpdir(), `continuity-boundary-${label}-`));
  mkdirSync(path.join(root, 'continuity', 'scripts'), { recursive: true });
  writeFileSync(path.join(root, 'continuity', 'SKILL.md'), '---\nname: continuity\n---\n');
  writeFileSync(path.join(root, 'continuity', 'scripts', 'continuity.mjs'), "import 'node:fs';\n");
  writeFileSync(path.join(root, 'README.md'), '# Boundary fixture\n');
  return root;
}

function removeLink(linkPath) {
  if (!existsSync(linkPath)) return;
  try {
    if (lstatSync(linkPath).isSymbolicLink()) unlinkSync(linkPath);
    else if (process.platform === 'win32') unlinkSync(linkPath);
  } catch {
    /* fixture cleanup */
  }
}

export const CASES = [
  {
    id: 'PKG-001-classify-clean-repository-paths',
    run() {
      assert.equal(SKILL_PREFIX, 'continuity/');
      assert.equal(classifyGitPath('continuity/SKILL.md'), 'skill');
      assert.equal(classifyGitPath('.autopilot/state.js'), 'forbidden');
      assert.equal(classifyGitPath('.continuity/CURRENT.json'), 'forbidden');
      assert.equal(classifyGitPath('.codex/project-memory/CURRENT.json'), 'forbidden');
      assert.equal(classifyGitPath('package.json'), 'repo-metadata');
      assert.equal(classifyGitPath('scripts/validate-package.mjs'), 'repo-metadata');
      assert.equal(classifyGitPath('docs/assets/hero.svg'), 'unclassified');
      assert.equal(classifyGitPath('other-skill/SKILL.md'), 'unclassified');
    },
  },
  {
    id: 'PKG-002-reject-unsafe-and-forbidden-paths',
    run() {
      assert.throws(() => assertPortableGitPath('../escape'), /unsafe/);
      assert.throws(() => assertPortableGitPath('foo\\bar'), /portable/);
      assert.throws(() => buildInventory(['.autopilot/README.md']), /forbidden/);
      assert.throws(() => buildInventory([`${RUNTIME_STORE_PREFIX}CURRENT.json`]), /runtime store/);
      assert.throws(() => buildInventory(['other-skill/SKILL.md']), /unclassified/);
    },
  },
  {
    id: 'PKG-003-git-index-helper-ignores-worktree-extras',
    run() {
      const root = makeGitRepo('index');
      try {
        writeTracked(root, 'continuity/SKILL.md', '---\nname: continuity\n---\n');
        writeTracked(root, '.gitignore', 'ignored.txt\n');
        git(root, ['commit', '-qm', 'fixture']);
        writeFileSync(path.join(root, 'ignored.txt'), 'ignored\n');
        writeFileSync(path.join(root, 'untracked.txt'), 'untracked\n');
        const index = listGitIndex(root);
        assert.deepEqual(index.files, ['.gitignore', 'continuity/SKILL.md']);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  },
  {
    id: 'PKG-004-runtime-store-rejected-from-index-without-reading',
    run() {
      const root = makeGitRepo('store');
      try {
        writeTracked(root, 'continuity/SKILL.md', '---\nname: continuity\n---\n');
        writeTracked(root, `${RUNTIME_STORE_PREFIX}CURRENT.json`, 'must-not-be-opened\n');
        git(root, ['commit', '-qm', 'fixture']);
        assert.throws(() => inventoryFromGit(root), /runtime store/);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  },
  {
    id: 'PKG-005-current-worktree-inventory',
    run() {
      const inventory = inventoryFromWorktree(repoRoot);
      assertInventoryContract(inventory);
      assert.deepEqual(inventory.repoOnly, []);
      assert.ok(inventory.skill.includes('continuity/SKILL.md'));
      assert.equal(inventory.all.some((file) => file.startsWith('.codex/')), false);
      assert.equal(inventory.all.some((file) => file.startsWith('.continuity/')), false);
      assert.equal(inventory.all.some((file) => file.startsWith('.autopilot/')), false);
      for (const file of REQUIRED_SKILL_FILES) assert.ok(inventory.skill.includes(file), file);
    },
  },
  {
    id: 'PKG-006-npm-pack-is-not-standalone-skill',
    run() {
      const inventory = inventoryFromWorktree(repoRoot);
      const pack = parseNpmPackJson(JSON.stringify([{
        filename: 'continuity-1.0.0.tgz',
        files: [...inventory.skill.map((file) => ({ path: file })), { path: 'package.json' }],
      }]));
      assertNpmPackIsNotSkillArtifact(pack, inventory);
      assert.throws(() => assertNpmPackIsNotSkillArtifact({ files: [...inventory.skill] }, inventory), /equals the skill artifact/);
    },
  },
  {
    id: 'PKG-007-missing-required-skill-fails',
    run() {
      const inventory = buildInventory([
        '.gitattributes',
        '.github/workflows/ci.yml',
        '.gitignore',
        'LICENSE',
        'README.md',
        'README.ru.md',
        'SECURITY.md',
        'examples/coordinator.config.json',
        'examples/snapshot.minimal.json',
        'examples/snapshot.source-backed.json',
        'examples/source-anchor.md',
        'package-lock.json',
        'package.json',
        'scripts/install.mjs',
        'scripts/package-inventory.mjs',
        'scripts/package-release.mjs',
        'scripts/release-profiles.mjs',
        'scripts/test-continuity.mjs',
        'scripts/test-coordinator.mjs',
        'scripts/test-forward-acceptance.mjs',
        'scripts/test-package-install.mjs',
        'scripts/test-package.mjs',
        'scripts/test-protocol.mjs',
        'scripts/test-release.mjs',
        'scripts/test-validate-package.mjs',
        'scripts/validate-package.mjs',
        'scripts/zip-store.mjs',
        'tests/core/v3-e2e.test.mjs',
        'tests/helpers/suite-aggregator.mjs',
        'continuity/SKILL.md',
      ]);
      assert.throws(() => assertInventoryContract(inventory), /required skill files are missing/);
    },
  },
  {
    id: 'PKG-008-temp-install-destination-boundary',
    run() {
      const installHome = mkdtempSync(path.join(os.tmpdir(), 'continuity-home-'));
      const aliasFixture = mkdtempSync(path.join(os.tmpdir(), 'continuity-root-alias-'));
      const aliasTarget = path.join(aliasFixture, 'private-var');
      const aliasAncestor = path.join(aliasFixture, 'var');
      const aliasRoot = path.join(aliasAncestor, 'folders');
      const outside = mkdtempSync(path.join(os.tmpdir(), 'continuity-root-alias-outside-'));
      const escapeLink = path.join(aliasRoot, 'escape');
      const inboundLink = path.join(outside, 'inbound-temp-alias');
      try {
        assert.equal(assertTempInstallHome(installHome), path.resolve(installHome));
        const skills = path.join(installHome, 'skills');
        assert.equal(path.resolve(assertSkillsDest(installHome, skills)), path.resolve(skills));
        assert.throws(() => assertSkillsDest(installHome, path.join(installHome, '..', 'escape')), /unsafe path components|outside/);
        assert.throws(() => assertTempInstallHome(outside, { tmpdir: installHome }), /inside the temp directory/);

        mkdirSync(path.join(aliasTarget, 'folders'), { recursive: true });
        try {
          symlinkSync(aliasTarget, aliasAncestor, process.platform === 'win32' ? 'junction' : 'dir');
        } catch (error) {
          const skip = new Error(`cannot create test root alias: ${error.code || error.message}`);
          skip.name = 'Skip';
          skip.reason = skip.message;
          throw skip;
        }
        const aliasedHome = path.join(aliasRoot, 'continuity-home');
        mkdirSync(aliasedHome, { recursive: true });
        writeFileSync(path.join(aliasedHome, 'marker.txt'), 'trusted-root-alias\n');
        const aliasedMarker = readFileSync(path.join(aliasedHome, 'marker.txt'));
        assert.notEqual(path.resolve(aliasedHome), realpathSync(aliasedHome), 'fixture did not create a lexical/canonical root alias');
        assert.equal(assertTempInstallHome(aliasedHome, { tmpdir: aliasRoot }), path.resolve(aliasedHome));
        assert.deepEqual(readFileSync(path.join(aliasedHome, 'marker.txt')), aliasedMarker, 'root-alias validation changed the install home');

        const outsideHome = path.join(outside, 'continuity-home');
        mkdirSync(outsideHome, { recursive: true });
        const outsideMarker = path.join(outsideHome, 'marker.txt');
        writeFileSync(outsideMarker, 'outside-root-alias\n');
        symlinkSync(outside, escapeLink, process.platform === 'win32' ? 'junction' : 'dir');
        assert.throws(
          () => assertTempInstallHome(path.join(escapeLink, 'continuity-home'), { tmpdir: aliasRoot }),
          /symlink|junction|reparse|resolves outside/,
        );
        symlinkSync(aliasRoot, inboundLink, process.platform === 'win32' ? 'junction' : 'dir');
        assert.throws(
          () => assertTempInstallHome(path.join(inboundLink, 'continuity-home'), { tmpdir: aliasRoot }),
          /inside the temp directory/,
        );
        assert.equal(readFileSync(outsideMarker, 'utf8'), 'outside-root-alias\n', 'escaping alias validation changed the outside target');
      } finally {
        removeLink(inboundLink);
        removeLink(escapeLink);
        removeLink(aliasAncestor);
        rmSync(installHome, { recursive: true, force: true });
        rmSync(aliasFixture, { recursive: true, force: true });
        rmSync(outside, { recursive: true, force: true });
      }
    },
  },
  {
    id: 'PKG-009-destination-refuses-reparse-point',
    run() {
      const installHome = mkdtempSync(path.join(os.tmpdir(), 'continuity-link-home-'));
      const outside = mkdtempSync(path.join(os.tmpdir(), 'continuity-link-out-'));
      const linkPath = path.join(installHome, 'skills', 'continuity');
      try {
        mkdirSync(path.dirname(linkPath), { recursive: true });
        const outsideMarker = path.join(outside, 'marker.txt');
        writeFileSync(outsideMarker, 'outside-reparse-marker\n');
        try {
          symlinkSync(outside, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
        } catch (error) {
          const skip = new Error(`cannot create test reparse point: ${error.code || error.message}`);
          skip.name = 'Skip';
          skip.reason = skip.message;
          throw skip;
        }
        assert.throws(() => assertSkillsDest(installHome, linkPath), /symlink|junction|reparse/);
        assert.throws(() => assertUninstallDest(installHome), /symlink|junction|reparse/);
        assert.equal(readFileSync(outsideMarker, 'utf8'), 'outside-reparse-marker\n', 'reparse rejection changed the outside target');
        assert.equal(lstatSync(linkPath).isSymbolicLink(), true, 'reparse rejection removed the unowned link');
      } finally {
        removeLink(linkPath);
        rmSync(installHome, { recursive: true, force: true });
        rmSync(outside, { recursive: true, force: true });
      }
    },
  },
  {
    id: 'PKG-015-distributable-allowlist-exact',
    run() {
      const expected = ['continuity', 'LICENSE', 'README.md', 'README.ru.md', 'SECURITY.md', 'examples', 'package.json'];
      const packageJson = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
      assert.deepEqual([...DISTRIBUTABLE_FILES], expected);
      assert.deepEqual(packageJson.files, expected);
      assert.equal(DISTRIBUTABLE_FILES.some((entry) => entry.startsWith('.codex')), false);
      assert.equal(DISTRIBUTABLE_FILES.some((entry) => entry.startsWith('.continuity')), false);
      assert.equal(DISTRIBUTABLE_FILES.some((entry) => entry.startsWith('.autopilot')), false);
    },
  },
  {
    id: 'PKG-016-pack-purity-and-equality',
    run() {
      const inventory = inventoryFromWorktree(repoRoot);
      const expected = expectedNpmPackFiles(inventory);
      const pack = runNpmPackDryRun(repoRoot);
      assertNpmPackEqualsDistributable(pack, inventory);
      assert.deepEqual(pack.files, expected);
      assert.throws(() => assertNpmPackPurity({ files: [...pack.files, '.autopilot/state.js'] }), /\.autopilot/);
      assert.throws(() => assertNpmPackPurity({ files: [...pack.files, `${RUNTIME_STORE_PREFIX}CURRENT.json`] }), /runtime store/);
      assert.equal(pack.files.some((file) => file.startsWith('.codex/')), false);
      assert.equal(pack.files.some((file) => file.startsWith('.continuity/')), false);
      assert.equal(pack.files.some((file) => file.split('/').includes('node_modules')), false);
    },
  },
  {
    id: 'PKG-019-license-and-lock-metadata',
    run() {
      const packageJson = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
      const packageLock = JSON.parse(readFileSync(path.join(repoRoot, 'package-lock.json'), 'utf8'));
      const license = readFileSync(path.join(repoRoot, 'LICENSE'), 'utf8').replaceAll('\r\n', '\n');
      assert.equal(packageJson.name, 'continuity');
      assert.equal(packageJson.private, true);
      assert.equal(packageJson.license, 'MIT');
      assert.equal(packageLock.name, packageJson.name);
      assert.equal(packageLock.packages[''].name, packageJson.name);
      assert.equal(packageLock.packages[''].license, packageJson.license);
      assert.match(license, /^MIT License\n/);
      assert.match(license, /Copyright \(c\) 2026 Altarnik88/);
    },
  },
  {
    id: 'PKG-020-no-images-in-worktree-or-pack',
    run() {
      const inventory = inventoryFromWorktree(repoRoot);
      const pack = runNpmPackDryRun(repoRoot);
      const image = /\.(?:avif|bmp|gif|ico|jpe?g|png|svg|tiff?|webp)$/i;
      assert.equal(inventory.all.some((file) => image.test(file)), false);
      assert.equal(pack.files.some((file) => image.test(file)), false);
      assert.equal(matchesDistributableAllowlist('docs/assets/hero.svg'), false);
    },
  },
  {
    id: 'PKG-021-ci-is-self-contained',
    run() {
      const good = readFileSync(path.join(repoRoot, '.github', 'workflows', 'ci.yml'), 'utf8');
      assert.doesNotThrow(() => assertCiWorkflowYaml(good));
      assert.throws(() => assertCiWorkflowYaml(`${good}\n      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262\n`), /exactly one/);
      assert.throws(() => assertCiWorkflowYaml(good.replace('cache: npm', 'repository: another/skill')), /another Skill repository/);
    },
  },
  {
    id: 'PKG-022-reject-sibling-skill',
    run() {
      const root = makeBoundaryRoot('sibling');
      try {
        mkdirSync(path.join(root, 'other-skill'), { recursive: true });
        writeFileSync(path.join(root, 'other-skill', 'SKILL.md'), '---\nname: other-skill\n---\n');
        assert.throws(() => assertRepositoryBoundaries(root, listRepositoryFiles(root)), /exactly one Skill subtree/);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  },
  {
    id: 'PKG-023-reject-images',
    run() {
      const root = makeBoundaryRoot('image');
      try {
        writeFileSync(path.join(root, 'hero.svg'), '<svg/>\n');
        assert.throws(() => assertRepositoryBoundaries(root, listRepositoryFiles(root)), /images are forbidden/);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  },
  {
    id: 'PKG-024-reject-root-autopilot-and-codex',
    run() {
      for (const forbidden of ['.autopilot', '.codex', '.continuity']) {
        const root = makeBoundaryRoot(forbidden.slice(1));
        try {
          mkdirSync(path.join(root, forbidden), { recursive: true });
          assert.throws(() => assertRepositoryBoundaries(root, listRepositoryFiles(root)), /forbidden repository directory/);
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      }
    },
  },
  {
    id: 'PKG-025-reject-cross-skill-runtime-import',
    run() {
      const root = makeBoundaryRoot('cross-skill');
      try {
        writeFileSync(
          path.join(root, 'continuity', 'scripts', 'bad.mjs'),
          "import '../../other-skill/scripts/helper.mjs';\n",
        );
        assert.throws(() => assertRepositoryBoundaries(root, listRepositoryFiles(root)), /import escapes its self-contained subtree/);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  },
  {
    id: 'PKG-026-reject-cyrillic-public-text',
    run() {
      const root = makeBoundaryRoot('cyrillic');
      try {
        const cyrillic = String.fromCodePoint(0x41f, 0x430, 0x43c, 0x44f, 0x442, 0x44c);
        writeFileSync(path.join(root, 'README.md'), `# ${cyrillic}\n`);
        assert.throws(() => assertRepositoryBoundaries(root, listRepositoryFiles(root)), /contains Cyrillic/);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  },
  {
    id: 'PKG-027-product-metadata-is-continuity',
    run() {
      const packageJson = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
      const metadata = JSON.stringify({
        name: packageJson.name,
        description: packageJson.description,
        repository: packageJson.repository,
        homepage: packageJson.homepage,
        bugs: packageJson.bugs,
      });
      assert.equal(packageJson.name, 'continuity');
      assert.equal(packageJson.repository.url, 'git+https://github.com/Altarnik88/continuity.git');
      assert.doesNotMatch(metadata, /codex|mnemosyne/i);
    },
  },
];
