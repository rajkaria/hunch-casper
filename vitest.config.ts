import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
    // Pins the settlement ledger's clock before every test. Without it the suite reads the wall
    // clock against the catalogue's fixed deadlines, so the whole thing turns red on the day those
    // deadlines pass. See test/setup/frozen-clock.ts.
    setupFiles: ["./test/setup/frozen-clock.ts"],
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
});
