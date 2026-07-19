import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { sha256Hex } from "@/core/sha256";

describe("sha256Hex — NIST + reference vectors", () => {
  it("matches the canonical test vectors", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    // 448-bit boundary case (56 bytes → the extra padding block).
    expect(sha256Hex("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")).toBe(
      "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
    );
  });

  it("agrees with node:crypto across varied inputs, including multibyte UTF-8", () => {
    const inputs = [
      "hello world",
      "a".repeat(1000),
      "The quick brown fox jumps over the lazy dog",
      "café ☕ — CSPR ≥ $0.10 by 2026",
      "🎲🏁 emoji surrogate pair",
      JSON.stringify({ version: 1, outcomeKeys: ["yes", "no"] }),
    ];
    for (const input of inputs) {
      const expected = createHash("sha256").update(input, "utf8").digest("hex");
      expect(sha256Hex(input), input).toBe(expected);
    }
  });
});
