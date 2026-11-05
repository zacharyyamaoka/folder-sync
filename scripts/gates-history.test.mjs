// scripts/gates-history: gates.json documents and CI runs in, one history line each out (node --test scripts/gates-history.test.mjs).
// gh is replaced by a fake that serves a run list and writes the artifact where `gh run download -D` is told to.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildHistory, entryFromGates, fetchRuns, main, snapshotLocal } from "./gates-history.mjs";

const gate = (id, status, tests = []) => ({ id, name: id, status, summary: `${status}`, tests, evidence: [] });
const doc = (runAt, sha, overrides = {}) => ({
	schema: "folder-sync-gates/1", run_at: runAt, code_sha: sha, branch: "claude/folder-sync-v0", profile: "ci",
	gates: Array.from({ length: 12 }, (_, i) => gate(`G${i + 1}`, overrides[`G${i + 1}`] ?? "pass", overrides[`G${i + 1}`] === "fail" ? [{ name: "go ./e2e TestSoak", status: "fail", duration_ms: 1, detail: "boom" }, { name: "ok one", status: "pass" }] : [])),
});
const tmp = () => mkdtempSync(join(tmpdir(), "gates-history-test-"));

function fakeGh({ runs, artifacts }) {
	const calls = [];
	const gh = (args) => {
		calls.push(args.slice(0, 2).join(" ") + (args[0] === "run" && args[1] === "download" ? ` ${args[2]}` : ""));
		if (args[0] === "run" && args[1] === "list") return { ok: true, out: JSON.stringify(runs[args[args.indexOf("--branch") + 1]] ?? []), err: "" };
		const id = args[2];
		if (!artifacts[id]) return { ok: false, out: "", err: "no valid artifacts found to download" };
		const dir = args[args.indexOf("-D") + 1];
		writeFileSync(join(dir, "gates.json"), JSON.stringify(artifacts[id]));
		return { ok: true, out: "", err: "" };
	};
	return { gh, calls };
}
const run = (databaseId, headBranch, headSha, createdAt, status = "completed", conclusion = "failure") => ({ databaseId, headBranch, headSha, createdAt, status, conclusion, event: "push", url: `https://example.test/runs/${databaseId}` });

test("a gates.json becomes a line per run: every gate's status, and the failing tests' names", () => {
	const e = entryFromGates(doc("2026-11-04T21:00:00Z", "abc123", { G1: "fail", G11: "not_built" }), { id: "ci-1", source: "ci", url: "u", conclusion: "failure" });
	assert.deepEqual(Object.keys(e.gates), Array.from({ length: 12 }, (_, i) => `G${i + 1}`));
	assert.deepEqual([e.gates.G1.status, e.gates.G1.failing, e.gates.G11.status, e.gates.G2.status], ["fail", ["go ./e2e TestSoak"], "not_built", "pass"]);
	assert.deepEqual([e.sha, e.t, e.source, e.conclusion], ["abc123", "2026-11-04T21:00:00Z", "ci", "failure"]);
});

test("CI runs: artifacts are cached by run id, a completed run is never asked again, a run without a file is a hollow column", () => {
	const cache = tmp();
	const runs = { "claude/folder-sync-v0": [run(1, "claude/folder-sync-v0", "aaa", "2026-11-04T10:00:00Z"), run(2, "claude/folder-sync-v0", "bbb", "2026-11-04T11:00:00Z")], main: [run(3, "main", "ccc", "2026-11-04T12:00:00Z", "in_progress", "")] };
	const artifacts = { 1: doc("2026-11-04T10:20:00Z", "aaa", { G2: "fail" }) };
	const first = fakeGh({ runs, artifacts });
	fetchRuns({ repo: "o/r", branches: ["claude/folder-sync-v0", "main"], limit: 10, cacheDir: cache, gh: first.gh });
	let history = buildHistory({ cacheDir: cache });
	assert.deepEqual(history.map((h) => [h.id, h.gates ? h.gates.G2.status : null]), [["ci-1", "fail"], ["ci-2", null], ["ci-3", null]]);
	assert.match(history[1].note, /uploaded no gates file/);
	assert.match(history[2].note, /still running/);
	// the second time: runs 1 and 2 are final, only the running run 3 is asked for again
	const second = fakeGh({ runs, artifacts: { ...artifacts, 3: doc("2026-11-04T12:30:00Z", "ccc") } });
	fetchRuns({ repo: "o/r", branches: ["claude/folder-sync-v0", "main"], limit: 10, cacheDir: cache, gh: second.gh });
	assert.deepEqual(second.calls.filter((c) => c.startsWith("run download")), ["run download 3"]);
	history = buildHistory({ cacheDir: cache });
	assert.equal(history.at(-1).gates.G1.status, "pass");
});

test("a branch gh cannot list is a warning, not a failure", () => {
	const warnings = fetchRuns({ repo: "o/r", branches: ["x"], limit: 5, cacheDir: tmp(), gh: () => ({ ok: false, out: "", err: "HTTP 401: bad credentials\nmore" }) }).warnings;
	assert.deepEqual(warnings, ["gh run list (x) failed: HTTP 401: bad credentials"]);
});

test("a local gates.json is snapshotted once and is a column of its own, ordered by time among the CI runs", () => {
	const cache = tmp();
	const local = join(cache, "..", `gates-local-${process.pid}.json`);
	writeFileSync(local, JSON.stringify(doc("2026-11-04T10:30:00Z", "locsha1234", { G5: "not_built" })));
	const file = snapshotLocal({ gatesFile: local, cacheDir: cache });
	assert.equal(snapshotLocal({ gatesFile: local, cacheDir: cache }), file);
	assert.equal(snapshotLocal({ gatesFile: join(cache, "nope.json"), cacheDir: cache }), null);
	const runs = { main: [run(9, "main", "zzz", "2026-11-04T11:00:00Z")] };
	fetchRuns({ repo: "o/r", branches: ["main"], limit: 5, cacheDir: cache, gh: fakeGh({ runs, artifacts: { 9: doc("2026-11-04T11:10:00Z", "zzz") } }).gh });
	const history = buildHistory({ cacheDir: cache });
	assert.deepEqual(history.map((h) => [h.source, h.sha.slice(0, 3)]), [["local", "loc"], ["ci", "zzz"]]);
	assert.equal(history[0].gates.G5.status, "not_built");
});

test("main writes gates-history.jsonl; --no-fetch uses only the cache and the local file", async () => {
	const dir = tmp();
	const gates = join(dir, "gates.json");
	writeFileSync(gates, JSON.stringify(doc("2026-11-04T09:00:00Z", "feed1234")));
	const out = join(dir, "status", "gates-history.jsonl");
	const code = await main(["--no-fetch", "--cache", join(dir, "cache"), "--gates", gates, "--out", out]);
	assert.equal(code, 0);
	const lines = readFileSync(out, "utf8").trim().split("\n").map((l) => JSON.parse(l));
	assert.equal(lines.length, 1);
	assert.equal(lines[0].schema, "folder-sync-gates-history/1");
	assert.equal(await main(["--bogus"]), 2);
	assert.ok(existsSync(out));
	mkdirSync(join(dir, "x"), { recursive: true });
});
