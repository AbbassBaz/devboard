import { describe, expect, test } from "bun:test";
import { exeName, findRoot, indexProcesses, isWrapper, parseCwds, parseListeners, parseProcesses, treePids } from "../lib/discover";

const listenersText = await Bun.file(new URL("./fixtures/lsof-listeners.txt", import.meta.url)).text();
const psText = await Bun.file(new URL("./fixtures/ps.txt", import.meta.url)).text();
const cwdText = await Bun.file(new URL("./fixtures/lsof-cwd.txt", import.meta.url)).text();

describe("parseListeners", () => {
  test("one listener per pid+port, deduplicating IPv4/IPv6 and repeated fds", () => {
    const listeners = parseListeners(listenersText);
    expect(listeners).toHaveLength(10);
    const redis = listeners.filter((l) => l.pid === 835);
    expect(redis).toEqual([{ pid: 835, command: "redis-server", port: 6379, address: "127.0.0.1" }]);
    const rapport = listeners.filter((l) => l.pid === 652);
    expect(rapport).toHaveLength(1);
  });

  test("keeps multiple ports for one pid", () => {
    const cc = parseListeners(listenersText).filter((l) => l.pid === 683).map((l) => l.port).sort();
    expect(cc).toEqual([5000, 7000]);
  });

  test("returns [] for empty output", () => {
    expect(parseListeners("")).toEqual([]);
  });
});

describe("parseProcesses", () => {
  test("parses every line with numeric fields and the full args", () => {
    const procs = parseProcesses(psText);
    expect(procs).toHaveLength(17);
    const next = procs.find((p) => p.pid === 64734)!;
    expect(next).toEqual({ pid: 64734, ppid: 64728, pcpu: 0, rss: 12288, etime: "23-01:48:34", args: "next-server (v16.3.1)" });
    const redis = procs.find((p) => p.pid === 835)!;
    expect(redis.pcpu).toBe(0.1);
    expect(redis.args).toBe("/opt/homebrew/opt/redis/bin/redis-server 127.0.0.1:6379");
  });

  test("keeps short etime values", () => {
    expect(parseProcesses(psText).find((p) => p.pid === 99999)!.etime).toBe("00:05");
  });
});

describe("parseCwds", () => {
  test("maps pid to working directory", () => {
    const cwds = parseCwds(cwdText);
    expect(cwds.size).toBe(3);
    expect(cwds.get(64672)).toBe("/Users/abbassbaz/Desktop/Sadie/OnCoreDocs");
    expect(cwds.get(835)).toBe("/opt/homebrew/var/db/redis");
  });
});

describe("tree walk", () => {
  const procs = parseProcesses(psText);
  const { byPid, byPpid } = indexProcesses(procs);
  const SELF = 99999;

  test("exeName takes the basename of the first token", () => {
    expect(exeName("node /x/y/pnpm dev")).toBe("node");
    expect(exeName("/opt/homebrew/opt/redis/bin/redis-server 127.0.0.1:6379")).toBe("redis-server");
    expect(exeName("next-server (v16.3.1)")).toBe("next-server");
    expect(exeName("-zsh")).toBe("-zsh");
  });

  test("isWrapper accepts JS runtimes, package managers, and sh -c only", () => {
    const p = (args: string) => ({ pid: 1, ppid: 0, pcpu: 0, rss: 0, etime: "", args });
    expect(isWrapper(p("node /x/pnpm dev"))).toBe(true);
    expect(isWrapper(p("bun --watch server.ts"))).toBe(true);
    expect(isWrapper(p("npm exec next dev --port 3001"))).toBe(true);
    expect(isWrapper(p("/bin/sh -c echo hi; sleep 5"))).toBe(true);
    expect(isWrapper(p("-zsh"))).toBe(false);
    expect(isWrapper(p("/bin/zsh -l"))).toBe(false);
    expect(isWrapper(p("bash deploy.sh"))).toBe(false);
    expect(isWrapper(p("/System/Library/CoreServices/ControlCenter.app/Contents/MacOS/ControlCenter"))).toBe(false);
  });

  test("findRoot climbs pnpm dev -> stops at the login shell", () => {
    expect(findRoot(64734, byPid, SELF)).toBe(64672);
  });

  test("findRoot climbs npm exec -> stops at launchd", () => {
    expect(findRoot(68761, byPid, SELF)).toBe(68729);
  });

  test("findRoot returns the pid itself when the parent is not a wrapper", () => {
    expect(findRoot(41727, byPid, SELF)).toBe(41727);
    expect(findRoot(683, byPid, SELF)).toBe(683);
  });

  test("findRoot never climbs into devboard itself, so devboard-started services keep their own root", () => {
    expect(findRoot(77778, byPid, SELF)).toBe(77777);
    // without stopAt the walk would continue into 99999 (bun) and 99998 (bun run dev)
    expect(findRoot(77778, byPid, -1)).toBe(99998);
  });

  test("treePids returns the root and all descendants", () => {
    expect(treePids(64672, byPpid).sort()).toEqual([64672, 64728, 64734]);
    expect(treePids(41727, byPpid)).toEqual([41727]);
  });
});
