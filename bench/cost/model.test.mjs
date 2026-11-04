// The cost model, checked against hand-worked numbers (node --test bench/).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { costFor, monthlyOps, platformCost, PROFILES } from "./model.mjs";

const prices = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "prices.json"), "utf8"));
const counters = {
	idle: { class_a_per_hour_per_machine: 0, class_b_per_hour_per_machine: 60, worker_per_hour_per_machine: 30, do_per_hour_per_machine: 0 },
	change: { class_a_writer: 4, class_b_writer: 2, class_b_per_reader: 3, worker: 5, do: 1 },
};
const profile = { name: "t", live_gb: 10, machines: 3, changes_per_day: 1000, change_kb: 100, days: 30 };
const near = (got, want) => assert.ok(Math.abs(got - want) < 1e-9, `${got} != ${want}`);

test("monthlyOps: idle per machine-hour plus per-change writer and per-reader costs", () => {
	const ops = monthlyOps(counters, profile);
	assert.equal(ops.class_a, 120_000);
	assert.equal(ops.class_b, 129_600 + 240_000);
	assert.equal(ops.worker, 64_800 + 150_000);
	assert.equal(ops.do, 30_000);
	near(ops.egress_gb, 6.144);
});

test("R2: storage on live x (1+H), class A and B, free egress", () => {
	const c = costFor({ provider: "r2", prices, counters, profile, h: 1 });
	near(c.storage_usd, 0.3);
	near(c.ops_usd, 0.54 + 0.369_6 * 0.36);
	near(c.egress_usd, 0);
	near(c.total_usd, 0.973056);
	near(c.per_gb_usd, 0.0973056);
	assert.equal(c.lower_bound, false);
});

test("R2 with the free tier applied takes 10 GB and the free operations off", () => {
	near(costFor({ provider: "r2", prices, counters, profile, h: 1, free_tier: true }).total_usd, 0.15);
});

test("B2: free class A/B, egress inside 3x stored is free", () => {
	const c = costFor({ provider: "b2", prices, counters, profile, h: 1 });
	near(c.total_usd, 0.139);
	near(c.egress_usd, 0);
});

test("B2 egress beyond 3x stored costs $0.01 a GB", () => {
	const heavy = { ...profile, change_kb: 20_000 }; // 1.2288 TB read a month against 20 GB stored
	const c = costFor({ provider: "b2", prices, counters, profile: heavy, h: 1 });
	near(c.egress_gb, 1228.8);
	near(c.egress_usd, (1228.8 - 60) * 0.01);
});

test("Wasabi: the 1 TB minimum charge wins over 20 GB of storage", () => {
	const c = costFor({ provider: "wasabi", prices, counters, profile, h: 1 });
	near(c.total_usd, 7.99);
	assert.equal(c.min_applied, true);
});

test("S3: egress price unknown makes the cost a lower bound, not a guess", () => {
	const c = costFor({ provider: "s3", prices, counters, profile, h: 1 });
	near(c.total_usd, 0.46 + 0.6 + 0.369_6 * 0.4);
	assert.equal(c.lower_bound, true);
});

test("platform: Workers and Durable Object requests at list overage, the $5 base kept apart", () => {
	const p = platformCost({ prices, counters, profile });
	near(p.usd, 0.214_8 * 0.3 + 0.03 * 0.15);
	assert.equal(p.base_usd, 5);
});

test("the reference profile is Zach's: 10 GB, 3 machines, 1000 changes a day", () => {
	assert.deepEqual([PROFILES.reference.live_gb, PROFILES.reference.machines, PROFILES.reference.changes_per_day], [10, 3, 1000]);
});

test("every price in prices.json has a primary source with url and date_accessed 2026-11-04", () => {
	const walk = (name, node) => {
		const priced = Object.entries(node).filter(([k, v]) => typeof v === "number" || (v === null && k.endsWith("_per_gb")));
		for (const [key] of priced) {
			const s = node.sources?.[key];
			assert.ok(s && /^https:\/\//.test(s.url) && s.quote && s.date_accessed === "2026-11-04", `${name}.${key} has no complete source`);
		}
	};
	for (const [id, p] of Object.entries(prices.providers)) walk(id, p);
	for (const [id, p] of Object.entries(prices.platform)) walk(`platform.${id}`, p);
	for (const [id, p] of Object.entries(prices.competitors)) walk(`competitors.${id}`, Object.fromEntries(Object.entries(p).filter(([k]) => k !== "storage_gb" && k !== "max_file_mb")));
});
