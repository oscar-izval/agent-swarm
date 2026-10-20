import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";

/**
 * Regression tests for the bounded boot-fetch helper in docker-entrypoint.sh.
 *
 * The three boot fetches (swarm config, repo list, setup script) used to be
 * single-shot `curl -s -f ... > /tmp/<file>` calls. The shell opens the
 * redirect target before curl runs, so a failed request left a 0-byte file
 * behind and the caller skipped its whole block: the pod came up "ready"
 * with empty artifacts (observed at the red-teamer boot on 2026-10-20).
 *
 * The helper is extracted verbatim from docker-entrypoint.sh between its
 * `# BEGIN fetch_with_retry` / `# END fetch_with_retry` markers and run in a
 * real bash subprocess, so this test tracks the deployed behavior instead of
 * a hand-written mirror that could silently drift.
 */

const entrypointPath = `${import.meta.dir}/../../docker-entrypoint.sh`;

function extractFetchWithRetry(): string {
  const script = readFileSync(entrypointPath, "utf8");

  const beginMarker = "# BEGIN fetch_with_retry";
  const beginIndex = script.indexOf(beginMarker);
  if (beginIndex === -1) {
    throw new Error(
      "Could not locate `# BEGIN fetch_with_retry` marker in docker-entrypoint.sh — did the boot-fetch helper move?",
    );
  }

  const funcStart = script.indexOf("fetch_with_retry() {", beginIndex);
  if (funcStart === -1) {
    throw new Error("Could not locate `fetch_with_retry() {` definition after the BEGIN marker.");
  }

  const endMarker = "# END fetch_with_retry";
  const endIndex = script.indexOf(endMarker, funcStart);
  if (endIndex === -1) {
    throw new Error("Could not locate `# END fetch_with_retry` marker in docker-entrypoint.sh.");
  }

  return script.slice(funcStart, endIndex);
}

interface RunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
}

/** Run the real extracted helper against `url` in a fresh bash subprocess. */
async function runFetchWithRetry(
  url: string,
  outFile: string,
  allowStatus = "",
  env: Record<string, string> = {},
): Promise<RunResult> {
  const funcSrc = extractFetchWithRetry();
  const script = `set -u\n${funcSrc}\nfetch_with_retry "$1" "$2" "$3" --\n`;

  const start = performance.now();
  const proc = Bun.spawn(["bash", "-c", script, "bash", url, outFile, allowStatus], {
    env: { PATH: process.env.PATH ?? "", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const durationMs = performance.now() - start;

  return { exitCode, stdout, stderr, durationMs };
}

let server: ReturnType<typeof Bun.serve> | undefined;

afterEach(() => {
  server?.stop(true);
  server = undefined;
});

describe("fetch_with_retry: source contract", () => {
  test("every boot artifact goes through the retrying helper", () => {
    const script = readFileSync(entrypointPath, "utf8");
    for (const artifact of ["swarm_config.json", "swarm_repos.json", "setup_scripts.json"]) {
      expect(script).toContain(`/${artifact}`);
      // The single-shot `curl ... > /tmp/<artifact>` form is gone: the
      // redirect target must only be written by the helper.
      expect(script).not.toMatch(new RegExp(`curl[^\\n]*>[^\\n]*${artifact}`));
    }
    expect(script).toContain("fetch_with_retry");
  });

  test("the helper bounds both the attempt count and the wall clock", () => {
    const funcSrc = extractFetchWithRetry();
    expect(funcSrc).toContain("WORKER_BOOT_FETCH_ATTEMPTS");
    expect(funcSrc).toContain("WORKER_BOOT_FETCH_TIMEOUT_SECONDS");
    expect(funcSrc).toContain("BOOT_FETCH_DEADLINE");
    // Per-attempt curl bounds, so a hung API cannot block the boot either.
    expect(funcSrc).toContain("--connect-timeout");
    expect(funcSrc).toContain("--max-time");
  });

  test("the three boot fetches share one total deadline", () => {
    const script = readFileSync(entrypointPath, "utf8");
    expect(script).toContain("BOOT_FETCH_DEADLINE=$(( $(date +%s)");
    // The deadline is set before the first fetch and the helper is the only
    // writer of the three artifacts.
    const deadlineIndex = script.indexOf("BOOT_FETCH_DEADLINE=$(( $(date +%s)");
    const firstFetchIndex = script.indexOf("fetch_with_retry", deadlineIndex);
    expect(deadlineIndex).toBeGreaterThan(-1);
    expect(firstFetchIndex).toBeGreaterThan(deadlineIndex);
  });
});

describe("fetch_with_retry: transient failure then success", () => {
  test("retries with backoff until the API answers and writes the body", async () => {
    // A per-test path prefix: an ephemeral port can be reused from another
    // test process whose helper still hits the same path.
    const prefix = `/${crypto.randomUUID()}`;
    const requestTimes: number[] = [];
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname !== `${prefix}/artifact`)
          return new Response("not found", { status: 404 });
        requestTimes.push(performance.now());
        if (requestTimes.length < 3) return new Response("unavailable", { status: 503 });
        return new Response('{"configs":[]}', { status: 200 });
      },
    });

    const outFile = `${process.env.TMPDIR ?? "/tmp"}/boot-fetch-${crypto.randomUUID()}.json`;
    const result = await runFetchWithRetry(`${server.url.origin}${prefix}/artifact`, outFile, "", {
      WORKER_BOOT_FETCH_ATTEMPTS: "5",
    });

    expect(result.exitCode).toBe(0);
    expect(requestTimes).toHaveLength(3);
    expect(result.stdout).toContain("boot fetch failed (attempt 1/5");
    expect(result.stdout).toContain("boot fetch failed (attempt 2/5");
    // Exponential backoff: the second wait is at least twice the first.
    expect(requestTimes[1]! - requestTimes[0]!).toBeGreaterThanOrEqual(900);
    expect(requestTimes[2]! - requestTimes[1]!).toBeGreaterThanOrEqual(1800);
    expect(readFileSync(outFile, "utf8")).toBe('{"configs":[]}');
  }, 20000);
});

describe("fetch_with_retry: persistent failure", () => {
  test("fails loudly, exits non-zero and leaves no empty artifact behind", async () => {
    const prefix = `/${crypto.randomUUID()}`;
    let hits = 0;
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname !== `${prefix}/artifact`)
          return new Response("not found", { status: 404 });
        hits += 1;
        return new Response("boom", { status: 500 });
      },
    });

    const outFile = `${process.env.TMPDIR ?? "/tmp"}/boot-fetch-${crypto.randomUUID()}.json`;
    const result = await runFetchWithRetry(`${server.url.origin}${prefix}/artifact`, outFile, "", {
      WORKER_BOOT_FETCH_ATTEMPTS: "2",
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toContain("FATAL: boot fetch failed after 2 attempt(s)");
    expect(hits).toBe(2);
    // The old failure mode: a 0-byte file left behind that the caller read
    // as a fetched artifact.
    expect(existsSync(outFile)).toBe(false);
  }, 20000);

  test("a 200 with an empty body is a failure, not a fetched artifact", async () => {
    const prefix = `/${crypto.randomUUID()}`;
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname !== `${prefix}/artifact`)
          return new Response("not found", { status: 404 });
        return new Response("", { status: 200 });
      },
    });

    const outFile = `${process.env.TMPDIR ?? "/tmp"}/boot-fetch-${crypto.randomUUID()}.json`;
    const result = await runFetchWithRetry(`${server.url.origin}${prefix}/artifact`, outFile, "", {
      WORKER_BOOT_FETCH_ATTEMPTS: "2",
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toContain("FATAL: boot fetch failed");
    expect(existsSync(outFile)).toBe(false);
  }, 20000);
});

describe("fetch_with_retry: bounded wait", () => {
  test("gives up when the shared boot deadline has passed", async () => {
    const prefix = `/${crypto.randomUUID()}`;
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname !== `${prefix}/artifact`)
          return new Response("not found", { status: 404 });
        return new Response("unavailable", { status: 503 });
      },
    });

    const outFile = `${process.env.TMPDIR ?? "/tmp"}/boot-fetch-${crypto.randomUUID()}.json`;
    // A deadline in the past: the helper must not even wait for its budget.
    const result = await runFetchWithRetry(`${server.url.origin}${prefix}/artifact`, outFile, "", {
      WORKER_BOOT_FETCH_ATTEMPTS: "50",
      BOOT_FETCH_DEADLINE: "1",
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toContain("FATAL: boot fetch budget exhausted");
    expect(result.durationMs).toBeLessThan(5000);
  }, 20000);
});

describe("fetch_with_retry: allowed missing status", () => {
  test("a 404 the caller allows is not an error and leaves no artifact", async () => {
    const prefix = `/${crypto.randomUUID()}`;
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname !== `${prefix}/artifact`)
          return new Response("not found", { status: 404 });
        return new Response('{"error":"Agent not found"}', { status: 404 });
      },
    });

    const outFile = `${process.env.TMPDIR ?? "/tmp"}/boot-fetch-${crypto.randomUUID()}.json`;
    const result = await runFetchWithRetry(
      `${server.url.origin}${prefix}/artifact`,
      outFile,
      "404",
      { WORKER_BOOT_FETCH_ATTEMPTS: "3" },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("nothing to fetch");
    expect(existsSync(outFile)).toBe(false);
  }, 20000);

  test("a 404 the caller does not allow is retried and fails", async () => {
    const prefix = `/${crypto.randomUUID()}`;
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname !== `${prefix}/artifact`)
          return new Response("not found", { status: 404 });
        return new Response("not found", { status: 404 });
      },
    });

    const outFile = `${process.env.TMPDIR ?? "/tmp"}/boot-fetch-${crypto.randomUUID()}.json`;
    const result = await runFetchWithRetry(`${server.url.origin}${prefix}/artifact`, outFile, "", {
      WORKER_BOOT_FETCH_ATTEMPTS: "2",
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toContain("FATAL: boot fetch failed");
  }, 20000);
});
