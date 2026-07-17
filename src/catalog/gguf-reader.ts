/**
 * Minimal GGUF header reader, implemented in-repo against the
 * documented format (github.com/ggml-org/ggml/blob/master/docs/gguf.md)
 * instead of pulling in a dependency. Reads only the metadata KV
 * section; scalar and string values are returned, arrays are skipped
 * structurally. Used as a fallback when the backend API lacks a field.
 */

import { closeSync, openSync, readSync } from 'node:fs';

/** Scalar metadata value as stored in a GGUF header. */
export type GgufScalar = string | number | boolean;

const GGUF_MAGIC = 0x46554747; // "GGUF" little-endian

// Value type ids from the GGUF spec.
const enum GgufType {
  Uint8 = 0, Int8 = 1, Uint16 = 2, Int16 = 3, Uint32 = 4, Int32 = 5,
  Float32 = 6, Bool = 7, String = 8, Array = 9, Uint64 = 10, Int64 = 11, Float64 = 12,
}

/** Sequential buffered reader over a file descriptor. */
class ByteReader {
  private readonly fd: number;
  private position = 0;

  constructor(fd: number) {
    this.fd = fd;
  }

  read(length: number): Buffer {
    const buffer = Buffer.alloc(length);
    let filled = 0;
    while (filled < length) {
      const got = readSync(this.fd, buffer, filled, length - filled, this.position + filled);
      if (got === 0) {
        throw new Error(`gguf file ended after ${String(this.position + filled)} bytes while a value was still being read`);
      }
      filled += got;
    }
    this.position += length;
    return buffer;
  }

  skip(length: number): void {
    this.position += length;
  }

  u32(): number {
    return this.read(4).readUInt32LE(0);
  }

  u64(): number {
    const value = this.read(8).readBigUInt64LE(0);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error(`gguf u64 value ${value.toString()} exceeds the safe integer range`);
    }
    return Number(value);
  }

  string(): string {
    return this.read(this.u64()).toString('utf8');
  }
}

const SCALAR_SIZES: Partial<Record<GgufType, number>> = {
  [GgufType.Uint8]: 1, [GgufType.Int8]: 1, [GgufType.Uint16]: 2, [GgufType.Int16]: 2,
  [GgufType.Uint32]: 4, [GgufType.Int32]: 4, [GgufType.Float32]: 4, [GgufType.Bool]: 1,
  [GgufType.Uint64]: 8, [GgufType.Int64]: 8, [GgufType.Float64]: 8,
};

function readScalar(reader: ByteReader, type: GgufType): GgufScalar {
  switch (type) {
    case GgufType.Uint8: return reader.read(1).readUInt8(0);
    case GgufType.Int8: return reader.read(1).readInt8(0);
    case GgufType.Uint16: return reader.read(2).readUInt16LE(0);
    case GgufType.Int16: return reader.read(2).readInt16LE(0);
    case GgufType.Uint32: return reader.u32();
    case GgufType.Int32: return reader.read(4).readInt32LE(0);
    case GgufType.Float32: return reader.read(4).readFloatLE(0);
    case GgufType.Bool: return reader.read(1).readUInt8(0) !== 0;
    case GgufType.String: return reader.string();
    case GgufType.Uint64: return reader.u64();
    case GgufType.Int64: {
      const value = reader.read(8).readBigInt64LE(0);
      return Number(value);
    }
    case GgufType.Float64: return reader.read(8).readDoubleLE(0);
    default:
      throw new Error(`gguf metadata value has unknown type id ${String(type)}; the format may be newer than this reader`);
  }
}

function skipValue(reader: ByteReader, type: GgufType): void {
  if (type === GgufType.Array) {
    const elementType: GgufType = reader.u32();
    const count = reader.u64();
    const size = SCALAR_SIZES[elementType];
    if (size !== undefined) {
      reader.skip(count * size);
      return;
    }
    for (let i = 0; i < count; i += 1) {
      skipValue(reader, elementType);
    }
    return;
  }
  if (type === GgufType.String) {
    reader.skip(reader.u64());
    return;
  }
  const size = SCALAR_SIZES[type];
  if (size === undefined) {
    throw new Error(`gguf metadata value has unknown type id ${String(type)}; the format may be newer than this reader`);
  }
  reader.skip(size);
}

/**
 * Reads the metadata key/value section of a GGUF file.
 *
 * @param path - Path to a .gguf file (an Ollama blob is one).
 * @returns Scalar and string metadata entries by key; array-valued
 *   entries (tokenizer tables) are skipped and absent from the map.
 * @throws Error when the file is not GGUF, uses an unknown value type,
 *   or is truncated; callers degrade to "architecture unknown".
 */
export function readGgufMetadata(path: string): Map<string, GgufScalar> {
  const fd = openSync(path, 'r');
  try {
    const reader = new ByteReader(fd);
    if (reader.u32() !== GGUF_MAGIC) {
      throw new Error(`${path} is not a GGUF file (bad magic); expected an Ollama model blob`);
    }
    const version = reader.u32();
    if (version < 2 || version > 3) {
      throw new Error(`${path} uses GGUF version ${String(version)}; this reader supports versions 2 and 3`);
    }
    reader.u64(); // tensor count, not needed
    const kvCount = reader.u64();
    const entries = new Map<string, GgufScalar>();
    for (let i = 0; i < kvCount; i += 1) {
      const key = reader.string();
      const type: GgufType = reader.u32();
      if (type === GgufType.Array) {
        skipValue(reader, type);
      } else {
        entries.set(key, readScalar(reader, type));
      }
    }
    return entries;
  } finally {
    closeSync(fd);
  }
}
