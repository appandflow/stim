import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getExecutor } from '../exec.ts';
import { parsePlist, type PlistValue } from './ios-profile.ts';

export function schemesFromInfoPlist(plist: unknown): string[] {
  const types = (plist as { CFBundleURLTypes?: unknown })?.CFBundleURLTypes;
  if (!Array.isArray(types)) return [];
  const out: string[] = [];
  for (const type of types) {
    const schemes = (type as { CFBundleURLSchemes?: unknown })?.CFBundleURLSchemes;
    if (Array.isArray(schemes)) out.push(...schemes.filter((s) => typeof s === 'string' && s.trim() !== ''));
  }
  return out;
}

export function readBundleSchemes(
  appPath: unknown,
  { exec = null }: { exec?: import('../exec.ts').Executor | null } = {},
): string[] {
  if (typeof appPath !== 'string' || appPath.trim() === '') return [];
  const e = exec || getExecutor();
  const file = join(appPath, 'Info.plist');
  try {
    return schemesFromInfoPlist(
      JSON.parse(String(e.runFile('plutil', ['-convert', 'json', '-o', '-', file], { timeoutMs: 10_000 }))),
    );
  } catch {
    return schemesFromInfoPlist(readPlistFile(file));
  }
}

const APPLE_EPOCH_SECONDS = 978_307_200;

export function readPlistFile(file: string): PlistValue | null {
  try {
    const data = readFileSync(file);
    return data.subarray(0, 8).toString('latin1') === 'bplist00'
      ? parseBinaryPlist(data)
      : parsePlist(data.toString('utf8'));
  } catch {
    return null;
  }
}

function parseBinaryPlist(data: Buffer): PlistValue {
  const trailer = data.subarray(data.length - 32);
  if (trailer.length !== 32) throw new Error('truncated binary plist');
  const offsetSize = trailer.readUInt8(6);
  const refSize = trailer.readUInt8(7);
  const count = Number(trailer.readBigUInt64BE(8));
  const top = Number(trailer.readBigUInt64BE(16));
  const table = Number(trailer.readBigUInt64BE(24));
  const span = (at: number, size: number) => {
    if (at < 0 || size < 0 || at + size > data.length) throw new Error('binary plist offset out of range');
    return data.subarray(at, at + size);
  };
  const uint = (at: number, size: number) => span(at, size).reduce((value, byte) => value * 256 + byte, 0);
  const read = (ref: number): PlistValue => {
    if (ref >= count) throw new Error('binary plist reference out of range');
    let at = uint(table + ref * offsetSize, offsetSize);
    const marker = span(at++, 1).readUInt8();
    const info = marker & 0xf;
    const length = () => {
      if (info !== 0xf) return info;
      const size = 1 << (span(at, 1).readUInt8() & 0xf);
      const value = uint(at + 1, size);
      at += 1 + size;
      return value;
    };
    switch (marker >> 4) {
      case 0x0:
        return marker === 0x09;
      case 0x1: {
        const size = 1 << info;
        return size === 8 ? Number(span(at, 8).readBigInt64BE()) : uint(at, size);
      }
      case 0x2:
        return info === 2 ? span(at, 4).readFloatBE() : span(at, 8).readDoubleBE();
      case 0x3:
        return new Date((APPLE_EPOCH_SECONDS + span(at, 8).readDoubleBE()) * 1000);
      case 0x4: {
        const size = length();
        return Buffer.from(span(at, size));
      }
      case 0x5: {
        const size = length();
        return span(at, size).toString('latin1');
      }
      case 0x6: {
        const size = length() * 2;
        return Buffer.from(span(at, size)).swap16().toString('utf16le');
      }
      case 0xa: {
        const size = length();
        return Array.from({ length: size }, (_, i) => read(uint(at + i * refSize, refSize)));
      }
      case 0xd: {
        const size = length();
        const dict: { [key: string]: PlistValue } = {};
        for (let i = 0; i < size; i++) {
          const key = read(uint(at + i * refSize, refSize));
          if (typeof key !== 'string') throw new Error('binary plist dictionary key is not a string');
          dict[key] = read(uint(at + (size + i) * refSize, refSize));
        }
        return dict;
      }
      default:
        throw new Error(`unsupported binary plist object type ${marker.toString(16)}`);
    }
  };
  return read(top);
}

const THIRD_PARTY_SCHEME =
  /^(?:fb\d+|com\.googleusercontent\.apps\.|msauth\.|msauthv2|twitterkit-|db-[a-z0-9]+$|spotify|snapchat|com\.facebook)/i;

export function approvableSchemes(schemes: unknown): string[] {
  return (Array.isArray(schemes) ? schemes : [])
    .filter((s) => typeof s === 'string' && s.trim() !== '')
    .map((s) => s.trim())
    .filter((s) => !/^(?:https?|mailto|tel|sms|itms(?:-apps)?)$/i.test(s) && !THIRD_PARTY_SCHEME.test(s));
}

export function pickDevClientScheme(schemes: unknown): string | null {
  const all = approvableSchemes(schemes);
  const expo = all.filter((s) => s.startsWith('exp+'));
  const pool = expo.length ? expo : all;
  const sorted = pool.toSorted((a, b) => b.length - a.length);
  return sorted[0] ?? null;
}
