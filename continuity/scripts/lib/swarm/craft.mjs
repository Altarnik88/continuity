export const PULSE_FILES = {
  'package.json': `${JSON.stringify({
    name: 'pulse',
    version: '0.1.0',
    private: true,
    type: 'module',
    description: 'Project pulse tracker produced by the Continuity swarm.',
    scripts: {
      test: 'node --test test/*.test.mjs',
      start: 'node src/http.mjs',
      pulse: 'node src/cli.mjs',
    },
  }, null, 2)}\n`,

  'README.md': `# Pulse

Pulse is a small project-status tracker. The Continuity swarm builds it from a standing order: keep context, slice work, and do not accept the product on the user's behalf.

## Commands

\`\`\`bash
node src/cli.mjs add --project "Continuity" --status on_track --note "Swarm is live"
node src/cli.mjs list
node src/http.mjs
node --test test/*.test.mjs
\`\`\`

Statuses: \`on_track\`, \`at_risk\`, \`blocked\`.
`,

  'src/domain.mjs': `export const STATUSES = Object.freeze(['on_track', 'at_risk', 'blocked']);

export function normalizeProject(value) {
  const project = String(value ?? '').trim();
  if (!project) throw new Error('project is required');
  if (project.length > 80) throw new Error('project is too long');
  return project;
}

export function createPulse(input = {}) {
  const project = normalizeProject(input.project);
  const status = input.status ?? 'on_track';
  if (!STATUSES.includes(status)) throw new Error('status is invalid');
  const note = String(input.note ?? '').trim();
  if (note.length > 280) throw new Error('note is too long');
  return {
    id: String(input.id ?? crypto.randomUUID()),
    project,
    status,
    note,
    updatedAt: String(input.updatedAt ?? new Date().toISOString()),
  };
}

export function changeStatus(pulse, status) {
  return createPulse({ ...pulse, status, updatedAt: new Date().toISOString() });
}
`,

  'src/store.buggy.mjs': `import { createPulse } from './domain.mjs';

const items = [];

export function list() {
  return items.slice();
}

export function save(input) {
  const pulse = createPulse(input);
  items.push(pulse);
  return pulse;
}

export function get(id) {
  return items.find((item) => item.id === id) ?? null;
}
`,

  'src/store.mjs': `import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createPulse } from './domain.mjs';

const dataFile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../data/pulse.json');

function load() {
  if (!existsSync(dataFile)) return [];
  const parsed = JSON.parse(readFileSync(dataFile, 'utf8'));
  return Array.isArray(parsed) ? parsed : [];
}

function persist(items) {
  mkdirSync(path.dirname(dataFile), { recursive: true });
  writeFileSync(dataFile, JSON.stringify(items, null, 2) + '\\n');
}

export function list() {
  return load();
}

export function save(input) {
  const pulse = createPulse(input);
  const items = load();
  const index = items.findIndex((item) => item.id === pulse.id);
  if (index === -1) items.push(pulse);
  else items[index] = pulse;
  persist(items);
  return pulse;
}

export function get(id) {
  return load().find((item) => item.id === id) ?? null;
}
`,

  'src/service.mjs': `import { changeStatus, createPulse } from './domain.mjs';
import * as store from './store.mjs';

export function listPulses() {
  return store.list();
}

export function addPulse(input) {
  return store.save(createPulse(input));
}

export function setPulseStatus(id, status) {
  const current = store.get(id);
  if (!current) throw new Error('pulse not found');
  return store.save(changeStatus(current, status));
}
`,

  'src/http.mjs': `import { createServer } from 'node:http';

import { addPulse, listPulses } from './service.mjs';

export function createPulseServer() {
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    res.setHeader('content-type', 'application/json; charset=utf-8');
    try {
      if (req.method === 'GET' && url.pathname === '/health') {
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true, product: 'pulse' }));
        return;
      }
      if (req.method === 'GET' && url.pathname === '/pulses') {
        res.writeHead(200);
        res.end(JSON.stringify({ pulses: listPulses() }));
        return;
      }
      if (req.method === 'POST' && url.pathname === '/pulses') {
        const body = JSON.parse(await readBody(req) || '{}');
        const pulse = addPulse(body);
        res.writeHead(201);
        res.end(JSON.stringify({ pulse }));
        return;
      }
      res.writeHead(404);
      res.end(JSON.stringify({ error: 'not found' }));
    } catch (error) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : 'request failed' }));
    }
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const port = Number(process.env.PULSE_PORT || 0);
if (import.meta.url === \`file://\${process.argv[1]}\` && port > 0) {
  createPulseServer().listen(port);
}
`,

  'src/cli.mjs': `import { addPulse, listPulses } from './service.mjs';

function arg(flag) {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
}

const command = process.argv[2] ?? 'list';
if (command === 'list') {
  for (const pulse of listPulses()) {
    console.log(\`\${pulse.status.padEnd(9)} \${pulse.project}  \${pulse.note}\`);
  }
} else if (command === 'add') {
  const pulse = addPulse({
    project: arg('--project'),
    status: arg('--status') ?? 'on_track',
    note: arg('--note') ?? '',
  });
  console.log(\`recorded \${pulse.id}\`);
} else {
  console.error('usage: node src/cli.mjs <list|add> [--project name] [--status on_track] [--note text]');
  process.exitCode = 2;
}
`,

  'web/index.html': `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Pulse</title>
  <style>
    :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
    body { margin: 0; background: #09090b; color: #fafafa; }
    main { max-width: 720px; margin: 0 auto; padding: 32px 20px 80px; }
    h1 { font-size: 28px; letter-spacing: -0.04em; }
    p { color: #a1a1aa; line-height: 1.5; }
    .row { display: flex; justify-content: space-between; gap: 16px; padding: 12px 0; border-bottom: 1px solid #27272a; }
    .status { font-variant: small-caps; letter-spacing: 0.08em; color: #fbbf24; }
  </style>
</head>
<body>
  <main>
    <p>Product under swarm development</p>
    <h1>Pulse</h1>
    <p>Track whether the product is on track, at risk, or blocked. This page is a hand-built artifact of Continuity's standing order — not a claim that the user accepted the work.</p>
    <div id="list"></div>
  </main>
  <script>
    const seed = [
      { project: 'Continuity swarm', status: 'on_track', note: 'Memory and parallel work are live.' },
      { project: 'Pulse tracker', status: 'at_risk', note: 'Waiting for independent verification.' }
    ];
    document.getElementById('list').innerHTML = seed.map((item) =>
      '<div class="row"><div><strong>' + item.project + '</strong><div>' + item.note + '</div></div><div class="status">' + item.status.replace('_', ' ') + '</div></div>'
    ).join('');
  </script>
</body>
</html>
`,

  'test/domain.test.mjs': `import assert from 'node:assert/strict';
import test from 'node:test';

import { changeStatus, createPulse } from '../src/domain.mjs';

test('createPulse requires a project and a known status', () => {
  const pulse = createPulse({ project: ' Continuity ', note: 'keep going' });
  assert.equal(pulse.project, 'Continuity');
  assert.equal(pulse.status, 'on_track');
  assert.throws(() => createPulse({ project: ' ' }), /required/);
  assert.throws(() => createPulse({ project: 'X', status: 'done' }), /invalid/);
});

test('changeStatus returns a new pulse', () => {
  const pulse = createPulse({ project: 'Pulse', id: 'pulse-1' });
  const next = changeStatus(pulse, 'blocked');
  assert.equal(next.id, 'pulse-1');
  assert.equal(next.status, 'blocked');
  assert.equal(next.project, 'Pulse');
});
`,

  'test/store.test.mjs': `import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

test('store persists and upserts pulses', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pulse-store-'));
  const file = path.join(root, 'store.mjs');
  const domain = path.join(root, 'domain.mjs');
  const { readFileSync } = await import('node:fs');
  const here = path.resolve(path.dirname((await import('node:url')).fileURLToPath(import.meta.url)));
  writeFileSync(domain, readFileSync(path.join(here, '../src/domain.mjs')));
  const storeSource = readFileSync(path.join(here, '../src/store.mjs'), 'utf8')
    .replace("path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../data/pulse.json')", JSON.stringify(path.join(root, 'pulse.json')));
  writeFileSync(file, storeSource);
  const store = await import(pathToFileURL(file).href);
  const first = store.save({ project: 'Continuity', id: 'pulse-1' });
  store.save({ ...first, note: 'remembered' });
  assert.equal(store.list().length, 1);
  assert.equal(store.get('pulse-1').note, 'remembered');
});
`,

  'test/service.test.mjs': `import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

test('service lists and updates pulse status', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pulse-service-'));
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = path.join(root, 'src');
  const { mkdirSync } = await import('node:fs');
  mkdirSync(src);
  writeFileSync(path.join(src, 'domain.mjs'), readFileSync(path.join(here, '../src/domain.mjs')));
  const storeSource = readFileSync(path.join(here, '../src/store.mjs'), 'utf8')
    .replace("path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../data/pulse.json')", JSON.stringify(path.join(root, 'pulse.json')));
  writeFileSync(path.join(src, 'store.mjs'), storeSource);
  writeFileSync(path.join(src, 'service.mjs'), readFileSync(path.join(here, '../src/service.mjs')));
  const service = await import(pathToFileURL(path.join(src, 'service.mjs')).href);
  const pulse = service.addPulse({ project: 'Pulse', id: 'pulse-9' });
  const next = service.setPulseStatus(pulse.id, 'at_risk');
  assert.equal(next.status, 'at_risk');
  assert.equal(service.listPulses().length, 1);
});
`,
};

export function fileContents(key) {
  const body = PULSE_FILES[key];
  if (typeof body !== 'string') throw new Error(`unknown craft file: ${key}`);
  return body;
}
