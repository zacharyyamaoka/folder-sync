// The catalog's cadence_s must match how often run-all.mjs really writes each KPI (node --test bench/kpi/cadence.test.mjs).
// WHY (Vibe Tracks issue stale-producers-folder-sync, 2026-11-26): every KPI said cadence_s 3600 while the `ops` stage
// writes idle_cpu_pct / idle_ops_per_hour every 12 h and `idle-prod` every 6 h, so Vibe Tracks' stale rule (stale past
// min(6 x cadence, cadence + 12 h) = 6 h for hourly) filed a stale-producer bug every cycle, 41 times since Oct 29.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { catalog } from "./catalog.mjs";
import { stages } from "./run-all.mjs";

// Vibe Tracks' rule, vibetracks/core/rules.py stale_after_s(): mirrored here and checked against the source below.
const STALE_CADENCES = 6;
const STALE_GRACE_S = 12 * 3600;
const staleAfterS = (cadenceS) => Math.min(STALE_CADENCES * cadenceS, cadenceS + STALE_GRACE_S);

// The longest a stage's KPI can go between points: the stage is only checked by the hourly timer (OnCalendar=hourly,
// RandomizedDelaySec=300), so it becomes due up to one tick + the delay late, and a run may take up to its
// TimeoutStartSec (50 min) before the point lands.
const TICK_S = 3600 + 300;
const RUN_S = 50 * 60;
const worstGapS = (everyMs) => everyMs / 1000 + TICK_S + RUN_S;

function writers() {
	const by = new Map();
	for (const stage of stages({ out: "/nonexistent" })) {
		if (!Number.isFinite(stage.every)) continue; // once-per-summary stages (offshelf) have no pace
		for (const { kpi } of stage.marks) by.set(kpi, Math.min(by.get(kpi) ?? Infinity, stage.every));
	}
	return by; // kpi -> its fastest writer's `every`, ms (Vibe Tracks judges a KPI by its newest point over all slices)
}

test("every KPI a stage writes declares a cadence_s whose stale bound covers that stage's worst gap", () => {
	const declared = new Map(catalog("t").kpis.map((k) => [k.id, k.cadence_s]));
	const late = [];
	for (const [kpi, every] of writers()) {
		const cadence = declared.get(kpi);
		assert.ok(cadence > 0, `${kpi} is written by run-all but has no cadence_s in the catalog`);
		if (worstGapS(every) > staleAfterS(cadence)) late.push(`${kpi}: written every ${every / 3600000} h (worst gap ${(worstGapS(every) / 3600).toFixed(1)} h) but cadence_s ${cadence} goes stale after ${staleAfterS(cadence) / 3600} h`);
	}
	assert.deepEqual(late, []);
});

test("no KPI declares a slower pace than its fastest writer (cadence_s is the real pace, not a loosened one)", () => {
	const declared = new Map(catalog("t").kpis.map((k) => [k.id, k.cadence_s]));
	for (const [kpi, every] of writers()) assert.ok(declared.get(kpi) <= Math.max(every / 1000, 3600), `${kpi}: cadence_s ${declared.get(kpi)} is slower than its writer (every ${every / 1000} s)`);
});

test("the stale rule mirrored here is Vibe Tracks' own", { skip: !existsSync(join(homedir(), "vibetracks/vibetracks/core/rules.py")) && "no ~/vibetracks checkout" }, () => {
	const rules = readFileSync(join(homedir(), "vibetracks/vibetracks/core/rules.py"), "utf8");
	assert.match(rules, new RegExp(`^STALE_CADENCES = ${STALE_CADENCES}$`, "m"));
	assert.match(rules, new RegExp(`^STALE_GRACE_S = ${STALE_GRACE_S / 3600} \\* 3600$`, "m"));
	assert.match(rules, /return min\(STALE_CADENCES \* cadence_s, cadence_s \+ STALE_GRACE_S\)/);
});
