// The passive stall check's points (bench/kpi/stall.mjs) as the dev view's tests need them: 30 points an hour apart (the idle heartbeat),
// the newest ten minutes before `now`. mode "ok": all ok but one offline gap; "stalled": the last point is a stall on a held lock;
// "stale": ok, but the newest point is three hours old (the timer is not running).
const MIN = 60_000;
const SOURCE = (n) => ({ code_sha: n % 7 < 4 ? "0c9c02b14" : "aca22dd98", bench_version: "folder-sync-stall/1", run_ids: [`stall-fixture-${n}`], dirty: false });

export function healthLines(mode, now = Date.parse("2026-11-04T19:00:00Z")) {
	const lines = [];
	const newest = now - (mode === "stale" ? 180 : 10) * MIN;
	for (let n = 0; n < 30; n++) {
		const t = new Date(newest - (29 - n) * 60 * MIN).toISOString();
		const stalled = mode === "stalled" && n === 29;
		const offline = n === 12;
		const point = { schema: "vt-kpi-point/1", kpi: "sync_stalled_folders", t, source: SOURCE(n), slice: { env: "prod" } };
		if (offline) Object.assign(point, { value: null, n: 0, status: "failed", labels: { result: "offline", checked: 3, pending: 0, stalled: [], reason: "offline, not measured" } });
		else if (stalled) Object.assign(point, { value: 1, n: 3, status: "measured", labels: { result: "stalled", checked: 3, pending: 1, stalled: [{ project: "zach", folder: "/home/me/vt/zach", cause: "lock", detail: "1 changed file not pushed for 14 min; a lock held by pid 4242 (running) for 14 min", age_min: 14, interval_s: 10 }] } });
		else Object.assign(point, { value: 0, n: 3, status: "measured", labels: { result: "ok", checked: 3, pending: n % 5 === 0 ? 1 : 0, stalled: [] } });
		lines.push(JSON.stringify(point));
	}
	return lines.join("\n") + "\n";
}
