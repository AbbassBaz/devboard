import { describe, expect, test } from "bun:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(ROOT, "bin/devboard.ts");

async function runCli(args: string[]): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn(["bun", "run", CLI, ...args], { stdout: "pipe", stderr: "pipe", cwd: ROOT });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, out, err };
}

describe("devboard doctor", () => {
  test("exits 0 and reports bun, lsof, and ps", async () => {
    const { code, out } = await runCli(["doctor"]);
    expect(code).toBe(0);
    expect(out).toMatch(/^ok {2}bun \S+ meets /m);
    expect(out).toMatch(/^ok {2}lsof on PATH /m);
    expect(out).toMatch(/^ok {2}ps on PATH /m);
    expect(out).toMatch(/4242 (free|held by pid )/);
  });
});
