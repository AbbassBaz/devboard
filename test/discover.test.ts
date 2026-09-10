import { describe, expect, test } from "bun:test";
import { parseCwds, parseListeners, parseProcesses } from "../lib/discover";

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
