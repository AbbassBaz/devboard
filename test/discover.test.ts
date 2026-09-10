import { describe, expect, test } from "bun:test";
import { applyCwds, exeName, findRoot, groupServices, indexProcesses, isWrapper, parseCwds, parseListeners, parseProcesses, treePids } from "../lib/discover";

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

describe("groupServices", () => {
  const listeners = parseListeners(listenersText);
  const procs = parseProcesses(psText);
  const services = groupServices(listeners, procs, 99999);

  test("one service per tree root, excluding devboard's own tree, sorted by first port", () => {
    expect(services.map((s) => s.rootPid)).toEqual([41727, 68729, 77777, 64672, 64671, 683, 835, 652]);
    expect(services.map((s) => s.ports[0])).toEqual([3000, 3001, 3003, 3010, 4010, 5000, 6379, 63951]);
  });

  test("a service started by devboard is its own root and is not hidden with devboard", () => {
    const api = services.find((s) => s.rootPid === 77777)!;
    expect(api.pids.sort()).toEqual([77777, 77778]);
    expect(api.ports).toEqual([3003]);
    expect(api.kind).toBe("dev");
    expect(services.some((s) => s.pids.includes(99999))).toBe(false);
  });

  test("a Next.js dev server collapses its three processes into one row", () => {
    const docs = services.find((s) => s.rootPid === 64672)!;
    expect(docs.pids.sort()).toEqual([64672, 64728, 64734]);
    expect(docs.ports).toEqual([3010]);
    expect(docs.command).toBe("node /Users/abbassbaz/.local/state/fnm_multishells/51664_1787044842120/bin/pnpm dev");
    expect(docs.kind).toBe("dev");
    expect(docs.uptime).toBe("23-01:48:35");
    expect(docs.memMb).toBe(149); // (60000 + 80000 + 12288) / 1024 rounded
    expect(docs.name).toBe("node");
  });

  test("ControlCenter is system with both ports", () => {
    const cc = services.find((s) => s.rootPid === 683)!;
    expect(cc.kind).toBe("system");
    expect(cc.ports).toEqual([5000, 7000]);
    expect(cc.name).toBe("ControlCenter");
  });

  test("a bare bun watch process is its own root and is dev", () => {
    const proxy = services.find((s) => s.rootPid === 41727)!;
    expect(proxy.pids).toEqual([41727]);
    expect(proxy.kind).toBe("dev");
  });
});

describe("applyCwds", () => {
  test("sets cwd and derives name from package.json name or folder basename", () => {
    const services = groupServices(parseListeners(listenersText), parseProcesses(psText), 99999);
    const cwds = parseCwds(cwdText);
    const names = new Map([[64672, "oncore-docs"]]);
    const out = applyCwds(services, cwds, names);
    const docs = out.find((s) => s.rootPid === 64672)!;
    expect(docs.cwd).toBe("/Users/abbassbaz/Desktop/Sadie/OnCoreDocs");
    expect(docs.name).toBe("oncore-docs");
    const proxy = out.find((s) => s.rootPid === 41727)!;
    expect(proxy.name).toBe("core-proxy");
    const cc = out.find((s) => s.rootPid === 683)!;
    expect(cc.cwd).toBeUndefined();
    expect(cc.name).toBe("ControlCenter");
  });
});
