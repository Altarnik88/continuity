import { SECRET_AGENT_FIELDS } from './compatibility.mjs';

export const MAX_PROTOCOL_BYTES = 64 * 1024;
export const MAX_PROTOCOL_DEPTH = 16;
export const MAX_PROTOCOL_ITEMS = 50;
export const MAX_PROTOCOL_STRING = 2000;

const SECRET_KEY = new Set(SECRET_AGENT_FIELDS.map((key) => key.toLowerCase()));
const SECRET_KEY_EXTRA = new Set([
  'accesstoken', 'refreshtoken', 'privatekey', 'clientsecret', 'sessiontoken',
  'cookie', 'set-cookie', 'authorization', 'passwd', 'pwd',
]);
const SECRET_TEXT = [
  /sk_live_[A-Za-z0-9]{16,}/,
  /sk_test_[A-Za-z0-9]{16,}/,
  /xox[baprs]-[A-Za-z0-9-]{16,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /Bearer\s+[A-Za-z0-9._\-+/=]{16,}/,
  /(?:postgres|mysql|mongodb|redis):\/\/[^\s]+/i,
];

export class ProtocolError extends Error {
  constructor(message, exitCode = 2) {
    super(message);
    this.name = 'ProtocolError';
    this.exitCode = exitCode;
  }
}

function fail(message, exitCode = 2) {
  throw new ProtocolError(message, exitCode);
}

export function assertBoundedText(value, label, max = MAX_PROTOCOL_STRING) {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) {
    fail(`${label} is missing or exceeds ${max} characters`);
  }
  if (value !== value.normalize('NFC') || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value)) {
    fail(`${label} contains disallowed characters`);
  }
  return value;
}

export function rejectSecretText(value, label = 'payload') {
  if (typeof value !== 'string') return value;
  for (const pattern of SECRET_TEXT) {
    if (pattern.test(value)) fail(`${label} looks like a secret and is rejected`);
  }
  return value;
}

function walk(value, pathLabel, depth, seen) {
  if (depth > MAX_PROTOCOL_DEPTH) fail('protocol payload exceeds depth limit');
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'string') {
      if (value.length > MAX_PROTOCOL_STRING) fail(`${pathLabel} exceeds the string cap`);
      rejectSecretText(value, pathLabel);
    }
    return;
  }
  if (seen.has(value)) fail('protocol payload must not be cyclic');
  seen.add(value);
  if (Array.isArray(value)) {
    if (value.length > MAX_PROTOCOL_ITEMS) fail(`${pathLabel} exceeds the item cap`);
    value.forEach((item, index) => walk(item, `${pathLabel}[${index}]`, depth + 1, seen));
    return;
  }
  if (Object.getPrototypeOf(value) !== Object.prototype) {
    fail(`${pathLabel} must be a plain object`);
  }
  const keys = Object.keys(value);
  if (keys.length > MAX_PROTOCOL_ITEMS) fail(`${pathLabel} exceeds the field cap`);
  for (const key of keys) {
    const lower = key.toLowerCase();
    if (SECRET_KEY.has(key) || SECRET_KEY.has(lower) || SECRET_KEY_EXTRA.has(lower)) {
      fail(`protocol payload must not contain ${key}`);
    }
    walk(value[key], `${pathLabel}.${key}`, depth + 1, seen);
  }
}

export function assertSafePayload(value, label = 'payload') {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) fail(`${label} is not JSON`);
  if (Buffer.byteLength(encoded, 'utf8') > MAX_PROTOCOL_BYTES) {
    fail(`${label} exceeds ${MAX_PROTOCOL_BYTES} bytes`);
  }
  walk(value, label, 0, new WeakSet());
  return value;
}

export function assertKnownFields(value, allowed, label = 'record') {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown) fail(`${label} contains unknown field ${unknown}`);
  return value;
}

export function rejectPrivatePaths(value, label = 'path') {
  if (typeof value !== 'string' || !value.length) fail(`${label} is required`);
  if (value.startsWith('~') || value.startsWith('/') || value.startsWith('\\')
    || /^[A-Za-z]:/.test(value) || value.includes('..') || value.includes(':')) {
    fail(`${label} must be a repository-relative path`);
  }
  return value;
}
