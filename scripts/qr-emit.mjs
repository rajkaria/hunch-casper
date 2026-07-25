/**
 * Print the QR matrices `src/lib/qr-code.ts` produces for a list of payloads, as JSON on stdout.
 *
 * This exists so `scripts/qr-fixtures.py` can hand our encoder's own output to a real barcode
 * decoder (zxing-cpp) and prove the symbols scan — the one property no test we write for ourselves
 * can establish. Node ≥ 22.18 strips the TypeScript types on import, so there is no build step.
 *
 * Usage (stdin: JSON array of {text, ecc}):
 *     node scripts/qr-emit.mjs < payloads.json
 */

import { encodeQr } from "../src/lib/qr-code.ts";

const input = await new Promise((resolve, reject) => {
  let raw = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => (raw += chunk));
  process.stdin.on("end", () => resolve(raw));
  process.stdin.on("error", reject);
});

const payloads = JSON.parse(input);
const out = payloads.map(({ text, ecc }) => {
  const qr = encodeQr(text, ecc);
  return {
    text,
    ecc,
    version: qr.version,
    size: qr.size,
    rows: qr.modules.map((row) => row.map((dark) => (dark ? "1" : "0")).join("")),
  };
});

process.stdout.write(JSON.stringify(out));
