// scripts/gates's own tests: how a proof's output becomes a status, the shape of gates.json, and that every proof it names
// exists (a renamed test must fail here, not turn a gate silently green). Run: node --test scripts/gates.test.mjs
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const lib = require("./gates-lib.cjs");
const ctx = { soakProfile: "ci", soakSeed: "1", outDir: "/tmp/x", noGh: true, profile: "ci" };

test("go test -json: one entry per top-level test, subtests folded in, a skip and a failure told apart", () => {
	const events = [
		{ Action: "run", Test: "TestA" },
		{ Action: "run", Test: "TestA/sub" },
		{ Action: "output", Test: "TestA/sub", Output: "    a_test.go:9: boom\n" },
		{ Action: "fail", Test: "TestA/sub", Elapsed: 0.1 },
		{ Action: "fail", Test: "TestA", Elapsed: 1.5 },
		{ Action: "skip", Test: "TestB", Elapsed: 0 },
		{ Action: "pass", Test: "TestC", Elapsed: 0.25 },
		{ Action: "fail", Package: "folder-sync/e2e" },
	].map((e) => JSON.stringify(e));
	const { tests, packageFailed } = lib.parseGoJson(events.join("\n"));
	assert.deepEqual(tests.map((t) => [t.name, t.status, t.duration_ms]), [["TestA", "fail", 1500], ["TestB", "skip", 0], ["TestC", "pass", 250]]);
	assert.match(tests[0].lines.join("\n"), /boom/);
	assert.equal(packageFailed, true);
});

test("a build failure leaves no test entries and keeps the compiler's words", () => {
	const { tests, output, packageFailed } = lib.parseGoJson(['{"Action":"output","Package":"p","Output":"x.go:3: undefined: y\\n"}', '{"Action":"fail","Package":"p"}'].join("\n"));
	assert.equal(tests.length, 0);
	assert.equal(packageFailed, true);
	assert.match(output.join("\n"), /undefined: y/);
});

test("node --test TAP: top-level tests only, with their duration, skips and failure detail", () => {
	const tap = [
		"TAP version 13",
		"# Subtest: first",
		"ok 1 - first",
		"  ---",
		"  duration_ms: 12.6",
		"  type: 'test'",
		"  ...",
		"# Subtest: second",
		"    ok 1 - nested",
		"not ok 2 - second",
		"  ---",
		"  duration_ms: 3",
		"  error: 'it broke'",
		"  ...",
		"ok 3 - third # SKIP no network",
		"1..3",
	].join("\n");
	const tests = lib.parseTap(tap);
	assert.deepEqual(tests.map((t) => [t.name, t.status, t.duration_ms]), [["first", "pass", 13], ["second", "fail", 3], ["third", "skip", 0]]);
	assert.match(tests[1].detail, /it broke/);
});

const T = (status) => ({ name: `t-${status}`, status, duration_ms: 1, detail: "" });
test("aggregate: fail beats not_built beats skipped beats pass; an empty gate is not_built; advisory proofs never decide", () => {
	assert.equal(lib.aggregate([{ tests: [T("pass")] }]).status, "pass");
	assert.equal(lib.aggregate([{ tests: [T("pass"), T("skip")] }]).status, "skipped");
	assert.equal(lib.aggregate([{ tests: [T("pass"), T("skip")], notBuilt: [{ name: "n", reason: "r" }] }]).status, "not_built");
	assert.equal(lib.aggregate([{ tests: [T("fail")], notBuilt: [{ name: "n", reason: "r" }] }, { tests: [T("pass")] }]).status, "fail");
	assert.equal(lib.aggregate([]).status, "not_built");
	assert.equal(lib.aggregate([{ tests: [T("pass")] }, { tests: [T("fail")], notBuilt: [{ name: "n", reason: "r" }], advisory: true }]).status, "pass");
	const verdict = lib.aggregate([{ tests: [T("pass")], notBuilt: [{ name: "a second S3 store", reason: "not wired" }] }]);
	assert.match(verdict.summary, /a second S3 store \(not wired\)/);
});

function document() {
	return {
		schema: "folder-sync-gates/1", run_at: new Date().toISOString(), code_sha: "abc1234", branch: "x",
		gates: lib.GATE_IDS.map((id) => ({ id, name: id, status: "pass", summary: "ok", tests: [{ name: "t", status: "pass", duration_ms: 1, detail: "" }], evidence: [] })),
	};
}
test("validate: the frozen shape of gates.json", () => {
	assert.deepEqual(lib.validate(document()), []);
	const missing = document(); missing.gates.pop();
	assert.ok(lib.validate(missing).length > 0, "11 gates");
	const badStatus = document(); badStatus.gates[3].status = "green";
	assert.match(lib.validate(badStatus).join(), /G4: status green/);
	const badTest = document(); badTest.gates[0].tests[0].status = "ok";
	assert.match(lib.validate(badTest).join(), /status ok/);
	const wrongOrder = document(); wrongOrder.gates.reverse();
	assert.ok(lib.validate(wrongOrder).length > 0);
	assert.ok(lib.validate({ ...document(), schema: "folder-sync-gates/2" }).length > 0);
});

test("twelve gates, G1..G12 in order, each with a target and at least one proof", () => {
	const gates = lib.definitions(ctx);
	assert.deepEqual(gates.map((g) => g.id), lib.GATE_IDS);
	for (const g of gates) {
		assert.ok(g.target.length > 20, `${g.id} target`);
		assert.ok(g.proofs.length > 0, `${g.id} proofs`);
	}
});

test("every Go test a gate names exists, and every node test file and name pattern matches something", () => {
	const repo = lib.REPO;
	const gates = lib.definitions(ctx);
	for (const g of gates) {
		for (const p of g.proofs) {
			if (p.kind === "go") {
				const dir = path.join(repo, p.pkg);
				const source = fs.readdirSync(dir).filter((f) => f.endsWith("_test.go")).map((f) => fs.readFileSync(path.join(dir, f), "utf8")).join("\n");
				assert.ok(source.length > 0, `${g.id}: no test files in ${p.pkg}`);
				for (const name of p.tests || []) assert.match(source, new RegExp(`^func ${name}\\(t \\*testing\\.T\\)`, "m"), `${g.id}: ${p.pkg} has no ${name}`);
			}
			if (p.kind === "node") {
				const file = path.join(repo, p.cwd, p.file);
				assert.ok(fs.existsSync(file), `${g.id}: ${file} is missing`);
				if (p.pattern) {
					const titles = [...fs.readFileSync(file, "utf8").matchAll(/^test\((["'`])(.*?)\1/gm)].map((m) => m[2]);
					assert.ok(titles.some((t) => new RegExp(p.pattern).test(t)), `${g.id}: no test in ${p.file} matches ${p.pattern}`);
				}
			}
			if (p.kind === "cmd") assert.ok(fs.existsSync(path.join(repo, p.argv[1])), `${g.id}: ${p.argv[1]} is missing`);
		}
	}
});

test("G8: the drop-in the demo shows is 20 lines or fewer, and the demo page embeds the documented snippet", () => {
	const { tests } = lib.dropIn8();
	assert.deepEqual(tests.map((t) => t.status), ["pass", "pass", "pass"], JSON.stringify(tests, null, 1));
	const total = Number(/= (\d+)\)/.exec(tests[0].name)[1]);
	assert.ok(total >= 5 && total <= 20, `${total} lines`);
});

test("G11 platform times come from the files the CI jobs upload; a missing platform is not built, not passed", () => {
	const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || "/tmp", "g11-"));
	fs.writeFileSync(path.join(dir, "g11-windows.json"), JSON.stringify({ os: "windows", seconds: 40.2, measures: "m" }));
	fs.writeFileSync(path.join(dir, "g11-darwin.json"), JSON.stringify({ os: "darwin", seconds: 130, measures: "m" }));
	const both = lib.definitions({ ...ctx, collect: dir }).find((g) => g.id === "G11").proofs.find((p) => p.name === "platforms").fn({ ...ctx, collect: dir });
	assert.deepEqual(both.tests.map((t) => t.status), ["fail", "pass"]); // macOS first: 130 s is over the gate
	const none = lib.definitions(ctx).find((g) => g.id === "G11").proofs.find((p) => p.name === "platforms").fn(ctx);
	assert.equal(none.notBuilt.length, 2);
	fs.rmSync(dir, { recursive: true });
});

// --- G4 reads the three OS legs; G5 names its three journeys; G11's timer (lane platforms) --------------------------------------

import { spawnSync } from "node:child_process";
import os from "node:os";

const SHA = "a".repeat(40);
const gate = (c, id) => lib.definitions(c).find((g) => g.id === id);
function legDoc(name, jobStatus, sha = SHA) {
	const g4 = { id: "G4", name: "Cross-platform", status: jobStatus === "success" ? "pass" : "fail", summary: `1 ${jobStatus}`, tests: [{ name: `${name}: the test job`, status: jobStatus === "success" ? "pass" : "fail", duration_ms: 0, detail: "" }], evidence: [] };
	const rest = lib.GATE_IDS.filter((id) => id !== "G4").map((id) => ({ id, name: id, status: "skipped", summary: "not run: left out by --only", tests: [], evidence: [] }));
	const gates = [...rest.slice(0, 3), g4, ...rest.slice(3)];
	return { schema: "folder-sync-gates/1", run_at: new Date().toISOString(), code_sha: sha, branch: "x", leg: { os: name, jobStatus, arch: "amd64", runner: `runner-${name}` }, gates };
}
function legsDir(spec, { nested = true, sha } = {}) {
	const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || "/tmp", "legs-"));
	for (const [name, status] of Object.entries(spec)) {
		const where = nested ? path.join(dir, `gates-${name}`) : dir; // actions/download-artifact: a folder per artifact
		fs.mkdirSync(where, { recursive: true });
		fs.writeFileSync(path.join(where, `gates-${name}.json`), JSON.stringify(legDoc(name, status, sha)));
	}
	return dir;
}
const g4 = (c) => gate(c, "G4").proofs.find((p) => p.name === "ci").fn(c);
const g4Status = (c) => lib.aggregate([{ ...g4(c) }]).status;
const NEEDS_OK = { test: { result: "success" }, desktop: { result: "success" }, "core-alone": { result: "success" } };

test("G4 passes only when linux, macos and windows each uploaded a passing gates-<os>.json for this commit, and the installer smoke passed", () => {
	const all = legsDir({ linux: "success", macos: "success", windows: "success" });
	const c = { ...ctx, sha: SHA, needs: NEEDS_OK, osResults: all };
	assert.equal(g4Status(c), "pass", JSON.stringify(g4(c), null, 1));
	assert.equal(g4(c).tests.filter((t) => t.name.startsWith("CI leg")).length, 3);
	// the same files lying flat in the directory (gh run download -D) read the same
	assert.equal(g4Status({ ...c, osResults: legsDir({ linux: "success", macos: "success", windows: "success" }, { nested: false }) }), "pass");
});

test("G4: one OS missing is not built, one failing is fail, a leg from another commit is never a pass", () => {
	const base = { ...ctx, sha: SHA, needs: NEEDS_OK };
	const missing = { ...base, osResults: legsDir({ linux: "success", macos: "success" }) };
	assert.equal(g4Status(missing), "not_built");
	assert.match(lib.aggregate([g4(missing)]).summary, /CI leg windows/);
	assert.equal(g4Status({ ...base, osResults: legsDir({ linux: "success", macos: "failure", windows: "success" }) }), "fail");
	const other = { ...base, osResults: legsDir({ linux: "success", macos: "success", windows: "success" }, { sha: "b".repeat(40) }) };
	assert.notEqual(g4Status(other), "pass");
	assert.equal(g4(other).tests.filter((t) => t.status === "skip").length, 3);
	// a file that is not a gates document, or says it is another OS, is a fail
	const bad = legsDir({ linux: "success", macos: "success", windows: "success" });
	fs.writeFileSync(path.join(bad, "gates-windows", "gates-windows.json"), JSON.stringify({ ...legDoc("linux", "success"), leg: { os: "linux" } }));
	assert.equal(g4Status({ ...base, osResults: bad }), "fail");
});

test("G4: green legs without the installer smoke, or with the smoke red, do not pass; the other CI jobs still count", () => {
	const all = legsDir({ linux: "success", macos: "success", windows: "success" });
	const { desktop, ...noSmoke } = NEEDS_OK;
	assert.notEqual(g4Status({ ...ctx, sha: SHA, needs: noSmoke, osResults: all }), "pass");
	assert.equal(g4Status({ ...ctx, sha: SHA, needs: { ...NEEDS_OK, desktop: { result: "failure" } }, osResults: all }), "fail");
	assert.equal(g4Status({ ...ctx, sha: SHA, needs: { ...NEEDS_OK, "core-alone": { result: "failure" } }, osResults: all }), "fail");
	assert.equal(g4Status({ ...ctx, sha: SHA, needs: { ...NEEDS_OK, test: { result: "failure" } }, osResults: all }), "fail");
});

test("G4 also lints the workflows, and a leg run holds only its own G4 proof", () => {
	assert.ok(gate(ctx, "G4").proofs.some((p) => p.kind === "cmd" && p.argv.join(" ") === "bash scripts/gates-actionlint"));
	const leg = { ...ctx, leg: { os: "macos", jobStatus: "success", arch: "arm64", runner: "r" } };
	assert.deepEqual(gate(leg, "G4").proofs.map((p) => p.name), ["leg"]);
	assert.equal(gate(leg, "G4").proofs[0].fn(leg).tests[0].status, "pass");
	assert.equal(gate({ ...leg, leg: { ...leg.leg, jobStatus: "failure" } }, "G4").proofs[0].fn({ ...leg, leg: { ...leg.leg, jobStatus: "failure" } }).tests[0].status, "fail");
});

test("scripts/gates --os-leg writes the file the gates job reads: G4 from the job status, G11 from the timer, nothing else run", () => {
	const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || "/tmp", "leg-"));
	fs.writeFileSync(path.join(dir, "first-sync-linux.json"), JSON.stringify({ schema: "folder-sync-first-sync/1", os: "linux", arch: "amd64", seconds: 7.5, limit_seconds: 120, ok: true, why: "", steps: [{ name: "install", seconds: 1, ok: true, detail: "" }] }));
	const run = (status) => spawnSync(process.execPath, [path.join(lib.REPO, "scripts", "gates"), "--os-leg", "linux", "--job-status", status, "--no-gh", "--collect", dir, "--out", path.join(dir, `gates-${status}`, "gates-linux.json")], { encoding: "utf8" });
	const good = run("success");
	assert.equal(good.status, 0, good.stdout + good.stderr);
	const doc = JSON.parse(fs.readFileSync(path.join(dir, "gates-success", "gates-linux.json"), "utf8"));
	assert.deepEqual(lib.validate(doc), []);
	assert.equal(doc.leg.os, "linux");
	assert.deepEqual(doc.gates.filter((g) => g.status !== "skipped").map((g) => [g.id, g.status]), [["G4", "pass"], ["G11", "pass"]]);
	assert.match(doc.gates[10].tests[0].name, /first sync on Linux/);
	const bad = run("failure");
	assert.equal(bad.status, 1, "a failed job fails the leg");
	assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "gates-failure", "gates-linux.json"), "utf8")).gates[3].status, "fail");
	assert.equal(spawnSync(process.execPath, [path.join(lib.REPO, "scripts", "gates"), "--os-leg", "beos", "--out", "x"], { encoding: "utf8" }).status, 2);
});

test("G5 names one journey per surface: the CLI, the web page, the desktop window", () => {
	const names = gate(ctx, "G5").proofs.map((p) => (p.kind === "go" ? `go ${p.tests.join()}` : p.argv.join(" ")));
	assert.deepEqual(names, ["go TestTwoMachines", "node ui/scripts/files-real.mjs", "node app/test/journey.mjs"]);
	assert.ok(gate(ctx, "G5").proofs.every((p) => p.kind === "go" || p.needs === "web"), "the web and desktop journeys wait for --with-web");
});

test("G11 timer: one first-sync-<os>.json per platform; over the limit fails, a missing platform is not built, never passed", () => {
	const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || "/tmp", "timer-"));
	const put = (name, seconds, ok = true) => fs.writeFileSync(path.join(dir, `first-sync-${name}.json`), JSON.stringify({ schema: "folder-sync-first-sync/1", os: name, arch: name === "darwin" ? "arm64" : "amd64", seconds, limit_seconds: 120, ok, why: "", steps: [] }));
	const timer = (c) => gate(c, "G11").proofs.find((p) => p.name === "timer").fn(c);
	const solo = { ...ctx, outDir: path.join(dir, "out"), collect: dir };
	put("linux", 8); put("darwin", 95.5); put("windows", 40);
	let r = timer(solo);
	assert.deepEqual(r.tests.map((t) => t.status), ["pass", "pass", "pass"]);
	assert.match(r.tests[1].name, /macOS\/arm64.*95\.5 s/);
	assert.equal(r.notBuilt.length, 0);
	put("windows", 121);
	assert.deepEqual(timer(solo).tests.map((t) => t.status), ["pass", "pass", "fail"]);
	put("windows", 30, false); // a step failed: over-the-clock or not, it is a fail
	assert.equal(timer(solo).tests[2].status, "fail");
	put("windows", 30);
	fs.rmSync(path.join(dir, "first-sync-darwin.json"));
	r = timer(solo);
	assert.equal(r.notBuilt.length, 1);
	assert.match(r.notBuilt[0].name, /macOS/);
	assert.equal(lib.aggregate([r]).status, "not_built");
	// a leg holds only its own platform
	put("windows", 121);
	r = timer({ ...solo, leg: { os: "windows", jobStatus: "success" } });
	assert.deepEqual(r.tests.map((t) => t.status), ["fail"]);
	fs.rmSync(dir, { recursive: true });
});
