import { afterAll, expect, test } from "bun:test";
import { discover } from "../lib/discover";

const PORT = 39999;
const code = `Bun.serve({port:${PORT},fetch(){return new Response("ok")}});setInterval(()=>{},1e6)`;
const tree = Bun.spawn(["/bin/sh", "-c", `bun -e '${code}'; exit 0`], { stdout: "ignore", stderr: "ignore" });
let treePids: number[] = [tree.pid];

afterAll(() => {
  for (const pid of treePids) {
    try { process.kill(pid, "SIGKILL"); } catch {}
  }
});

async function waitForPort(): Promise<void> {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/`);
      if (res.ok) return;
    } catch {}
    await Bun.sleep(100);
  }
  throw new Error(`port ${PORT} never opened`);
}

test("discover() finds a real sh -c bun tree with cwd, ports and kind", async () => {
  await waitForPort();
  const services = await discover();
  const svc = services.find((s) => s.ports.includes(PORT));
  expect(svc).toBeDefined();
  treePids = svc!.pids;
  expect(svc!.rootPid).toBe(tree.pid);
  expect(svc!.pids).toHaveLength(2);
  expect(svc!.kind).toBe("dev");
  expect(svc!.cwd).toBe(process.cwd());
  expect(svc!.name).toBe("devboard"); // package.json name of this project
  expect(svc!.command.startsWith("/bin/sh -c bun -e")).toBe(true);
}, 15000);
