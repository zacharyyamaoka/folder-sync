// Every shared fixture in testdata/ validates against its schema in schema/ (PEP 0007's frozen contract).
//
//   node --test schema/fixtures.test.mjs
//
// The build lanes load these fixtures in their own tests (the engine and serve in Go, the Worker and the view in
// TypeScript); this test keeps the fixtures and the schemas in step, so a lane never tests against a broken ruler.
// No dependency: a strict validator for the subset of JSON Schema 2020-12 the schemas use. WHY strict: any keyword it
// does not know throws, so a schema can never use a keyword this test silently ignores.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..");
const testdata = join(repo, "testdata");

const schemas = new Map();
function schemaFile(name) {
	if (!schemas.has(name)) schemas.set(name, JSON.parse(readFileSync(join(here, name), "utf8")));
	return schemas.get(name);
}

const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const ANNOTATIONS = new Set(["$schema", "$id", "$comment", "$defs", "title", "description", "examples"]);
const KEYWORDS = new Set([
	"$ref", "type", "const", "enum", "pattern", "minLength", "maxLength", "format", "minimum", "maximum", "required",
	"properties", "additionalProperties", "items", "minItems", "maxItems", "uniqueItems", "allOf", "anyOf", "oneOf", "not",
	"if", "then", "else",
]);

function typeOf(v) {
	if (v === null) return "null";
	if (Array.isArray(v)) return "array";
	if (typeof v === "number") return Number.isInteger(v) ? "integer" : "number";
	return typeof v;
}

function resolve(ref, file) {
	const [target, pointer = ""] = ref.split("#");
	const name = target || file;
	let node = schemaFile(name);
	for (const part of pointer.split("/").filter(Boolean)) {
		node = node?.[part.replace(/~1/g, "/").replace(/~0/g, "~")];
		if (node === undefined) throw new Error(`unresolvable $ref ${ref} in ${file}`);
	}
	return { node, file: name };
}

/** The errors of `value` against `schema` (a node of `file`), each "<json path>: <reason>"; [] when it is valid. */
function check(value, schema, file, at = "$") {
	if (schema === true) return [];
	if (schema === false) return [`${at}: no value is allowed here`];
	for (const key of Object.keys(schema)) {
		if (!KEYWORDS.has(key) && !ANNOTATIONS.has(key)) throw new Error(`${file}: keyword ${key} is not supported by this test`);
	}
	const errors = [];
	const t = typeOf(value);
	if (schema.$ref) {
		const { node, file: f } = resolve(schema.$ref, file);
		errors.push(...check(value, node, f, at));
	}
	if (schema.type) {
		const types = [schema.type].flat();
		if (!types.some((want) => want === t || (want === "number" && t === "integer"))) errors.push(`${at}: is ${t}, want ${types.join("|")}`);
	}
	if ("const" in schema && JSON.stringify(value) !== JSON.stringify(schema.const)) errors.push(`${at}: is not ${JSON.stringify(schema.const)}`);
	if (schema.enum && !schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))) errors.push(`${at}: ${JSON.stringify(value)} is not one of ${JSON.stringify(schema.enum)}`);
	if (t === "string") {
		if (schema.pattern && !new RegExp(schema.pattern, "u").test(value)) errors.push(`${at}: ${JSON.stringify(value)} does not match ${schema.pattern}`);
		const length = [...value].length;
		if (schema.minLength !== undefined && length < schema.minLength) errors.push(`${at}: shorter than ${schema.minLength}`);
		if (schema.maxLength !== undefined && length > schema.maxLength) errors.push(`${at}: longer than ${schema.maxLength}`);
		if (schema.format === "date-time" && !(DATE_TIME.test(value) && !Number.isNaN(Date.parse(value)))) errors.push(`${at}: ${JSON.stringify(value)} is not an RFC 3339 date-time`);
		if (schema.format && schema.format !== "date-time") throw new Error(`${file}: format ${schema.format} is not supported by this test`);
	}
	if (t === "integer" || t === "number") {
		if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${at}: below ${schema.minimum}`);
		if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${at}: above ${schema.maximum}`);
	}
	if (t === "object") {
		for (const key of schema.required ?? []) if (!(key in value)) errors.push(`${at}: ${key} is required`);
		const props = schema.properties ?? {};
		for (const [key, v] of Object.entries(value)) {
			if (key in props) errors.push(...check(v, props[key], file, `${at}.${key}`));
			else if (schema.additionalProperties !== undefined) errors.push(...check(v, schema.additionalProperties, file, `${at}.${key}`));
		}
	}
	if (t === "array") {
		if (schema.items !== undefined) value.forEach((v, i) => errors.push(...check(v, schema.items, file, `${at}[${i}]`)));
		if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${at}: fewer than ${schema.minItems} items`);
		if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${at}: more than ${schema.maxItems} items`);
		if (schema.uniqueItems && new Set(value.map((v) => JSON.stringify(v))).size !== value.length) errors.push(`${at}: items are not unique`);
	}
	for (const sub of schema.allOf ?? []) errors.push(...check(value, sub, file, at));
	if (schema.anyOf && !schema.anyOf.some((sub) => check(value, sub, file, at).length === 0)) errors.push(`${at}: matches none of anyOf`);
	if (schema.oneOf) {
		const n = schema.oneOf.filter((sub) => check(value, sub, file, at).length === 0).length;
		if (n !== 1) errors.push(`${at}: matches ${n} of oneOf, want exactly 1`);
	}
	if (schema.not && check(value, schema.not, file, at).length === 0) errors.push(`${at}: matches a schema it must not`);
	if (schema.if !== undefined) {
		const branch = check(value, schema.if, file, at).length === 0 ? schema.then : schema.else;
		if (branch !== undefined) errors.push(...check(value, branch, file, at));
	}
	return errors;
}

function valid(value, ref) {
	const { node, file } = resolve(ref, ref.split("#")[0]);
	return check(value, node, file);
}

function files(dir) {
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		return statSync(path).isDirectory() ? files(path) : [path];
	});
}

const json = (path) => JSON.parse(readFileSync(path, "utf8"));
const lines = (path) => readFileSync(path, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
const toMillis = (written_at) => written_at.replace(/^(.{19})(\.\d{1,3})?\d*Z$/, (_, s, ms) => `${s}${(ms ?? ".").padEnd(4, "0")}Z`);

/** was.kept, when set, is the version id of the bytes that left: <written_at to the ms>_<sha256's first 16>. */
function keptNames(event, where) {
	const out = [];
	if (event.was?.kept && !event.was.kept.endsWith("_unlisted")) {
		const want = `${toMillis(event.was.written_at)}_${event.was.sha256.slice(0, 16)}`;
		if (event.was.kept !== want) out.push(`${where}: was.kept ${event.was.kept}, want ${want}`);
	}
	if (event.event === "restore" && !event.error && event.from && !event.from.endsWith("_unlisted")) {
		if (event.from.slice(-16) !== event.sha256.slice(0, 16)) out.push(`${where}: restored bytes ${event.sha256.slice(0, 16)}… are not version ${event.from}`);
	}
	return out;
}

/** A download's down_ms, where its peer's record is a fixture, is exactly event.at - that record's at. */
function downTime(ev) {
	const peer = ev.peer_seq && records.get(`${ev.peer}/${ev.peer_seq}`);
	if (!peer || ev.down_ms === Date.parse(ev.at) - Date.parse(peer.at)) return [];
	return [`down_ms ${ev.down_ms}, want ${Date.parse(ev.at) - Date.parse(peer.at)}`];
}

// Which schema each fixture file answers to. A file under testdata/ that no rule claims fails the test.
const rules = [
	{ dir: "events", ext: ".jsonl", run: (path) => lines(path).flatMap((ev, i) => [...valid(ev, "event.schema.json"), ...keptNames(ev, `line ${i + 1}`), ...downTime(ev)].map((e) => `line ${i + 1}: ${e}`)) },
	{
		dir: "changes",
		ext: ".json",
		run: (path) => {
			const doc = json(path);
			const errors = valid(doc, "changes.schema.json");
			const seq = path.match(/(\d{12})\.json$/);
			if (!seq || Number(seq[1]) !== doc.seq) errors.push(`the file name must end in the record's seq as 12 digits (${doc.seq})`);
			for (const [i, ev] of (doc.events ?? []).entries()) {
				const where = `events[${i}]`;
				if (ev.project !== doc.project || ev.host !== doc.host_id || ev.host_name !== doc.host_name) errors.push(`${where}: project, host and host_name must be the record's`);
				if (ev.error) errors.push(`${where}: a failed restore published nothing, so it is in no change record`);
				errors.push(...keptNames(ev, where));
			}
			const paths = (doc.events ?? []).map((e) => e.path);
			if (JSON.stringify(paths) !== JSON.stringify([...paths].sort())) errors.push("events must be in path order");
			return errors;
		},
	},
	{
		dir: "pulls",
		ext: ".json",
		run: (path) => {
			const doc = json(path);
			const errors = valid(doc, "pulls.schema.json");
			if (!path.endsWith(`${doc.at}.json`)) errors.push(`the file name must end in the record's at (${doc.at}.json)`);
			const order = (doc.events ?? []).map((e) => `${e.peer}/${e.path}`);
			if (JSON.stringify(order) !== JSON.stringify([...order].sort())) errors.push("events must be in (peer, path) order");
			for (const [i, ev] of (doc.events ?? []).entries()) {
				if (ev.project !== doc.project || ev.host !== doc.host_id || ev.host_name !== doc.host_name) errors.push(`events[${i}]: project, host and host_name must be the record's`);
				errors.push(...downTime(ev).map((e) => `events[${i}]: ${e}`));
			}
			return errors;
		},
	},
	{
		dir: "requests",
		ext: ".json",
		run: (path) => {
			const doc = json(path);
			const errors = valid(doc, "restore.schema.json");
			const results = doc.outcome?.results ?? [];
			if (doc.outcome && (results.length !== doc.items.length || results.some((r, i) => r.path !== doc.items[i].path || r.version !== doc.items[i].version)))
				errors.push("outcome.results must be one per item, in item order");
			if (doc.outcome?.seq !== undefined && !results.some((r) => r.ok)) errors.push("outcome.seq is set only when something was published");
			return errors;
		},
	},
	{
		dir: "history",
		ext: ".json",
		run: (path) => {
			const doc = json(path);
			const errors = [];
			if (doc.fixture !== "folder-sync-history-keys/1") errors.push("fixture must be folder-sync-history-keys/1");
			for (const [i, v] of (doc.valid ?? []).entries()) {
				errors.push(...valid(v, "history.schema.json").map((e) => `valid[${i}]: ${e}`));
				const key = `${v.root}_history/${v.project}/${v.host}/${v.path}/${v.version}`;
				if (v.key !== key) errors.push(`valid[${i}]: key must be ${key}`);
				if (!v.unlisted && v.version !== `${v.written_at}_${v.sha16}`) errors.push(`valid[${i}]: version must be <written_at>_<sha16>`);
				if (v.unlisted && v.version !== v.version.replace(/_.*$/, "_unlisted")) errors.push(`valid[${i}]: an unlisted version ends _unlisted`);
			}
			for (const id of doc.invalid_version_ids ?? []) if (valid(id, "history.schema.json#/$defs/version_id").length === 0) errors.push(`invalid_version_ids: ${id} is accepted`);
			for (const key of doc.invalid_keys ?? []) if (valid(key, "history.schema.json#/properties/key").length === 0) errors.push(`invalid_keys: ${key} is accepted`);
			if (!doc.valid?.length || !doc.invalid_version_ids?.length || !doc.invalid_keys?.length) errors.push("valid, invalid_version_ids and invalid_keys must each be non-empty");
			return errors;
		},
	},
	{
		dir: "view-api",
		ext: ".json",
		run: (path) => {
			const doc = json(path);
			const errors = valid(doc, "view-api.schema.json");
			if (errors.length) return errors;
			errors.push(...valid(doc.response.body, `view-api.schema.json#/$defs/${doc.body_schema}`).map((e) => `response.body: ${e}`));
			const ok = doc.response.status < 300;
			if (ok === (doc.body_schema === "error")) errors.push(`status ${doc.response.status} with body_schema ${doc.body_schema}`);
			if ("body" in doc.request !== "request_schema" in doc) errors.push("a request body needs request_schema, and only then");
			if (doc.request_schema) errors.push(...valid(doc.request.body, `view-api.schema.json#/$defs/${doc.request_schema}`).map((e) => `request.body: ${e}`));
			if (doc.request.auth === "bad_host" && JSON.stringify(doc.servers) !== '["serve"]') errors.push("bad_host is serve's Host check only");
			if (["reader", "public"].includes(doc.request.auth) && doc.servers.includes("serve")) errors.push("serve has no readers: its only caller holds the token");
			return errors;
		},
	},
	{ dir: "retention", ext: ".json", run: (path) => valid(json(path), "retention.schema.json") },
	{ dir: "serve", ext: ".json", run: (path) => valid(json(path), "view-api.schema.json#/$defs/serve_json") },
];

const all = files(testdata).map((path) => relative(testdata, path));
// Every change record fixture by "<host>/<seq>", for the cross-checks.
const records = new Map(all.filter((rel) => rel.startsWith("changes/")).map((rel) => json(join(testdata, rel))).map((r) => [`${r.host_id}/${r.seq}`, r]));

test("every file under testdata/ has a schema", () => {
	const unclaimed = all.filter((rel) => !rules.some((r) => rel.startsWith(`${r.dir}/`) && rel.endsWith(r.ext)));
	assert.deepEqual(unclaimed, []);
});

for (const rule of rules) {
	const mine = all.filter((rel) => rel.startsWith(`${rule.dir}/`) && rel.endsWith(rule.ext));
	test(`testdata/${rule.dir} is not empty`, () => assert.ok(mine.length > 0));
	for (const rel of mine) {
		test(`testdata/${rel}`, () => assert.deepEqual(rule.run(join(testdata, rel)), []));
	}
}

test("the view fixtures cover every route and every server", () => {
	const fixtures = all.filter((rel) => rel.startsWith("view-api/")).map((rel) => json(join(testdata, rel)));
	for (const schema of ["status", "activity", "history", "deleted", "restore_response", "purge_response", "usage", "folders", "error"]) {
		assert.ok(fixtures.some((f) => f.body_schema === schema), `no fixture answers ${schema}`);
	}
	for (const server of ["worker", "serve"]) assert.ok(fixtures.some((f) => f.servers.includes(server)), `no fixture for ${server}`);
});

test("the validator itself fails what it must", () => {
	// A broken ruler passes everything: prove a few failures before trusting the passes above.
	assert.notDeepEqual(valid({ schema: "folder-sync-event/1", event: "upload", at: "2026-10-28T20:41:00Z" }, "event.schema.json"), []);
	assert.notDeepEqual(valid({ schema: "folder-sync-event/2", event: "round", at: "2026-10-28T20:41:00Z" }, "event.schema.json"), []);
	assert.notDeepEqual(valid({ schema: "folder-sync-event/1", event: "round", at: "yesterday" }, "event.schema.json"), []);
	assert.notDeepEqual(valid({ schema: "folder-sync-event/1", event: "upload", at: "2026-10-28T20:41:00Z", path: "a", size: 1, sha256: "0".repeat(64), op: "add", up_ms: -1 }, "event.schema.json"), []);
	assert.notDeepEqual(valid({ older_than_days: 7, version: "2026-10-28T20:31:00.117Z_9f2c1a3b4c5d6e7f" }, "view-api.schema.json#/$defs/purge_request"), []);
	assert.throws(() => check(1, { minProperties: 1 }, "test"), /not supported/);
});
