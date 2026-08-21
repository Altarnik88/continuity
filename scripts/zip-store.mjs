import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

function crc32(buffer) {
  let crc = 0xFFFFFFFF;
  for (let index = 0; index < buffer.length; index += 1) {
    crc ^= buffer[index];
    for (let bit = 0; bit < 8; bit += 1) {
      const lsb = crc & 1;
      crc >>>= 1;
      if (lsb) crc ^= 0xEDB88320;
    }
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function u16(value) {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16LE(value);
  return buffer;
}

function u32(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value);
  return buffer;
}

export function buildStoredZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  const sorted = [...entries].sort((left, right) => left.name.localeCompare(right.name, 'en'));
  for (const entry of sorted) {
    const name = Buffer.from(entry.name, 'utf8');
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data);
    const crc = crc32(data);
    const local = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x03, 0x04]),
      u16(20),
      u16(0x0800),
      u16(0),
      u16(0),
      u16(0),
      u32(crc),
      u32(data.length),
      u32(data.length),
      u16(name.length),
      u16(0),
      name,
      data,
    ]);
    const central = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x01, 0x02]),
      u16(20),
      u16(20),
      u16(0x0800),
      u16(0),
      u16(0),
      u16(0),
      u32(crc),
      u32(data.length),
      u32(data.length),
      u16(name.length),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(0),
      u32(offset),
      name,
    ]);
    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const centralDir = Buffer.concat(centrals);
  const end = Buffer.concat([
    Buffer.from([0x50, 0x4b, 0x05, 0x06]),
    u16(0),
    u16(0),
    u16(sorted.length),
    u16(sorted.length),
    u32(centralDir.length),
    u32(offset),
    u16(0),
  ]);
  return Buffer.concat([...locals, centralDir, end]);
}

export function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

export function fileEntry(root, relative) {
  return {
    name: relative,
    data: readFileSync(path.join(root, ...relative.split('/'))),
  };
}
