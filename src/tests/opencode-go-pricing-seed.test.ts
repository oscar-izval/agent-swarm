// OpenCode Zen (`opencode`) and the Go subscription (`opencode-go`) are two
// models.dev sections that share `OPENCODE_API_KEY`. Before this, only the
// `openrouter` section was projected under provider `opencode`, so every
// `opencode-go/<model>` session landed on `costSource='unpriced'`.

import { describe, expect, test } from "bun:test";
import type { ModelsDevCache } from "../be/modelsdev-cache";
import { normalizeModelKey } from "../be/pricing-normalize";
import { buildModelsDevSeedRows } from "../be/seed-pricing";

const CACHE = {
  opencode: {
    models: {
      "glm-4.7": { cost: { input: 0.6, output: 2.2, cache_read: 0.1 } },
      "no-cost-zen": {},
    },
  },
  "opencode-go": {
    models: {
      "deepseek-v4-pro": { cost: { input: 0.66, output: 1.98 } },
      "no-cost-go": {},
    },
  },
} as unknown as ModelsDevCache;

function opencodeRows() {
  return buildModelsDevSeedRows(CACHE).filter((row) => row.provider === "opencode");
}

describe("OpenCode Zen / Go pricing seed", () => {
  test("projects the Zen section bare and the Go section prefixed", () => {
    const rows = opencodeRows();
    const price = (model: string, tokenClass: string) =>
      rows.find((row) => row.model === model && row.tokenClass === tokenClass)?.pricePerMillionUsd;
    // Zen section: bare id, matching `normalizeModelKey("opencode", "opencode/<id>")`.
    expect(price("glm-4.7", "input")).toBe(0.6);
    expect(price("glm-4.7", "cached_input")).toBe(0.1);
    // Go section: the `opencode-go/` prefix is kept so it cannot collide with
    // the Zen row for the same model id at a different rate.
    expect(price("opencode-go/deepseek-v4-pro", "input")).toBe(0.66);
    expect(price("opencode-go/deepseek-v4-pro", "output")).toBe(1.98);
  });

  test("skips entries with no cost block", () => {
    const models = opencodeRows().map((row) => row.model);
    expect(models).not.toContain("no-cost-zen");
    expect(models).not.toContain("no-cost-go");
  });

  test("adapter-emitted ids normalize onto the seeded rows", () => {
    const models = new Set(opencodeRows().map((row) => row.model));
    expect(models.has(normalizeModelKey("opencode", "opencode/glm-4.7"))).toBe(true);
    expect(models.has(normalizeModelKey("opencode", "opencode-go/deepseek-v4-pro"))).toBe(true);
  });
});
