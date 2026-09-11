import { afterAll, describe, expect, test } from "bun:test";
import { applyReadiness, firstFreePort, healthUrlFor, probe } from "../lib/health";
import type { Pinned, Service } from "../lib/types";

const stopped: Service = {
  id: "api-3003", name: "api", kind: "dev", status: "stopped", ports: [3003],
  pinned: true, hasLog: false, hidden: false, readiness: "stopped",
};

const running = (ports: number[], extra: Partial<Service> = {}): Service => ({
  id: "web-3000", name: "web", kind: "dev", status: "running", ports,
  pinned: true, hasLog: false, hidden: false, readiness: "ready",
  ...extra,
});

describe("firstFreePort", () => {
  test("skips occupied ports from the start value", () => {
    expect(firstFreePort([3000, 3001, 3003], 3000)).toBe(3002);
  });
});

describe("healthUrlFor", () => {
  test("uses only an explicit health URL, never a guessed /", () => {
    expect(healthUrlFor({ ...running([3000]), healthUrl: "http://127.0.0.1:3000/ready" }, [])).toBe("http://127.0.0.1:3000/ready");
    const pinned: Pinned[] = [{ id: "web-3000", name: "web", cwd: "/tmp", command: "true", port: 3000, healthUrl: "http://127.0.0.1:3000/health" }];
    expect(healthUrlFor(running([3000]), pinned)).toBe("http://127.0.0.1:3000/health");
    expect(healthUrlFor(running([8787]), [])).toBeUndefined();
    expect(healthUrlFor(stopped, [])).toBeUndefined();
  });
});

describe("probe and applyReadiness", () => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (req) => {
      const url = new URL(req.url);
      if (url.pathname === "/ok") return new Response("ok");
      if (url.pathname === "/gone") return new Response("no", { status: 404 });
      return new Response("no", { status: 503 });
    },
  });
  afterAll(() => server.stop(true));

  test("2xx is ready, 4xx/5xx and refused are unhealthy", async () => {
    const ok = await probe(`http://127.0.0.1:${server.port}/ok`);
    expect(ok.ok).toBe(true);
    expect(ok.status).toBe(200);
    const missing = await probe(`http://127.0.0.1:${server.port}/gone`);
    expect(missing.ok).toBe(false);
    expect(missing.status).toBe(404);
    const down = await probe(`http://127.0.0.1:${server.port}/down`);
    expect(down.ok).toBe(false);
    const refused = await probe("http://127.0.0.1:1/");
    expect(refused.ok).toBe(false);
  });

  test("stopped rows stay stopped; running rows pick up the probe", async () => {
    const pinned: Pinned[] = [{
      id: "web-3000", name: "web", cwd: "/tmp", command: "true", port: 3000,
      healthUrl: `http://127.0.0.1:${server.port}/ok`,
    }];
    const rows = await applyReadiness([
      stopped,
      running([3000], { healthUrl: `http://127.0.0.1:${server.port}/ok` }),
      running([9], { id: "bad-9", name: "bad", healthUrl: `http://127.0.0.1:${server.port}/down` }),
    ], pinned);
    expect(rows[0].readiness).toBe("stopped");
    expect(rows[1].readiness).toBe("ready");
    expect(rows[2]).toMatchObject({ readiness: "unhealthy", health: { ok: false, status: 503 } });
  });

  test("running without a health URL stays ready and is not probed", async () => {
    const rows = await applyReadiness([running([8787], { id: "api-8787", name: "api" })], []);
    expect(rows[0]).toMatchObject({ readiness: "ready" });
    expect(rows[0].health).toBeUndefined();
  });
});
