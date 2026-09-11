import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Control } from "../lib/control";
import { CrashWatch, looksCrashed } from "../lib/restarts";
import type { Pinned, Service } from "../lib/types";

describe("looksCrashed", () => {
  test("needs an error after the last start header", () => {
    expect(looksCrashed([
      "===== 2026-09-11 start in /tmp: bun run =====",
      "listening :3000",
    ])).toBe(false);
    expect(looksCrashed([
      "===== 2026-09-11 start in /tmp: bun run =====",
      "Error: EADDRINUSE",
    ])).toBe(true);
  });
});

describe("CrashWatch", () => {
  test("restarts an armed crashed card and disarms a clean stop", async () => {
    const home = mkdtempSync(join(tmpdir(), "devboard-cr-"));
    const control = new Control(home);
    const watch = new CrashWatch(control);
    const pinned: Pinned = { id: "echo-1", name: "echo", cwd: home, command: "true", port: 1, restartOnCrash: true };
    const stopped: Service = {
      id: "echo-1", name: "echo", kind: "dev", status: "stopped", ports: [1],
      pinned: true, hasLog: true, hidden: false, readiness: "stopped", restartOnCrash: true,
    };

    await control.start({ id: "echo-1", cwd: home, command: "echo boom; echo Error: crashed" });
    await Bun.sleep(80);
    watch.arm("echo-1");
    const first = await watch.tick([stopped], [pinned]);
    expect(first).toEqual(["echo-1"]);

    watch.disarm("echo-1");
    expect(await watch.tick([stopped], [pinned])).toEqual([]);
  });
});
