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
