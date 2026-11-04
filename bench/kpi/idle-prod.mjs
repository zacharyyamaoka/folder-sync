// O3 idle in production, observed: the CPU the real `folder-sync sync --watch` daemons on this machine use over a short
// window. Read-only (it only reads /proc); it is "observed", not "idle", because a real folder may be syncing during the
// window. Requests in production are Cloudflare's to count (its dashboard / GraphQL analytics need an API token this machine
// does not hold), so there is no production idle_ops_per_hour: bench/kpi/ops.mjs measures the same engine's requests on the
// local stack and the cost model prices those.
import { readdirSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import { sleep, now } from "../latency/harness.mjs";
import { makePoint, sourceOf, stampOf } from "./lib.mjs";
import { treeTicks } from "./ops.mjs";

const CLK_TCK = 100;

/** pids of running `folder-sync … sync … --watch` processes (argv[0]'s basename is folder-sync). */
export function daemons() {
	const pids = [];
	for (const name of readdirSync("/proc")) {
		if (!/^\d+$/.test(name) || Number(name) === process.pid) continue;
		try {
			const argv = readFileSync(`/proc/${name}/cmdline`, "utf8").split("\0").filter(Boolean);
			if (argv.length && basename(argv[0]) === "folder-sync" && argv.includes("sync") && argv.includes("--watch")) pids.push(Number(name));
		} catch { /* gone */ }
	}
	return pids;
}

export async function observe({ seconds = 30, at = new Date(), code }) {
	const t = stampOf(at);
	const id = at.toISOString().slice(0, 13).replace(/[-:]/g, "");
	const slice = { env: "prod", kind: "observed" };
	const source = sourceOf("folder-sync-kpi-idle-prod/1", `idle-prod-${id}`, code);
	const pids = daemons();
	if (!pids.length) return makePoint({ kpi: "idle_cpu_pct", value: null, n: 0, t, source, slice, reason: "no folder-sync sync --watch daemon is running on this machine" });
	const before = pids.map((p) => treeTicks(p));
	const t0 = now();
	await sleep(seconds * 1000);
	const wall = (now() - t0) / 1000;
	const cpu = pids.map((p, i) => ((treeTicks(p) - before[i]) / CLK_TCK / wall) * 100);
	return makePoint({ kpi: "idle_cpu_pct", value: Math.round((cpu.reduce((a, b) => a + b, 0) / cpu.length) * 1000) / 1000, n: pids.length, t, source, slice, labels: { window_s: Math.round(wall), daemons: pids.length, cpu_pct_per_daemon: cpu.map((x) => Math.round(x * 1000) / 1000), target: 0.1, note: "observed: a real folder may be syncing during the window" } });
}
