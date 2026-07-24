/**
 * Pure decoder for Casper's serialized `NamedArgs` blob — the `List<U8>` an Odra proxy call
 * carries as its inner `args`.
 *
 * Why this exists: CSPR.cloud exposes **no contract-events endpoint** (probed live — `/contracts/
 * <hash>/events`, `/contract-events`, `/events` all return `endpoint not found`). What it does
 * expose is `/deploys?contract_package_hash=…`, which returns every call to the vault with its
 * inner argument blob already byte-parsed. So the chain-derived boards are rebuilt from the
 * package's transaction history, and this is the decoder that makes those bytes mean something.
 *
 * Wire format (mirrors `casper-js-sdk`'s `Args.toBytes()`, which `real-chain.ts` writes):
 *
 *   u32le argCount
 *   repeated argCount times:
 *     u32le nameLen, nameLen bytes of UTF-8 name
 *     u32le valueLen, valueLen bytes of CLValue payload
 *     1+ bytes of CLType tag
 *
 * A `String` payload is itself `u32le len + UTF-8`. Only the types the boards actually fold are
 * interpreted; everything else is returned as raw bytes rather than guessed at, because a decoder
 * that invents a value is worse than one that admits it does not know.
 */

/** CLType tag bytes, as far as this decoder needs to distinguish them. */
const CL_TYPE_U32 = 4;
const CL_TYPE_U64 = 5;
const CL_TYPE_STRING = 10;
const CL_TYPE_KEY = 11;
const CL_TYPE_LIST = 14;

export interface DecodedArg {
  name: string;
  /** The CLValue payload, without its type tag. */
  value: Uint8Array;
  /** First byte of the CLType tag. */
  typeTag: number;
}

function u32le(bytes: Uint8Array, offset: number): number | null {
  if (offset + 4 > bytes.length) return null;
  return (
    (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0
  );
}

/**
 * How many bytes the CLType tag at `offset` occupies.
 *
 * Only container types carry an inner tag; everything the vault sends is either a scalar or a
 * single-level `List`. An unknown tag is treated as one byte, which is the common case and keeps
 * a surprise from desynchronising the whole blob.
 */
function clTypeLength(bytes: Uint8Array, offset: number): number {
  return bytes[offset] === CL_TYPE_LIST ? 2 : 1;
}

/**
 * Decode a serialized NamedArgs blob. Returns `[]` for anything malformed rather than throwing —
 * one unreadable deploy must not take down a fold covering hundreds of good ones.
 */
export function decodeNamedArgs(raw: number[] | Uint8Array): DecodedArg[] {
  const bytes = raw instanceof Uint8Array ? raw : Uint8Array.from(raw);
  const count = u32le(bytes, 0);
  if (count === null || count > 64) return [];

  const args: DecodedArg[] = [];
  let at = 4;
  for (let i = 0; i < count; i++) {
    const nameLen = u32le(bytes, at);
    if (nameLen === null) return args;
    at += 4;
    if (at + nameLen > bytes.length) return args;
    const name = new TextDecoder().decode(bytes.subarray(at, at + nameLen));
    at += nameLen;

    const valueLen = u32le(bytes, at);
    if (valueLen === null) return args;
    at += 4;
    if (at + valueLen > bytes.length) return args;
    const value = bytes.subarray(at, at + valueLen);
    at += valueLen;

    if (at >= bytes.length) return args;
    const typeTag = bytes[at];
    at += clTypeLength(bytes, at);

    args.push({ name, value, typeTag });
  }
  return args;
}

/** Read a `String` argument by name, or `undefined` when absent or not a string. */
export function argString(args: DecodedArg[], name: string): string | undefined {
  const arg = args.find((a) => a.name === name);
  if (!arg || arg.typeTag !== CL_TYPE_STRING) return undefined;
  const len = u32le(arg.value, 0);
  if (len === null || 4 + len > arg.value.length) return undefined;
  return new TextDecoder().decode(arg.value.subarray(4, 4 + len));
}

/** Read a `U32`/`U64` argument by name as a decimal string, or `undefined`. */
export function argNumber(args: DecodedArg[], name: string): string | undefined {
  const arg = args.find((a) => a.name === name);
  if (!arg) return undefined;
  if (arg.typeTag === CL_TYPE_U32) {
    const n = u32le(arg.value, 0);
    return n === null ? undefined : String(n);
  }
  if (arg.typeTag === CL_TYPE_U64) {
    if (arg.value.length < 8) return undefined;
    let n = 0n;
    for (let i = 7; i >= 0; i--) n = (n << 8n) | BigInt(arg.value[i]);
    return n.toString();
  }
  return undefined;
}

/** Read a `List(String)` argument by name — the vault's `outcomes`. */
export function argStringList(args: DecodedArg[], name: string): string[] | undefined {
  const arg = args.find((a) => a.name === name);
  if (!arg || arg.typeTag !== CL_TYPE_LIST) return undefined;
  const count = u32le(arg.value, 0);
  if (count === null || count > 64) return undefined;
  const out: string[] = [];
  let at = 4;
  for (let i = 0; i < count; i++) {
    const len = u32le(arg.value, at);
    if (len === null) return out;
    at += 4;
    if (at + len > arg.value.length) return out;
    out.push(new TextDecoder().decode(arg.value.subarray(at, at + len)));
    at += len;
  }
  return out;
}

/** Read a `Key`/account argument by name as lowercase hex, dropping its 1-byte tag prefix. */
export function argAccountHex(args: DecodedArg[], name: string): string | undefined {
  const arg = args.find((a) => a.name === name);
  if (!arg || arg.typeTag !== CL_TYPE_KEY || arg.value.length < 33) return undefined;
  return Array.from(arg.value.subarray(1, 33), (b) => b.toString(16).padStart(2, "0")).join("");
}
