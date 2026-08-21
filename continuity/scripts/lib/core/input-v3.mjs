import { types } from 'node:util';

import { MemoryError } from './errors.mjs';

export const MAX_V3_INPUT_BYTES = 64 * 1024;
export const MAX_V3_DEPTH = 16;
export const MAX_V3_ITEMS = 50;
export const MAX_V3_TOKENS = 8192;
export const MAX_V3_STRING_BYTES = 2000;

const BRANDED_V3 = new WeakSet();
const V3_BRAND = Symbol('projectMemory.v3.brand');

function fail(message, exitCode = 2) {
  throw new MemoryError(message, exitCode);
}

function isTypedBytes(value) {
  return typeof Buffer !== 'undefined' && typeof Buffer.isBuffer === 'function' && Buffer.isBuffer(value)
    ? 'buffer'
    : value instanceof Uint8Array ? 'uint8' : null;
}

function rejectUnbrandedObject() {
  fail('unbranded object input is not authority');
}

function utf8ByteLength(text) {
  return Buffer.byteLength(text, 'utf8');
}

function assertValidUnicodeText(text, label = 'authoritative input') {
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    if (unit >= 0xD800 && unit <= 0xDBFF) {
      const next = text.charCodeAt(index + 1);
      if (!(next >= 0xDC00 && next <= 0xDFFF)) fail(`${label} contains invalid Unicode`);
      index += 1;
    } else if (unit >= 0xDC00 && unit <= 0xDFFF) {
      fail(`${label} contains invalid Unicode`);
    }
  }
}

function decodeCopiedBytes(bytes) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    fail('authoritative input is not valid UTF-8');
  }
}

function copyBytes(input, kind) {
  if (kind === 'buffer') return Buffer.from(input);
  const copy = new Uint8Array(input.byteLength);
  copy.set(input);
  return copy;
}

function skipWs(text, index) {
  let cursor = index;
  while (cursor < text.length) {
    const code = text.charCodeAt(cursor);
    if (code !== 0x20 && code !== 0x09 && code !== 0x0A && code !== 0x0D) break;
    cursor += 1;
  }
  return cursor;
}

function scanString(text, start) {
  let index = start + 1;
  let bytes = 0;
  while (index < text.length) {
    const code = text.charCodeAt(index);
    if (code === 0x22) {
      if (bytes > MAX_V3_STRING_BYTES) fail('JSON string exceeds the byte cap');
      return index + 1;
    }
    if (code <= 0x1F) fail('JSON string contains an unescaped control character');
    if (code === 0x5C) {
      if (index + 1 >= text.length) fail('JSON string has an invalid escape');
      const escape = text.charCodeAt(index + 1);
      if (escape === 0x22 || escape === 0x5C || escape === 0x2F || escape === 0x62
        || escape === 0x66 || escape === 0x6E || escape === 0x72 || escape === 0x74) {
        bytes += escape === 0x22 || escape === 0x5C || escape === 0x2F ? 1 : 1;
        index += 2;
        continue;
      }
      if (escape === 0x75) {
        if (index + 6 > text.length) fail('JSON string has an invalid Unicode escape');
        const hex = text.slice(index + 2, index + 6);
        if (!/^[0-9A-Fa-f]{4}$/.test(hex)) fail('JSON string has an invalid Unicode escape');
        const unit = Number.parseInt(hex, 16);
        if (unit >= 0xDC00 && unit <= 0xDFFF) fail('JSON string contains invalid Unicode');
        if (unit >= 0xD800 && unit <= 0xDBFF) {
          const next = text.slice(index + 6, index + 12);
          if (!/^\\u[0-9A-Fa-f]{4}$/.test(next)) fail('JSON string contains invalid Unicode');
          const low = Number.parseInt(next.slice(2), 16);
          if (!(low >= 0xDC00 && low <= 0xDFFF)) fail('JSON string contains invalid Unicode');
          bytes += 4;
          index += 12;
          continue;
        }
        bytes += unit <= 0x7F ? 1 : unit <= 0x7FF ? 2 : 3;
        index += 6;
        continue;
      }
      fail('JSON string has an invalid escape');
    }
    if (code >= 0xD800 && code <= 0xDBFF) {
      const next = text.charCodeAt(index + 1);
      if (!(next >= 0xDC00 && next <= 0xDFFF)) fail('JSON string contains invalid Unicode');
      bytes += 4;
      index += 2;
      continue;
    }
    if (code >= 0xDC00 && code <= 0xDFFF) fail('JSON string contains invalid Unicode');
    bytes += code <= 0x7F ? 1 : code <= 0x7FF ? 2 : 3;
    index += 1;
  }
  fail('JSON string is not terminated');
}

function scanNumber(text, start) {
  let index = start;
  if (text.charCodeAt(index) === 0x2D) index += 1;
  if (index >= text.length) fail('JSON number is invalid');
  const first = text.charCodeAt(index);
  if (first < 0x30 || first > 0x39) fail('JSON number is invalid');
  if (first === 0x30) {
    index += 1;
  } else {
    index += 1;
    while (index < text.length) {
      const code = text.charCodeAt(index);
      if (code < 0x30 || code > 0x39) break;
      index += 1;
    }
  }
  const next = index < text.length ? text.charCodeAt(index) : -1;
  if (next === 0x2E || next === 0x65 || next === 0x45) fail('JSON numbers must be safe integers; floats are forbidden');
  const token = text.slice(start, index);
  if (token === '-0') fail('JSON numbers must be safe integers');
  let value;
  try {
    value = BigInt(token);
  } catch {
    fail('JSON number is invalid');
  }
  if (value > 9007199254740991n || value < -9007199254740991n) fail('JSON number is outside the safe integer range');
  return index;
}

function scanLiteral(text, start, literal) {
  if (text.slice(start, start + literal.length) !== literal) fail('JSON literal is invalid');
  return start + literal.length;
}

function prescanJson(text) {
  let index = skipWs(text, 0);
  if (index >= text.length) fail('authoritative input is empty');
  let tokens = 0;
  const stack = [];
  let expectingValue = true;
  let finished = false;

  const pushContainer = (kind) => {
    if (stack.length + 1 > MAX_V3_DEPTH) fail('JSON nesting exceeds the depth cap');
    stack.push({ kind, items: 0, keys: kind === 'object' ? new Set() : null, expect: kind === 'object' ? 'key-or-end' : 'value-or-end' });
    expectingValue = kind === 'array';
  };

  const noteItem = () => {
    const frame = stack[stack.length - 1];
    if (!frame) return;
    frame.items += 1;
    if (frame.items > MAX_V3_ITEMS) fail('JSON container exceeds the item cap');
  };

  while (index < text.length) {
    index = skipWs(text, index);
    if (index >= text.length) break;
    if (finished) fail('authoritative input contains trailing JSON');
    const code = text.charCodeAt(index);
    const frame = stack[stack.length - 1];

    if (!expectingValue && frame?.kind === 'object' && frame.expect === 'colon') {
      if (code !== 0x3A) fail('JSON object is missing a colon');
      index += 1;
      tokens += 1;
      if (tokens > MAX_V3_TOKENS) fail('JSON token cap exceeded');
      frame.expect = 'value';
      expectingValue = true;
      continue;
    }

    if (!expectingValue && frame && (code === 0x2C || code === 0x7D || code === 0x5D)) {
      if (code === 0x2C) {
        if (frame.items < 1) fail('JSON container has a leading comma');
        index += 1;
        tokens += 1;
        if (tokens > MAX_V3_TOKENS) fail('JSON token cap exceeded');
        expectingValue = frame.kind === 'array';
        frame.expect = frame.kind === 'object' ? 'key' : 'value';
        continue;
      }
      if (code === 0x7D && frame.kind === 'object') {
        index += 1;
        stack.pop();
        tokens += 1;
        if (tokens > MAX_V3_TOKENS) fail('JSON token cap exceeded');
        expectingValue = false;
        if (stack.length === 0) finished = true;
        continue;
      }
      if (code === 0x5D && frame.kind === 'array') {
        index += 1;
        stack.pop();
        tokens += 1;
        if (tokens > MAX_V3_TOKENS) fail('JSON token cap exceeded');
        expectingValue = false;
        if (stack.length === 0) finished = true;
        continue;
      }
      fail('JSON container is malformed');
    }

    if (frame?.kind === 'object' && (frame.expect === 'key' || frame.expect === 'key-or-end')) {
      if (code === 0x7D && frame.expect === 'key-or-end') {
        index += 1;
        stack.pop();
        tokens += 1;
        if (tokens > MAX_V3_TOKENS) fail('JSON token cap exceeded');
        expectingValue = false;
        if (stack.length === 0) finished = true;
        continue;
      }
      if (code !== 0x22) fail('JSON object key must be a string');
      const keyStart = index;
      index = scanString(text, index);
      const rawKey = text.slice(keyStart, index);
      let key;
      try {
        key = JSON.parse(rawKey);
      } catch {
        fail('JSON object key is invalid');
      }
      if (frame.keys.has(key)) fail('JSON object contains a duplicate key');
      frame.keys.add(key);
      tokens += 1;
      if (tokens > MAX_V3_TOKENS) fail('JSON token cap exceeded');
      frame.expect = 'colon';
      expectingValue = false;
      continue;
    }

    if (frame?.kind === 'array' && frame.items === 0 && code === 0x5D) {
      index += 1;
      stack.pop();
      tokens += 1;
      if (tokens > MAX_V3_TOKENS) fail('JSON token cap exceeded');
      expectingValue = false;
      if (stack.length === 0) finished = true;
      continue;
    }

    if (!expectingValue) fail('JSON text is malformed');

    tokens += 1;
    if (tokens > MAX_V3_TOKENS) fail('JSON token cap exceeded');

    if (code === 0x7B) {
      index += 1;
      if (frame) noteItem();
      pushContainer('object');
      continue;
    }
    if (code === 0x5B) {
      index += 1;
      if (frame) noteItem();
      pushContainer('array');
      continue;
    }
    if (code === 0x22) {
      index = scanString(text, index);
      if (frame) noteItem();
      expectingValue = false;
      if (stack.length === 0) finished = true;
      continue;
    }
    if (code === 0x2D || (code >= 0x30 && code <= 0x39)) {
      index = scanNumber(text, index);
      if (frame) noteItem();
      expectingValue = false;
      if (stack.length === 0) finished = true;
      continue;
    }
    if (code === 0x74) {
      index = scanLiteral(text, index, 'true');
      if (frame) noteItem();
      expectingValue = false;
      if (stack.length === 0) finished = true;
      continue;
    }
    if (code === 0x66) {
      index = scanLiteral(text, index, 'false');
      if (frame) noteItem();
      expectingValue = false;
      if (stack.length === 0) finished = true;
      continue;
    }
    if (code === 0x6E) {
      index = scanLiteral(text, index, 'null');
      if (frame) noteItem();
      expectingValue = false;
      if (stack.length === 0) finished = true;
      continue;
    }
    fail('JSON text is malformed');
  }

  if (!finished || stack.length !== 0) fail('JSON text is truncated');
  if (skipWs(text, index) !== text.length) fail('authoritative input contains trailing JSON');
}

export function canonicalV3(value) {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'string') {
    assertValidUnicodeText(value, 'JCS string');
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) fail('v3 canonical JSON permits safe integers only');
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_V3_ITEMS) fail('JCS array exceeds the item limit');
    return `[${value.map(canonicalV3).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    let prototype;
    try {
      prototype = Object.getPrototypeOf(value);
    } catch {
      fail('value is not JCS-compatible JSON');
    }
    if (prototype !== Object.prototype && prototype !== null) fail('value is not JCS-compatible JSON');
    const keys = Object.keys(value);
    if (keys.length > MAX_V3_ITEMS) fail('JCS object exceeds the property limit');
    for (const key of keys) {
      if (typeof key !== 'string') fail('JCS object key is invalid');
      assertValidUnicodeText(key, 'JCS object key');
    }
    return `{${keys.sort().map((key) => `${JSON.stringify(key)}:${canonicalV3(value[key])}`).join(',')}}`;
  }
  fail('value is not JCS-compatible JSON');
}

function freezeBrandIterative(value) {
  const stack = [value];
  const seen = new Set();
  while (stack.length) {
    const current = stack.pop();
    if (current === null || typeof current !== 'object' || seen.has(current)) continue;
    seen.add(current);
    if (Array.isArray(current)) {
      if (Object.getPrototypeOf(current) !== Array.prototype) fail('parsed JSON array is not module-owned');
      for (let index = current.length - 1; index >= 0; index -= 1) stack.push(current[index]);
    } else {
      const prototype = Object.getPrototypeOf(current);
      if (prototype !== Object.prototype && prototype !== null) fail('parsed JSON object is not module-owned');
      const keys = Object.keys(current);
      for (let index = keys.length - 1; index >= 0; index -= 1) stack.push(current[keys[index]]);
    }
    Object.freeze(current);
  }
  canonicalV3(value);
  BRANDED_V3.add(value);
  try {
    Object.defineProperty(value, V3_BRAND, { value: true, enumerable: false, configurable: false, writable: false });
  } catch {
    // primitives are not branded objects; objects should accept a non-enumerable brand
  }
  return value;
}

export function isBrandedV3(value) {
  return (value !== null && typeof value === 'object' && BRANDED_V3.has(value)) === true;
}

export function brandOwnedV3(value) {
  if (value === null || typeof value !== 'object') fail('owned v3 snapshot must be an object');
  return freezeBrandIterative(value);
}

function captureFromText(text) {
  if (typeof text !== 'string') fail('authoritative input must be JSON text or bytes');
  assertValidUnicodeText(text);
  if (utf8ByteLength(text) > MAX_V3_INPUT_BYTES) fail('authoritative input exceeds the 64 KiB cap');
  prescanJson(text);
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail('authoritative input is not valid JSON');
  }
  if (parsed === null || typeof parsed !== 'object') fail('authoritative v3 input must be a JSON object');
  return freezeBrandIterative(parsed);
}

export function captureAuthoritativeInput(input) {
  if (arguments.length !== 1) fail('authoritative input arity is invalid');
  const type = typeof input;
  if (type === 'string') return captureFromText(input);
  if (type !== 'object' || input === null) fail('authoritative input must be JSON text or bytes');
  if (types.isProxy(input)) rejectUnbrandedObject();
  const kind = isTypedBytes(input);
  if (!kind) rejectUnbrandedObject();
  const copied = copyBytes(input, kind);
  if (copied.byteLength > MAX_V3_INPUT_BYTES) fail('authoritative input exceeds the 64 KiB cap');
  return captureFromText(decodeCopiedBytes(copied));
}
