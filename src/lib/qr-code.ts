/**
 * A QR encoder, because the WalletConnect pairing URI has to reach a phone.
 *
 * ## Why this is in the repo rather than in `package.json`
 *
 * The only thing the pairing UI needs is a matrix of dark/light modules for one short ASCII string,
 * rendered as inline SVG. Every published QR library brings a canvas/DOM renderer, a build step, and
 * a supply-chain surface for that; this is ~300 lines of pure arithmetic with no dependencies, no
 * browser API, and no bundle cost beyond itself.
 *
 * The reason that trade is safe is the testing. `test/qr-code.test.ts` carries a *decoder* written
 * from the standard and points it at two things: our symbols (which must read back with every
 * Reed–Solomon syndrome zero) and `segno`'s symbols for the same payloads (which must decode with
 * our block tables and geometry), across every version 1–40 and all four levels. On top of that,
 * `scripts/qr-fixtures.py` feeds our own matrices to `zxing-cpp` — the decoder behind many
 * production scanners — and refuses to regenerate the fixture unless every one reads back. So "the
 * QR is subtly wrong and nothing scans" is a failure this repo can actually detect.
 *
 * Scope is deliberately narrow: **byte mode only**, versions 1–40, all four error-correction levels.
 * Numeric/alphanumeric/kanji modes would encode a URI *smaller*, but only by re-implementing three
 * more segment encoders for a payload (`wc:…@2?relay-protocol=irn&symKey=…`) that is mixed-case and
 * therefore byte-mode anyway.
 *
 * Reference: ISO/IEC 18004. The structure below follows the standard's own vocabulary — codewords,
 * blocks, function patterns, masks — so it can be checked against the spec rather than trusted.
 */

export type QrEccLevel = "L" | "M" | "Q" | "H";

export interface QrCode {
  /** Symbol version, 1–40. The module count is `4 * version + 17` per side. */
  readonly version: number;
  /** Modules per side, including no quiet zone (the caller adds one; SVG output does). */
  readonly size: number;
  readonly ecc: QrEccLevel;
  /** Row-major dark/light modules: `modules[y][x]`. */
  readonly modules: readonly (readonly boolean[])[];
}

/**
 * Error-correction codewords per block, and the block count, per version (index = version − 1).
 *
 * This is the one part of QR that is pure table — the standard's Tables 13–22. The values were
 * transcribed from a reference implementation and then *checked*, not trusted: for every version and
 * level, `blocks × (dataPerBlock) + blocks × ecPerBlock` must equal the symbol's raw codeword
 * capacity computed independently by `rawDataModules()`. `test/qr-code.test.ts` re-runs that check.
 */
const ECC_CODEWORDS_PER_BLOCK: Record<QrEccLevel, readonly number[]> = {
  L: [7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30,
    26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  M: [10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28,
    28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  Q: [13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30,
    30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  H: [17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30,
    30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
};

const NUM_ERROR_CORRECTION_BLOCKS: Record<QrEccLevel, readonly number[]> = {
  L: [1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14,
    15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  M: [1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25,
    26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  Q: [1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34,
    34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  H: [1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37,
    40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
};

/** The two bits the format information carries for each level — L is `01`, not `00`. */
const ECC_FORMAT_BITS: Record<QrEccLevel, number> = { L: 1, M: 0, Q: 3, H: 2 };

const MIN_VERSION = 1;
const MAX_VERSION = 40;

/** Data modules available before error correction, i.e. the symbol minus every function pattern. */
export function rawDataModules(version: number): number {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const numAlign = Math.floor(version / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (version >= 7) result -= 36; // the two version-information blocks
  }
  return result;
}

/** Data codewords (8-bit) a version/level pair can carry, error correction already subtracted. */
export function dataCodewordCapacity(version: number, ecc: QrEccLevel): number {
  const blocks = NUM_ERROR_CORRECTION_BLOCKS[ecc][version - 1];
  return Math.floor(rawDataModules(version) / 8) - blocks * ECC_CODEWORDS_PER_BLOCK[ecc][version - 1];
}

/** Byte-mode character-count indicator width. It widens at version 10, which is a classic off-by-9. */
function charCountBits(version: number): number {
  return version <= 9 ? 8 : 16;
}

/**
 * Centre coordinates of the alignment patterns. Computed rather than tabulated: the spacing rule is
 * "evenly spaced, even coordinates, first at 6, last at size−7", with version 32 as the standard's
 * one irregular case.
 */
export function alignmentPatternPositions(version: number): number[] {
  if (version === 1) return [];
  const numAlign = Math.floor(version / 7) + 2;
  const step =
    version === 32 ? 26 : Math.ceil((version * 4 + 4) / (numAlign * 2 - 2)) * 2;
  const result: number[] = [6];
  for (let pos = version * 4 + 10; result.length < numAlign; pos -= step) result.splice(1, 0, pos);
  return result;
}

// ---------------------------------------------------------------------------------------------
// GF(2^8) arithmetic for Reed–Solomon, primitive polynomial x^8 + x^4 + x^3 + x^2 + 1 (0x11D).
// ---------------------------------------------------------------------------------------------

function gfMultiply(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

/** Generator polynomial of degree `degree`, coefficients in descending order without the leading 1. */
function reedSolomonGenerator(degree: number): number[] {
  const result = new Array<number>(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      result[j] = gfMultiply(result[j], root);
      if (j + 1 < degree) result[j] ^= result[j + 1];
    }
    root = gfMultiply(root, 0x02);
  }
  return result;
}

function reedSolomonRemainder(data: readonly number[], generator: readonly number[]): number[] {
  const result = new Array<number>(generator.length).fill(0);
  for (const byte of data) {
    const factor = byte ^ (result.shift() as number);
    result.push(0);
    for (let i = 0; i < generator.length; i++) result[i] ^= gfMultiply(generator[i], factor);
  }
  return result;
}

// ---------------------------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------------------------

/** The smallest version that fits `byteLength` bytes at this level, or `null` if none does. */
export function smallestVersionFor(byteLength: number, ecc: QrEccLevel): number | null {
  for (let version = MIN_VERSION; version <= MAX_VERSION; version++) {
    const capacityBits = dataCodewordCapacity(version, ecc) * 8;
    const neededBits = 4 + charCountBits(version) + byteLength * 8;
    if (neededBits <= capacityBits) return version;
  }
  return null;
}

function bitsToCodewords(bits: readonly number[], capacity: number): number[] {
  const padded = bits.slice();
  // Terminator, then pad to a byte boundary, then the standard alternating pad codewords.
  const capacityBits = capacity * 8;
  for (let i = 0; i < 4 && padded.length < capacityBits; i++) padded.push(0);
  while (padded.length % 8 !== 0) padded.push(0);
  const codewords: number[] = [];
  for (let i = 0; i < padded.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | padded[i + j];
    codewords.push(byte);
  }
  for (let pad = 0xec; codewords.length < capacity; pad ^= 0xec ^ 0x11) codewords.push(pad);
  return codewords;
}

/** How a version/level splits its codewords into Reed–Solomon blocks. */
export interface QrBlockStructure {
  numBlocks: number;
  ecPerBlock: number;
  /** Blocks carrying the smaller data length; the rest carry one codeword more. */
  numShortBlocks: number;
  shortBlockDataLen: number;
}

export function blockStructure(version: number, ecc: QrEccLevel): QrBlockStructure {
  const numBlocks = NUM_ERROR_CORRECTION_BLOCKS[ecc][version - 1];
  const ecPerBlock = ECC_CODEWORDS_PER_BLOCK[ecc][version - 1];
  const rawCodewords = Math.floor(rawDataModules(version) / 8);
  return {
    numBlocks,
    ecPerBlock,
    numShortBlocks: numBlocks - (rawCodewords % numBlocks),
    shortBlockDataLen: Math.floor(rawCodewords / numBlocks) - ecPerBlock,
  };
}

/** Data codewords + error correction, interleaved into the order the matrix is filled in. */
function interleave(data: readonly number[], version: number, ecc: QrEccLevel): number[] {
  const { numBlocks, ecPerBlock, numShortBlocks, shortBlockDataLen } = blockStructure(version, ecc);

  const generator = reedSolomonGenerator(ecPerBlock);
  const blocks: number[][] = [];
  const eccBlocks: number[][] = [];
  for (let i = 0, k = 0; i < numBlocks; i++) {
    const len = shortBlockDataLen + (i < numShortBlocks ? 0 : 1);
    const block = data.slice(k, k + len);
    k += len;
    blocks.push(block);
    eccBlocks.push(reedSolomonRemainder(block, generator));
  }

  const result: number[] = [];
  for (let i = 0; i < shortBlockDataLen + 1; i++) {
    for (let b = 0; b < numBlocks; b++) {
      // The longer blocks' extra codeword comes last, after every short block is exhausted.
      if (i < blocks[b].length) result.push(blocks[b][i]);
    }
  }
  for (let i = 0; i < ecPerBlock; i++) {
    for (let b = 0; b < numBlocks; b++) result.push(eccBlocks[b][i]);
  }
  return result;
}

// ---------------------------------------------------------------------------------------------
// Matrix construction
// ---------------------------------------------------------------------------------------------

class Matrix {
  readonly version: number;
  readonly size: number;
  readonly modules: boolean[][];
  /** Function patterns must not be masked, and data must not be written over them. */
  readonly reserved: boolean[][];

  constructor(version: number) {
    this.version = version;
    this.size = version * 4 + 17;
    this.modules = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
    this.reserved = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
  }

  set(x: number, y: number, dark: boolean, reserve = true): void {
    this.modules[y][x] = dark;
    if (reserve) this.reserved[y][x] = true;
  }
}

function drawFinderPattern(m: Matrix, centreX: number, centreY: number): void {
  for (let dy = -4; dy <= 4; dy++) {
    for (let dx = -4; dx <= 4; dx++) {
      const x = centreX + dx;
      const y = centreY + dy;
      if (x < 0 || x >= m.size || y < 0 || y >= m.size) continue;
      const distance = Math.max(Math.abs(dx), Math.abs(dy));
      m.set(x, y, distance !== 2 && distance !== 4);
    }
  }
}

function drawAlignmentPattern(m: Matrix, centreX: number, centreY: number): void {
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      m.set(centreX + dx, centreY + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
  }
}

function drawFunctionPatterns(m: Matrix): void {
  // Timing patterns.
  for (let i = 0; i < m.size; i++) {
    m.set(6, i, i % 2 === 0);
    m.set(i, 6, i % 2 === 0);
  }
  drawFinderPattern(m, 3, 3);
  drawFinderPattern(m, m.size - 4, 3);
  drawFinderPattern(m, 3, m.size - 4);

  const positions = alignmentPatternPositions(m.version);
  for (let i = 0; i < positions.length; i++) {
    for (let j = 0; j < positions.length; j++) {
      // The three corners are occupied by finder patterns.
      const corner =
        (i === 0 && j === 0) ||
        (i === 0 && j === positions.length - 1) ||
        (i === positions.length - 1 && j === 0);
      if (!corner) drawAlignmentPattern(m, positions[j], positions[i]);
    }
  }

  // Reserve the format-information modules; the real bits are written once the mask is chosen.
  drawFormatBits(m, "L", 0, true);
  if (m.version >= 7) drawVersionBits(m);
}

/** BCH(15,5)-encoded format information, written twice, plus the always-dark module. */
function drawFormatBits(m: Matrix, ecc: QrEccLevel, mask: number, reserveOnly = false): void {
  const data = (ECC_FORMAT_BITS[ecc] << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const bits = ((data << 10) | rem) ^ 0x5412;

  const bit = (i: number): boolean => (reserveOnly ? false : ((bits >>> i) & 1) !== 0);

  // First copy: around the top-left finder.
  for (let i = 0; i <= 5; i++) m.set(8, i, bit(i));
  m.set(8, 7, bit(6));
  m.set(8, 8, bit(7));
  m.set(7, 8, bit(8));
  for (let i = 9; i < 15; i++) m.set(14 - i, 8, bit(i));

  // Second copy: split between the other two finders.
  for (let i = 0; i < 8; i++) m.set(m.size - 1 - i, 8, bit(i));
  for (let i = 8; i < 15; i++) m.set(8, m.size - 15 + i, bit(i));
  m.set(8, m.size - 8, true); // the dark module, always set
}

/** BCH(18,6) version information, versions 7 and up. */
function drawVersionBits(m: Matrix): void {
  let rem = m.version;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  const bits = (m.version << 12) | rem;
  for (let i = 0; i < 18; i++) {
    const dark = ((bits >>> i) & 1) !== 0;
    const a = m.size - 11 + (i % 3);
    const b = Math.floor(i / 3);
    m.set(a, b, dark);
    m.set(b, a, dark);
  }
}

/** Fill the data modules in the standard upward/downward zigzag, two columns at a time. */
function drawCodewords(m: Matrix, codewords: readonly number[]): void {
  let i = 0; // bit index into the codeword stream
  for (let right = m.size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5; // skip the vertical timing pattern column
    for (let vert = 0; vert < m.size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? m.size - 1 - vert : vert;
        if (m.reserved[y][x]) continue;
        // Any remainder bits past the codeword stream stay light, as the standard requires.
        const dark = i < codewords.length * 8 && ((codewords[i >>> 3] >>> (7 - (i & 7))) & 1) !== 0;
        m.modules[y][x] = dark;
        i++;
      }
    }
  }
}

function maskBit(mask: number, x: number, y: number): boolean {
  switch (mask) {
    case 0: return (x + y) % 2 === 0;
    case 1: return y % 2 === 0;
    case 2: return x % 3 === 0;
    case 3: return (x + y) % 3 === 0;
    case 4: return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
    case 5: return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6: return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    default: return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
  }
}

function applyMask(m: Matrix, mask: number): void {
  for (let y = 0; y < m.size; y++) {
    for (let x = 0; x < m.size; x++) {
      if (!m.reserved[y][x] && maskBit(mask, x, y)) m.modules[y][x] = !m.modules[y][x];
    }
  }
}

/**
 * The standard's four penalty rules (§8.8.2). Lower is better; the encoder tries all eight masks and
 * keeps the best, which is what makes two independent encoders agree module-for-module.
 */
export function maskPenalty(modules: readonly (readonly boolean[])[]): number {
  const size = modules.length;
  let penalty = 0;

  // Rule 1: runs of five or more same-coloured modules in a row or column.
  for (const transpose of [false, true]) {
    for (let a = 0; a < size; a++) {
      let runColour = false;
      let runLength = 0;
      for (let b = 0; b < size; b++) {
        const dark = transpose ? modules[b][a] : modules[a][b];
        if (dark === runColour) {
          runLength++;
          if (runLength === 5) penalty += 3;
          else if (runLength > 5) penalty += 1;
        } else {
          runColour = dark;
          runLength = 1;
        }
      }
    }
  }

  // Rule 2: 2×2 blocks of one colour.
  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const c = modules[y][x];
      if (c === modules[y][x + 1] && c === modules[y + 1][x] && c === modules[y + 1][x + 1]) {
        penalty += 3;
      }
    }
  }

  // Rule 3: the finder-like 1:1:3:1:1 pattern with four light modules on either side.
  const pattern = [true, false, true, true, true, false, true];
  const matchesAt = (line: readonly boolean[], start: number): boolean => {
    for (let i = 0; i < 7; i++) if (line[start + i] !== pattern[i]) return false;
    return true;
  };
  const clearRun = (line: readonly boolean[], from: number, to: number): boolean => {
    for (let i = from; i < to; i++) {
      if (i < 0 || i >= size) continue; // the symbol edge counts as light
      if (line[i]) return false;
    }
    return true;
  };
  for (const transpose of [false, true]) {
    for (let a = 0; a < size; a++) {
      const line: boolean[] = [];
      for (let b = 0; b < size; b++) line.push(transpose ? modules[b][a] : modules[a][b]);
      for (let start = 0; start + 7 <= size; start++) {
        if (!matchesAt(line, start)) continue;
        if (clearRun(line, start - 4, start) || clearRun(line, start + 7, start + 11)) penalty += 40;
      }
    }
  }

  // Rule 4: deviation of the dark-module ratio from 50%, in 5% steps.
  let dark = 0;
  for (const row of modules) for (const cell of row) if (cell) dark++;
  const total = size * size;
  const k = Math.floor((Math.abs(dark * 20 - total * 10) + total - 1) / total); // ceil, integer-only
  penalty += k * 10;
  return penalty;
}

/** Encode raw bytes. Throws when the payload does not fit in a version-40 symbol at this level. */
export function encodeQrBytes(data: Uint8Array, ecc: QrEccLevel = "M"): QrCode {
  const version = smallestVersionFor(data.length, ecc);
  if (version === null) {
    throw new RangeError(`payload of ${data.length} bytes exceeds QR capacity at level ${ecc}`);
  }

  const bits: number[] = [];
  const pushBits = (value: number, width: number): void => {
    for (let i = width - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  pushBits(0b0100, 4); // byte mode
  pushBits(data.length, charCountBits(version));
  for (const byte of data) pushBits(byte, 8);

  const codewords = interleave(
    bitsToCodewords(bits, dataCodewordCapacity(version, ecc)),
    version,
    ecc,
  );

  const m = new Matrix(version);
  drawFunctionPatterns(m);
  drawCodewords(m, codewords);

  // Try every mask, keep the least penalised — the standard's own selection rule.
  let bestMask = 0;
  let bestPenalty = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    applyMask(m, mask);
    drawFormatBits(m, ecc, mask);
    const penalty = maskPenalty(m.modules);
    if (penalty < bestPenalty) {
      bestPenalty = penalty;
      bestMask = mask;
    }
    applyMask(m, mask); // masking is an XOR, so applying it again undoes it
  }
  applyMask(m, bestMask);
  drawFormatBits(m, ecc, bestMask);

  return { version, size: m.size, ecc, modules: m.modules };
}

/** Encode text as UTF-8 bytes. */
export function encodeQr(text: string, ecc: QrEccLevel = "M"): QrCode {
  return encodeQrBytes(new TextEncoder().encode(text), ecc);
}

/**
 * The dark modules as one SVG path, in a coordinate system of `size + 2 * quietZone` units. One path
 * beats one `<rect>` per module by roughly an order of magnitude in nodes, and scales losslessly —
 * a QR that a phone camera has to resolve should not be a bitmap.
 */
export function qrToSvgPath(qr: QrCode, quietZone = 4): string {
  const parts: string[] = [];
  for (let y = 0; y < qr.size; y++) {
    for (let x = 0; x < qr.size; x++) {
      if (qr.modules[y][x]) parts.push(`M${x + quietZone} ${y + quietZone}h1v1h-1z`);
    }
  }
  return parts.join("");
}

/** Side length of the SVG viewBox that `qrToSvgPath` draws into. */
export function qrSvgExtent(qr: QrCode, quietZone = 4): number {
  return qr.size + quietZone * 2;
}
