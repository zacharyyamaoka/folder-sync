// PEP 0010 §6: how the folder's object merges one path, and what it calls a conflict copy. Every case is a fixture in
// testdata/shared/ (merge.json, conflict-names.json), so the same ruler can be read by any lane.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { conflictName, mergeBytes, MERGE_MAX, MERGEABLE } from "../src/shared-merge.ts";

const enc = new TextEncoder();
// WHY ignoreBOM: a byte order mark is part of the file, and the default decoder would drop it from what is compared
const dec = new TextDecoder("utf-8", { ignoreBOM: true });
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`../../testdata/shared/${name}`, import.meta.url), "utf8"));

for (const c of fixture("merge.json").cases as { name: string; path: string; base: string | null; ours: string; theirs: string; expect: { kind: string; result?: string; why?: string } }[]) {
	test(`merge: ${c.name}`, () => {
		const out = mergeBytes(c.path, c.base === null ? null : enc.encode(c.base), enc.encode(c.ours), enc.encode(c.theirs));
		assert.equal(out.kind, c.expect.kind, JSON.stringify(out));
		if (c.expect.result !== undefined) assert.equal(dec.decode((out as { bytes: Uint8Array }).bytes), c.expect.result);
		if (c.expect.why !== undefined) assert.equal((out as { why: string }).why, c.expect.why);
	});
}

test("merge: invalid UTF-8, a NUL byte and a file over 4 MiB are never merged", () => {
	const text = enc.encode("a\nb\nc\nd\n");
	assert.deepEqual(mergeBytes("n.md", text, new Uint8Array([0x61, 0xff, 0x0a]), enc.encode("a\nb\nc\nD\n")), { kind: "conflict", why: "not_mergeable" });
	assert.deepEqual(mergeBytes("n.md", text, enc.encode("a\0b\n"), enc.encode("a\nb\nc\nD\n")), { kind: "conflict", why: "not_mergeable" });
	const big = enc.encode("x\n".repeat(MERGE_MAX / 2 + 1));
	assert.deepEqual(mergeBytes("n.md", text, big, enc.encode("a\nb\nc\nD\n")), { kind: "conflict", why: "too_big" });
	assert.deepEqual(mergeBytes("n.md", text, enc.encode("a\nb\nc\nD\n"), big), { kind: "conflict", why: "too_big" });
});

test("merge: the list of mergeable suffixes is the contract's", () => {
	assert.deepEqual([...MERGEABLE].sort(), [".canvas", ".csv", ".json", ".jsonl", ".markdown", ".md", ".toml", ".txt", ".yaml", ".yml"]);
});

test("merge: a byte order mark and a lone line without a newline come back exactly", () => {
	const base = enc.encode("\uFEFFone\ntwo\nthree\nfour\nfive");
	const ours = enc.encode("\uFEFFONE\ntwo\nthree\nfour\nfive");
	const theirs = enc.encode("\uFEFFone\ntwo\nthree\nfour\nFIVE");
	const out = mergeBytes("n.txt", base, ours, theirs);
	assert.equal(out.kind, "merged");
	assert.equal(dec.decode((out as { bytes: Uint8Array }).bytes), "\uFEFFONE\ntwo\nthree\nfour\nFIVE");
});

for (const c of fixture("conflict-names.json").cases as { name: string; path: string; device: string; at_local: string | null; taken: string[]; expect: string; now?: string }[]) {
	test(`conflict name: ${c.name}`, () => {
		const taken = new Set(c.taken);
		const now = Date.parse(c.now ?? "2026-11-04T12:00:00.000Z");
		assert.equal(conflictName(c.path, c.device, c.at_local ?? undefined, (name) => taken.has(name), now), c.expect);
	});
}

test("conflict name: nothing that Windows could not hold, whatever the device calls itself", () => {
	for (const device of ["CON", "a.", " lead", "nul:", "tab\there", "new\nline", "\u0000"]) {
		const name = conflictName("plan.md", device, "2026-11-04T12:30:00Z", () => false, 0);
		assert.doesNotMatch(name, /[<>:"|?*\\\u0000-\u001f]/, name);
		assert.match(name, /^plan \(Conflicted copy .+ 202611041230\)\.md$/);
	}
});
