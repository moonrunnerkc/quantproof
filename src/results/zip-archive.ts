/**
 * Minimal ZIP writer and reader against the documented PKWARE format
 * (local headers, central directory, EOCD), deflate-compressed via
 * node:zlib. Implemented in-repo for the same reason as the GGUF
 * reader: the format is small and stable, and a bundle people cite as
 * evidence should not depend on a third-party archiver.
 */

import { deflateRawSync, inflateRawSync } from 'node:zlib';

const LOCAL_HEADER_SIG = 0x04034b50;
const CENTRAL_HEADER_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
const DEFLATE = 8;
const STORE = 0;

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return c >>> 0;
});

/**
 * CRC-32 of a buffer (the polynomial ZIP requires).
 *
 * @param data - Bytes to checksum.
 * @returns Unsigned 32-bit CRC.
 */
export function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc = (CRC_TABLE[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** One file to place in (or read from) an archive. */
export interface ZipEntry {
  /** Forward-slash relative path inside the archive. */
  readonly path: string;
  readonly data: Buffer;
}

function dosDateTime(timestampMs: number): { time: number; date: number } {
  const d = new Date(timestampMs);
  return {
    time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | Math.floor(d.getUTCSeconds() / 2),
    date:
      ((Math.max(d.getUTCFullYear(), 1980) - 1980) << 9) |
      ((d.getUTCMonth() + 1) << 5) |
      d.getUTCDate(),
  };
}

/**
 * Builds a complete ZIP archive in memory.
 *
 * @param entries - Files in archive order; paths must be unique.
 * @param timestampMs - Modification time stamped on every entry, so
 *   the same inputs always produce byte-identical archives.
 * @returns The archive bytes.
 * @throws Error naming the duplicate when two entries share a path.
 */
export function writeZip(entries: readonly ZipEntry[], timestampMs: number): Buffer {
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.path)) {
      throw new Error(`duplicate zip entry "${entry.path}"; give every bundle file a unique path`);
    }
    seen.add(entry.path);
  }
  const { time, date } = dosDateTime(timestampMs);
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.path, 'utf8');
    const deflated = deflateRawSync(entry.data);
    const useDeflate = deflated.length < entry.data.length;
    const method = useDeflate ? DEFLATE : STORE;
    const payload = useDeflate ? deflated : entry.data;
    const crc = crc32(entry.data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_HEADER_SIG, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, payload);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(CENTRAL_HEADER_SIG, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    // extra, comment, disk, internal attrs, external attrs stay zero.
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + payload.length;
  }
  const centralSize = centrals.reduce((n, b) => n + b.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD_SIG, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, eocd]);
}

/**
 * Reads every entry of an archive produced by writeZip (or any plain
 * store/deflate ZIP without zip64 or encryption).
 *
 * @param archive - The archive bytes.
 * @returns Entries in central-directory order.
 * @throws Error when the archive is truncated, uses an unsupported
 *   compression method, or an entry fails its CRC check.
 */
export function readZip(archive: Buffer): ZipEntry[] {
  let eocdAt = -1;
  for (let i = archive.length - 22; i >= Math.max(0, archive.length - 22 - 65535); i -= 1) {
    if (archive.readUInt32LE(i) === EOCD_SIG) {
      eocdAt = i;
      break;
    }
  }
  if (eocdAt < 0) {
    throw new Error('not a zip archive (no end-of-central-directory record); the bundle file is truncated or not a bundle');
  }
  const count = archive.readUInt16LE(eocdAt + 10);
  let cursor = archive.readUInt32LE(eocdAt + 16);
  const entries: ZipEntry[] = [];
  for (let i = 0; i < count; i += 1) {
    if (archive.readUInt32LE(cursor) !== CENTRAL_HEADER_SIG) {
      throw new Error(`corrupt central directory at offset ${String(cursor)}; re-export the bundle`);
    }
    const method = archive.readUInt16LE(cursor + 10);
    const crc = archive.readUInt32LE(cursor + 16);
    const compressedSize = archive.readUInt32LE(cursor + 20);
    const nameLength = archive.readUInt16LE(cursor + 28);
    const extraLength = archive.readUInt16LE(cursor + 30);
    const commentLength = archive.readUInt16LE(cursor + 32);
    const localOffset = archive.readUInt32LE(cursor + 42);
    const path = archive.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');

    const localNameLength = archive.readUInt16LE(localOffset + 26);
    const localExtraLength = archive.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const payload = archive.subarray(dataStart, dataStart + compressedSize);
    let data: Buffer;
    if (method === DEFLATE) {
      data = inflateRawSync(payload);
    } else if (method === STORE) {
      data = Buffer.from(payload);
    } else {
      throw new Error(`zip entry "${path}" uses unsupported compression method ${String(method)}; only store and deflate are readable`);
    }
    if (crc32(data) !== crc) {
      throw new Error(`zip entry "${path}" failed its CRC check; the bundle file is corrupt, re-export it`);
    }
    entries.push({ path, data });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}
