// How the folder's object merges one path of the shared tree, and what it calls the copy of a change that will not
// merge (docs/peps/0010 §6). Pure functions over bytes: no bucket, no clock, so the same fixtures (testdata/shared/) can
// pin them from any lane.
//
// WHY the merge lives here and not on each device (PEP 0010 §6.1): the object is the one sequencer, so machines, agents
// and pages all get one implementation, and two devices that collide never keep losing the swap to each other.
//
// Order of attempts, for a path both sides changed since the base:
//   1. unchanged  ours is the base's bytes: nothing of ours to add, theirs stands.
//   2. tails      base exists, both sides only appended whole lines: theirs, then our tail. WHY (git calls two appends at
//                 the end of a file a conflict): this is what a JSONL log or any append-only text needs.
//   3. merged     diff3 by lines (git merge-file semantics, node-diff3): a change both sides made is taken once,
//                 overlapping changes collide. Lines keep their own endings, so CRLF and a missing final newline
//                 survive byte for byte.
//   4. conflict   anything else. No conflict markers are ever written into a file.
// A .json, .canvas, .jsonl, .yaml, .yml or .toml result that no longer parses is a conflict too (WHY: a clean merge can
// still be wrong, `C - Semantic Merge Conflict`; for a file an app parses, a broken file is worse than a visible copy).

import { diff3Merge } from "./vendor/node-diff3.js";
import { parse as parseToml } from "./vendor/smol-toml.js";
import { parse as parseYaml } from "./vendor/yaml.js";

/** The largest file the object merges (R2 Workers hold 128 MB per isolate, and a merge holds three buffers). */
export const MERGE_MAX = 4 * 1024 * 1024;
/** The most lines a merge compares: diff3's longest-common-subsequence is quadratic in the worst case. */
const LINES_MAX = 200_000;
/** The suffixes of files that merge (a contract default, docs/CONTRACT.md); everything else becomes a conflict copy. */
export const MERGEABLE = [".md", ".markdown", ".txt", ".json", ".jsonl", ".yaml", ".yml", ".toml", ".csv", ".canvas"];

export type Collision = "not_mergeable" | "too_big" | "overlap" | "parse";
export type Merge = { kind: "unchanged" } | { kind: "tails" | "merged"; bytes: Uint8Array } | { kind: "conflict"; why: Collision };

// WHY ignoreBOM: a byte order mark is part of the file; the default decoder would drop it from what is merged
const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const encoder = new TextEncoder();

function suffixOf(path: string): string {
	const name = path.slice(path.lastIndexOf("/") + 1);
	const dot = name.lastIndexOf(".");
	return dot > 0 ? name.slice(dot).toLowerCase() : "";
}

function same(a: Uint8Array, b: Uint8Array): boolean {
	return a.byteLength === b.byteLength && a.every((byte, i) => byte === b[i]);
}

/** The text of `bytes`, or null when they are not valid UTF-8 or hold a NUL byte. */
function textOf(bytes: Uint8Array): string | null {
	if (bytes.includes(0)) return null;
	try {
		return UTF8.decode(bytes);
	} catch {
		return null;
	}
}

/** Lines with their own endings: joining them gives the text back exactly. */
function linesOf(text: string): string[] {
	return text.length ? text.split(/(?<=\n)/) : [];
}

/** Whether `text` parses as the format its suffix names; true for a format with no parse check. */
function parses(suffix: string, text: string): boolean {
	try {
		switch (suffix) {
			case ".json":
			case ".canvas":
				JSON.parse(text);
				break;
			case ".jsonl":
				for (const line of text.split("\n")) if (line.trim()) JSON.parse(line);
				break;
			case ".yaml":
			case ".yml":
				parseYaml(text);
				break;
			case ".toml":
				parseToml(text);
				break;
		}
		return true;
	} catch {
		return false;
	}
}

const CHECKED = new Set([".json", ".canvas", ".jsonl", ".yaml", ".yml", ".toml"]);

/** Merges `ours` (the device's bytes) with `theirs` (what the tree holds) from `base` (what the device last knew; null
 *  when both sides added the path). The result is the exact bytes to write at the path, or why it collides. */
export function mergeBytes(path: string, base: Uint8Array | null, ours: Uint8Array, theirs: Uint8Array): Merge {
	const suffix = suffixOf(path);
	if (!MERGEABLE.includes(suffix)) return { kind: "conflict", why: "not_mergeable" };
	if (ours.byteLength > MERGE_MAX || theirs.byteLength > MERGE_MAX || (base?.byteLength ?? 0) > MERGE_MAX) return { kind: "conflict", why: "too_big" };
	const o = textOf(ours);
	const t = textOf(theirs);
	const b = base === null ? "" : textOf(base);
	if (o === null || t === null || b === null) return { kind: "conflict", why: "not_mergeable" };
	if (base !== null && same(ours, base)) return { kind: "unchanged" };

	// WHY the check is skipped when the inputs were already broken: the merge did not break them; a file a person is
	// mid-way through typing is not made a conflict by what a machine appended
	const enforce = CHECKED.has(suffix) && (base !== null && b.length > 0 ? parses(suffix, b) : parses(suffix, o) && parses(suffix, t));
	const settle = (kind: "tails" | "merged", text: string): Merge =>
		enforce && !parses(suffix, text) ? { kind: "conflict", why: "parse" } : { kind, bytes: encoder.encode(text) };

	// tails: both sides only appended whole lines to what the base held
	if (base !== null && (b === "" || b.endsWith("\n")) && o.startsWith(b) && t.startsWith(b)) {
		const ourTail = o.slice(b.length);
		const theirTail = t.slice(b.length);
		if (ourTail.endsWith("\n") && theirTail.endsWith("\n")) return settle("tails", t + ourTail);
	}

	const [ourLines, baseLines, theirLines] = [linesOf(o), linesOf(b), linesOf(t)];
	if (ourLines.length + baseLines.length + theirLines.length > LINES_MAX) return { kind: "conflict", why: "too_big" };
	const regions = diff3Merge(ourLines, baseLines, theirLines, { excludeFalseConflicts: true });
	if (regions.some((region) => region.conflict)) return { kind: "conflict", why: "overlap" };
	return settle("merged", regions.map((region) => region.ok!.join("")).join(""));
}

// ------------------------------------------------------------------------------------------------ conflict copies

/** The device's name as a file name that is valid on every OS: any character other than a letter, digit, space, `.`,
 *  `_` or `-` becomes `-` (PEP 0010 §6.3). */
export function deviceLabel(device: string): string {
	const label = [...device].slice(0, 40).map((ch) => (/[\p{L}\p{N} ._-]/u.test(ch) ? ch : "-")).join("");
	return label.trim() ? label : "device";
}

/** YYYYMMDDHHMM of the committer's own wall clock, from an RFC 3339 `at_local` as written (its offset is not applied:
 *  the person reads their own time), else the server's UTC time. */
function stampOf(atLocal: string | undefined, now: number): string {
	const m = atLocal && /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(atLocal);
	if (m && Number(m[2]) >= 1 && Number(m[2]) <= 12 && Number(m[3]) >= 1 && Number(m[3]) <= 31 && Number(m[4]) <= 23 && Number(m[5]) <= 59) return m.slice(1, 6).join("");
	return new Date(now).toISOString().replace(/[-:T]/g, "").slice(0, 12);
}

/** The path of the conflict copy of `path`: `name (Conflicted copy <device> <YYYYMMDDHHMM>).ext`, Obsidian's own form
 *  (PEP 0010 §6.3), in the same folder; ` 2`, ` 3` after the closing parenthesis while `taken` says the name is used. */
export function conflictName(path: string, device: string, atLocal: string | undefined, taken: (name: string) => boolean, now: number): string {
	const slash = path.lastIndexOf("/") + 1;
	const folder = path.slice(0, slash);
	const file = path.slice(slash);
	const dot = file.lastIndexOf(".");
	const [stem, ext] = dot > 0 ? [file.slice(0, dot), file.slice(dot)] : [file, ""];
	const label = `${folder}${stem} (Conflicted copy ${deviceLabel(device)} ${stampOf(atLocal, now)})`;
	let name = `${label}${ext}`;
	for (let n = 2; taken(name); n++) name = `${label} ${n}${ext}`;
	return name;
}
