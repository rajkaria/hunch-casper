#!/usr/bin/env python3
"""Regenerate `test/fixtures/qr-vectors.json`, and prove our QR encoder produces symbols that scan.

`src/lib/qr-code.ts` is a from-scratch encoder, and its interesting failure mode is not a crash — it
is a symbol that looks like a QR code and does not scan. Tests the encoder writes for itself cannot
catch that: a wrong error-correction table or a wrong interleave is perfectly self-consistent. So
this script does two things that CI alone cannot:

1. **Fixtures from an independent encoder.** Every vector's matrix is produced by `segno`, which
   shares no code with ours. `test/qr-code.test.ts` decodes those matrices with its own reader, so
   our block tables, geometry, masks and format bits are checked against another implementation's
   output rather than against our own assumptions.

   Note what is deliberately *not* asserted: byte-for-byte equality with segno. Mask selection is a
   quality heuristic, not a decoding rule — segno, python-qrcode and this encoder pick different
   masks for the same payload (all three disagree with each other on most symbols), and every choice
   decodes identically. Pad-codeword bytes past the payload differ between implementations too.

2. **A real decoder reads OUR output.** `zxing-cpp` — the C++ ZXing port behind many production
   scanners — is handed the matrices our own encoder emits, rendered as images, and must read back
   the exact payload. This is the claim that matters, and it is re-checked every time this script
   runs.

Usage:
    pip install segno zxing-cpp numpy
    python3 scripts/qr-fixtures.py > test/fixtures/qr-vectors.json
"""

from __future__ import annotations

import base64
import importlib.metadata as metadata
import json
import subprocess
import sys
from pathlib import Path

try:
    import numpy as np
    import segno
    import zxingcpp
    from segno import consts
except ImportError as exc:  # pragma: no cover - developer tooling
    sys.exit(f"missing dependency ({exc}); pip install segno zxing-cpp numpy")

REPO = Path(__file__).resolve().parent.parent
LEVELS = "LMQH"
SEGNO_LEVEL = {"L": 1, "M": 0, "Q": 3, "H": 2}
ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789"

# A realistic WalletConnect v2 pairing URI — the payload this encoder exists to carry.
WC_URI = (
    "wc:8f4a2b1c9d3e5f6071829304a5b6c7d8e9f0a1b2c3d4e5f60718293045a6b7c8@2"
    "?relay-protocol=irn&symKey=3b2a1908f7e6d5c4b3a29180f7e6d5c4b3a29180f7e6d5c4b3a29180f7e6d5c4"
)


def byte_capacity(version: int, ecc: str) -> int:
    """Payload bytes that exactly fill `version` in byte mode: data codewords minus the header."""
    groups = consts.ECC[version][SEGNO_LEVEL[ecc]]
    data_codewords = sum(g.num_blocks * g.num_data for g in groups)
    # 4 bits of mode + an 8-bit (v1–9) or 16-bit character count, rounded up to whole codewords.
    return data_codewords - (2 if version <= 9 else 3)


def payload(length: int) -> str:
    return "".join(ALPHABET[i % len(ALPHABET)] for i in range(length))


def matrix_rows(qr) -> list[str]:
    """Row-major dark/light modules as '0'/'1' strings, without the quiet zone."""
    return ["".join("1" if bit else "0" for bit in row) for row in qr.matrix]


def pack(rows: list[str]) -> str:
    """Modules as base64 of the row-major bit string, MSB first. Keeps the fixture ~8× smaller."""
    bits = "".join(rows)
    bits += "0" * (-len(bits) % 8)
    data = bytes(int(bits[i : i + 8], 2) for i in range(0, len(bits), 8))
    return base64.b64encode(data).decode("ascii")


def scan(rows: list[str]) -> str | None:
    """Render modules as an image with a quiet zone and read them back with zxing-cpp."""
    size = len(rows)
    quiet, scale = 4, 3
    side = (size + 2 * quiet) * scale
    image = np.full((side, side), 255, dtype=np.uint8)
    for y, row in enumerate(rows):
        for x, module in enumerate(row):
            if module == "1":
                top, left = (y + quiet) * scale, (x + quiet) * scale
                image[top : top + scale, left : left + scale] = 0
    result = zxingcpp.read_barcode(image)
    return None if result is None else result.text


def cases() -> list[tuple[str, str, bool]]:
    """(payload, level, store_full_matrix) — the vectors the fixture covers."""
    out: list[tuple[str, str, bool]] = [
        # Readable cases, stored as '0'/'1' rows so a failure prints something a human can compare.
        ("HELLO", "M", True),
        ("https://casper.playhunch.xyz/markets", "M", True),
        (WC_URI, "M", True),
        (WC_URI, "L", True),
    ]
    for version in range(1, 41):
        for ecc in LEVELS:
            # Every version at M — that is one vector per row of the error-correction block table.
            # The other levels run to version 10, which covers their own table rows in the range any
            # real pairing URI lands in, without tripling the fixture's size.
            if ecc != "M" and version > 10:
                continue
            full = byte_capacity(version, ecc)
            out.append((payload(full), ecc, False))  # exactly fills the version
            # Padded payloads exercise the terminator and pad codewords, which do not vary by
            # version, so a spread is enough where an exhaustive sweep would only add megabytes.
            if version in (1, 2, 3, 5, 9, 10, 15, 20, 30, 40) and full > 8:
                out.append((payload(full - 5), ecc, False))
    return out


def main() -> None:
    vectors = []
    for text, ecc, full in cases():
        qr = segno.make(text, error=ecc, mode="byte", boost_error=False, micro=False)
        rows = matrix_rows(qr)
        decoded = scan(rows)
        if decoded != text:
            sys.exit(f"segno's own symbol for {len(text)} bytes at {ecc} did not scan: {decoded!r}")
        vector = {
            "text": text,
            "ecc": ecc,
            "version": qr.version,
            "size": len(rows),
            "modules": pack(rows),
        }
        if full:
            vector["rows"] = rows
        vectors.append(vector)

    ours = emit_our_matrices([{"text": v["text"], "ecc": v["ecc"]} for v in vectors])
    unscannable = 0
    for vector, mine in zip(vectors, ours):
        if (mine["version"], mine["size"]) != (vector["version"], vector["size"]):
            sys.exit(
                f"version disagreement for {len(vector['text'])} bytes at {vector['ecc']}: "
                f"ours v{mine['version']}, segno v{vector['version']}"
            )
        if scan(mine["rows"]) != vector["text"]:
            unscannable += 1
            print(
                f"UNSCANNABLE: our v{mine['version']}-{vector['ecc']} symbol for "
                f"{len(vector['text'])} bytes",
                file=sys.stderr,
            )
    if unscannable:
        sys.exit(f"{unscannable} symbol(s) from src/lib/qr-code.ts could not be read back")

    json.dump(
        {
            "note": (
                "Generated by scripts/qr-fixtures.py — do not hand-edit. Matrices are segno's, "
                "packed as base64 of the row-major bit string (MSB first). Mask choice is a "
                "quality heuristic, not a decoding rule, so tests decode these rather than "
                "comparing them module-for-module with our own output."
            ),
            "generator": f"segno {segno.__version__}",
            "verified": (
                f"zxing-cpp {metadata.version('zxing-cpp')} read back the exact payload from all "
                f"{len(vectors)} symbols emitted by src/lib/qr-code.ts, and from all "
                f"{len(vectors)} segno symbols"
            ),
            "vectors": vectors,
        },
        sys.stdout,
        indent=1,
    )
    sys.stdout.write("\n")
    print(f"verified {len(vectors)} symbols with zxing-cpp", file=sys.stderr)


def emit_our_matrices(payloads: list[dict]) -> list[dict]:
    """Run our TypeScript encoder over the same payloads (Node strips the types on import)."""
    proc = subprocess.run(
        ["node", str(REPO / "scripts" / "qr-emit.mjs")],
        input=json.dumps(payloads),
        capture_output=True,
        text=True,
        cwd=REPO,
    )
    if proc.returncode != 0:
        sys.exit(f"scripts/qr-emit.mjs failed:\n{proc.stderr}")
    return json.loads(proc.stdout)


if __name__ == "__main__":
    main()
