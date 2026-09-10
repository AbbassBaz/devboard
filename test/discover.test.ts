import { describe, expect, test } from "bun:test";
import { parseListeners } from "../lib/discover";

const listenersText = await Bun.file(new URL("./fixtures/lsof-listeners.txt", import.meta.url)).text();

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
