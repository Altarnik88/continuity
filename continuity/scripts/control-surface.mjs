import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const htmlPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '../assets/control-surface.html');

export function startControlSurface(swarm, { port = 43147, host = '127.0.0.1' } = {}) {
  const html = readFileSync(htmlPath);
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${host}`);
    try {
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end(html);
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/swarm') {
        json(res, 200, swarm.getSnapshot());
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/swarm/control') {
        const body = JSON.parse(await readBody(req) || '{}');
        if (body.action === 'pause') swarm.pause();
        else if (body.action === 'resume') swarm.resume();
        else if (body.action === 'accept') swarm.accept();
        else if (body.action === 'resize') swarm.setSwarmSize(Number(body.swarmSize || 8));
        else {
          json(res, 400, { error: 'unknown action' });
          return;
        }
        json(res, 200, swarm.getSnapshot());
        return;
      }
      json(res, 404, { error: 'not found' });
    } catch (error) {
      json(res, 400, { error: error instanceof Error ? error.message : 'request failed' });
    }
  });
  return new Promise((resolve) => {
    server.listen(port, host, () => {
      resolve({ server, url: `http://${host}:${port}` });
    });
  });
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(`${JSON.stringify(body)}\n`);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
