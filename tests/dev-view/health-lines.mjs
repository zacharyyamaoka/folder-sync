// The live stall check's points (bench/kpi/canary.mjs) as the dev view's tests need them: 40 checks five minutes apart, the newest
// three minutes before `now`. mode "ok": all ok but one offline gap; "stalled": the last three canary checks stalled on a held lock
// and one folder reported stalled; "stale": ok, but the newest check is two hours old.
const MIN = 60_000;
const SOURCE = (n) => ({ code_sha: n % 7 < 4 ? "0c9c02b14" : "aca22dd98", bench_version: "folder-sync-canary/1", run_ids: [`canary-fixture-${n}`], dirty: false });

export function healthLines(mode, now = Date.parse("2026-11-04T19:00:00Z")) {
	const lines = [];
	const newest = now - (mode === "stale" ? 120 : 3) * MIN;
	for (let n = 0; n < 40; n++) {
		const t = new Date(newest - (39 - n) * 5 * MIN).toISOString();
		const stalled = mode === "stalled" && n >= 37;
		const offline = n === 12;
		const canary = { schema: "vt-kpi-point/1", kpi: "sync_canary_ms", t, source: SOURCE(n), slice: { env: "prod" } };
		if (stalled) Object.assign(canary, { value: null, n: 0, status: "failed", labels: { result: "stalled", cause: "lock", detail: "every round was refused: another round holds the folder's lock (pid 4242 at 2026-11-04T18:41:00Z); the file was not online after 600 s", reason: "stalled: lock" } });
		else if (offline) Object.assign(canary, { value: null, n: 0, status: "failed", labels: { result: "offline", cause: "offline", detail: "offline, not measured", reason: "offline, not measured" } });
		else Object.assign(canary, { value: 300 + ((n * 137) % 600), n: 1, status: "measured", labels: { result: "ok" } });
		lines.push(canary);
		const folders = { schema: "vt-kpi-point/1", kpi: "sync_stalled_folders", t, source: SOURCE(n), slice: { env: "prod" } };
		const stuck = mode === "stalled" && n === 39;
		if (offline) Object.assign(folders, { value: null, n: 0, status: "failed", labels: { result: "offline", checked: 3, stalled: [], reason: "offline, not measured" } });
		else Object.assign(folders, { value: stuck ? 1 : 0, n: 3, status: "measured", labels: { result: stuck ? "stalled" : "ok", checked: 3, stalled: stuck ? [{ project: "zach", folder: "/home/me/vt/zach", cause: "lock", detail: "no round completed for 14 min; a lock held by pid 4242 (running) for 14 min", age_min: 14, interval_s: 10 }] : [] } });
		lines.push(folders);
	}
	return lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
}
