import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Control, isAlive, isValidLogId, killTree, LOG_MAX_BYTES } from "../lib/control";
import { scanProcesses } from "../lib/discover";

const spawned: number[] = [];
afterEach(() => {
  for (const pid of spawned) {
    try { process.kill(pid, "SIGKILL"); } catch {}
  }
  spawned.length = 0;
});

async function childOf(parentPid: number): Promise<number> {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const child = (await scanProcesses()).find((p) => p.ppid === parentPid);
    if (child) return child.pid;
    await Bun.sleep(100);
  }
  throw new Error("child never appeared");
}

async function waitUntilDead(pid: number, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (isAlive(pid) && Date.now() < deadline) await Bun.sleep(50);
}

async function pgidOf(pid: number): Promise<number> {
  const text = await new Response(Bun.spawn(["ps", "-o", "pgid=", "-p", String(pid)], { stdout: "pipe" }).stdout).text();
  return Number(text.trim());
}

describe("killTree", () => {
  test("SIGTERM kills a sh -c sleep tree and reports killed", async () => {
    const sh = Bun.spawn(["/bin/sh", "-c", "sleep 1000; exit 0"]); // a list, so sh does not exec sleep in place
    spawned.push(sh.pid);
    const sleep = await childOf(sh.pid);
    spawned.push(sleep);
    const result = await killTree([sh.pid, sleep]);
    expect(result.killed.sort()).toEqual([sh.pid, sleep].sort());
    expect(result.forced).toEqual([]);
    expect(isAlive(sleep)).toBe(false);
  });

  test("falls back to SIGKILL for processes that ignore SIGTERM", async () => {
    const sh = Bun.spawn(["/bin/sh", "-c", "trap '' TERM; sleep 1000"]);
    spawned.push(sh.pid);
    const sleep = await childOf(sh.pid);
    spawned.push(sleep);
    const result = await killTree([sh.pid, sleep], 500);
    expect(result.forced.sort()).toEqual([sh.pid, sleep].sort());
    await waitUntilDead(sleep);
    expect(isAlive(sleep)).toBe(false);
  });

  test("never signals pid 1 or protected pids, and treats gone pids as killed", async () => {
    const result = await killTree([1, process.pid, 999999], 100, [process.pid]);
    expect(result.killed).toEqual([999999]);
    expect(result.forced).toEqual([]);
    expect(isAlive(process.pid)).toBe(true);
  });
});

describe("Control", () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "devboard-"))); // /var -> /private/var, as sh's pwd prints it
  const control = new Control(home);

  test("start appends a header and the command output to the log, detached in its own group", async () => {
    const pid = await control.start({ id: "echo-test", cwd: home, command: "echo hello from devboard; sleep 2" });
    spawned.push(pid);
    expect(await pgidOf(pid)).toBe(pid);
    await Bun.sleep(300);
    const tail = await control.tailLog("echo-test");
    expect(tail.lines[0].startsWith("===== ")).toBe(true);
    expect(tail.lines[0]).toContain("echo hello from devboard");
    expect(tail.lines).toContain("hello from devboard");
    expect(control.hasLog("echo-test")).toBe(true);
    expect(control.hasLog("nope")).toBe(false);
  });

  test("start runs in the given cwd", async () => {
    const pid = await control.start({ id: "pwd-test", cwd: home, command: "pwd" });
    await waitUntilDead(pid);
    const tail = await control.tailLog("pwd-test");
    expect(tail.lines.at(-1)).toBe(home);
  });

  test("start rejects a missing cwd", async () => {
    await expect(control.start({ id: "bad", cwd: join(home, "missing"), command: "true" })).rejects.toThrow("does not exist");
  });

  test("tailLog returns only the last N lines and the file size", async () => {
    mkdirSync(control.logDir, { recursive: true });
    const path = control.logPath("many");
    writeFileSync(path, Array.from({ length: 300 }, (_, i) => `line ${i + 1}`).join("\n") + "\n");
    const tail = await control.tailLog("many", 10);
    expect(tail.lines).toHaveLength(10);
    expect(tail.lines[0]).toBe("line 291");
    expect(tail.lines[9]).toBe("line 300");
    expect(tail.size).toBeGreaterThan(0);
    expect(tail.path).toBe(path);
  });

  test("start merges env overrides into the child", async () => {
    const pid = await control.start({ id: "env-test", cwd: home, command: "printf %s \"$DEVBOARD_FOO\"", env: { DEVBOARD_FOO: "from-card" } });
    await waitUntilDead(pid);
    expect((await control.tailLog("env-test")).lines.at(-1)).toBe("from-card");
  });

  test("rotateIfNeeded keeps the last chunk once a log grows past the cap", async () => {
    mkdirSync(control.logDir, { recursive: true });
    const path = control.logPath("huge");
    writeFileSync(path, "x".repeat(500) + "\nUNIQUE-TAIL-LINE\n");
    expect(await control.rotateIfNeeded("huge", 100, 40)).toBe(true);
    const text = await Bun.file(path).text();
    expect(text).toContain("rotated");
    expect(text).toContain("UNIQUE-TAIL-LINE");
    expect(text.length).toBeLessThan(200);
    expect(await control.rotateIfNeeded("huge", 10_000, 40)).toBe(false);
  });

  test("clearLog truncates to a single header line", async () => {
    mkdirSync(control.logDir, { recursive: true });
    writeFileSync(control.logPath("wipe"), "old noise\nmore\n");
    const cleared = await control.clearLog("wipe");
    const tail = await control.tailLog("wipe", 10);
    expect(tail.lines).toHaveLength(1);
    expect(tail.lines[0]).toContain("cleared");
    expect(cleared.size).toBe(tail.size);
    await expect(control.clearLog("missing")).rejects.toThrow("no log");
  });

  test("tailLog from a byte offset returns each new line once, including duplicates", async () => {
    mkdirSync(control.logDir, { recursive: true });
    const path = control.logPath("follow");
    const batch1 = Array.from({ length: 150 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
    writeFileSync(path, batch1);
    const first = await control.tailLog("follow", 200, 0);
    expect(first.lines).toHaveLength(150);
    expect(first.lines[0]).toBe("line 1");
    expect(first.reset).toBeUndefined();
    const batch2 = Array.from({ length: 150 }, (_, i) => `line ${i + 151}`).join("\n") + "\nsame\nsame\n";
    writeFileSync(path, batch1 + batch2);
    const second = await control.tailLog("follow", 200, first.next);
    expect(second.lines).toHaveLength(152);
    expect(second.lines[0]).toBe("line 151");
    expect(second.lines.slice(-2)).toEqual(["same", "same"]);
    writeFileSync(path, batch1 + batch2 + "partial");
    const held = await control.tailLog("follow", 200, second.next);
    expect(held.lines).toEqual([]);
    expect(held.next).toBe(second.next);
  });

  test("tailLog from a stale offset reports reset after the file shrinks", async () => {
    mkdirSync(control.logDir, { recursive: true });
    writeFileSync(control.logPath("reset-me"), Array.from({ length: 80 }, (_, i) => `old ${i}`).join("\n") + "\n");
    const first = await control.tailLog("reset-me", 200, 0);
    await control.clearLog("reset-me");
    const again = await control.tailLog("reset-me", 200, first.next);
    expect(again.reset).toBe(true);
    expect(again.lines.some((l) => l.includes("cleared"))).toBe(true);
  });

  test("start records a tracked pid and exit code", async () => {
    const pid = await control.start({ id: "exit-3", cwd: home, command: "exit 3" });
    spawned.push(pid);
    await waitUntilDead(pid);
    const deadline = Date.now() + 2000;
    while (control.trackedOf("exit-3")?.exitCode == null && Date.now() < deadline) await Bun.sleep(20);
    const t = control.trackedOf("exit-3");
    expect(t?.exitCode).toBe(3);
    expect(t?.exitedAt).toBeNumber();
  });

  test("killTree on a tracked process group leaves nothing alive", async () => {
    const pid = await control.start({ id: "grp", cwd: home, command: "sleep 1000; exit 0" });
    spawned.push(pid);
    const sleep = await childOf(pid);
    spawned.push(sleep);
    const result = await killTree([pid, sleep], 3000, [process.pid], pid);
    expect(isAlive(pid)).toBe(false);
    expect(isAlive(sleep)).toBe(false);
    expect(result.killed.length + result.forced.length).toBeGreaterThan(0);
    const leftover = await new Response(Bun.spawn(["ps", "-axo", "pid=,pgid="], { stdout: "pipe" }).stdout).text();
    const still = leftover.split("\n").filter((line) => {
      const parts = line.trim().split(/\s+/);
      return parts.length >= 2 && Number(parts[1]) === pid && Number(parts[0]) > 1;
    });
    expect(still).toEqual([]);
  });

  test("rotateRunning copies the tail aside and truncates the live file while the writer lives", async () => {
    const pid = await control.start({ id: "chatty", cwd: home, command: "yes | head -c 6000000; sleep 30" });
    spawned.push(pid);
    const path = control.logPath("chatty");
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const info = await Bun.file(path).exists() ? await Bun.file(path).stat() : undefined;
      if (info && info.size > LOG_MAX_BYTES) break;
      await Bun.sleep(50);
    }
    expect((await Bun.file(path).stat()).size).toBeGreaterThan(LOG_MAX_BYTES);
    const rotated = await control.rotateRunning(["chatty"]);
    expect(rotated).toEqual(["chatty"]);
    expect((await Bun.file(path).stat()).size).toBeLessThan(3 * 1024 * 1024);
    expect(await Bun.file(`${path}.1`).exists()).toBe(true);
    expect(isAlive(pid)).toBe(true);
    const tail = await control.tailLog("chatty", 50);
    expect(tail.lines.some((l) => l === "y")).toBe(true);
    expect(tail.lines.at(-1)).toContain("rotated");
    const yAt = tail.lines.lastIndexOf("y");
    const rotAt = tail.lines.findIndex((l) => l.includes("rotated"));
    expect(yAt).toBeGreaterThanOrEqual(0);
    expect(rotAt).toBeGreaterThan(yAt);
  });

  test("logPath rejects ids that could leave the log directory", () => {
    expect(isValidLogId("echo-1")).toBe(true);
    expect(isValidLogId("devboard-3999")).toBe(true);
    expect(isValidLogId("../outside")).toBe(false);
    expect(isValidLogId("..")).toBe(false);
    expect(() => control.logPath("../outside")).toThrow("invalid log id");
    expect(() => control.logPath("../../outside")).toThrow("invalid log id");
  });
});
