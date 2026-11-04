// competitors.json against its schema, and its two derived numbers recomputed (node --test bench/).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const competitors = JSON.parse(readFileSync(join(HERE, "competitors.json"), "utf8"));
const schema = JSON.parse(readFileSync(join(HERE, "competitors.schema.json"), "utf8"));

// WHY a small walker and not a validator library: bench/ has no package.json, and this file must run under plain `node --test`
// like model.test.mjs. It reads the schema file itself, so the schema stays the one ruler; it knows only the keywords
// competitors.schema.json uses and fails on any other, so a keyword added there cannot be silently skipped.
const KNOWN = new Set(["$schema", "$id", "title", "description", "type", "required", "additionalProperties", "properties", "items", "minItems",
	"const", "enum", "pattern", "minLength", "minimum", "exclusiveMinimum"]);

function schemaErrors(node, value, at = "$") {
	const errors = [];
	for (const keyword of Object.keys(node)) if (!KNOWN.has(keyword)) throw new Error(`${at}: schema keyword ${keyword} is not checked by this test`);
	const kind = Array.isArray(value) ? "array" : value === null ? "null" : typeof value;
	if (node.type && node.type !== kind) return [`${at}: want ${node.type}, got ${kind}`];
	if ("const" in node && value !== node.const) errors.push(`${at}: want ${JSON.stringify(node.const)}`);
	if (node.enum && !node.enum.includes(value)) errors.push(`${at}: ${JSON.stringify(value)} not in ${node.enum.join("|")}`);
	if (kind === "string") {
		if (node.minLength !== undefined && value.length < node.minLength) errors.push(`${at}: shorter than ${node.minLength}`);
		if (node.pattern && !new RegExp(node.pattern).test(value)) errors.push(`${at}: does not match ${node.pattern}`);
	}
	if (kind === "number") {
		if (!Number.isFinite(value)) errors.push(`${at}: not finite`);
		if (node.minimum !== undefined && value < node.minimum) errors.push(`${at}: below ${node.minimum}`);
		if (node.exclusiveMinimum !== undefined && value <= node.exclusiveMinimum) errors.push(`${at}: not above ${node.exclusiveMinimum}`);
	}
	if (kind === "object") {
		for (const key of node.required ?? []) if (!(key in value)) errors.push(`${at}: missing ${key}`);
		for (const [key, child] of Object.entries(value)) {
			if (node.properties?.[key]) errors.push(...schemaErrors(node.properties[key], child, `${at}.${key}`));
			else if (node.additionalProperties === false) errors.push(`${at}: unexpected ${key}`);
		}
	}
	if (kind === "array") {
		if (node.minItems !== undefined && value.length < node.minItems) errors.push(`${at}: fewer than ${node.minItems} items`);
		if (node.items) value.forEach((item, index) => errors.push(...schemaErrors(node.items, item, `${at}[${index}]`)));
	}
	return errors;
}

/** The documented rule for per_person_month_10gb_usd: the vendor's cheapest plan holding 10 GB, same cadence, free counts at either. */
function cheapestHolding10gb(item, items) {
	const holds = items.filter((other) => other.vendor === item.vendor && other.storage_gb >= 10 && (other.billing === item.billing || other.price_usd_month === 0));
	return holds.length ? Math.min(...holds.map((other) => other.price_usd_month)) : null;
}

test("competitors.json matches competitors.schema.json", () => {
	assert.deepEqual(schemaErrors(schema, competitors), []);
});

test("the schema check can fail: an extra field, a missing field and a bad cadence are each caught", () => {
	const first = competitors.items[0];
	const { notes: _dropped, ...withoutNotes } = first;
	for (const broken of [{ ...first, discount: 1 }, withoutNotes, { ...first, billing: "weekly" }]) {
		assert.notDeepEqual(schemaErrors(schema, { ...competitors, items: [broken] }), []);
	}
	assert.throws(() => schemaErrors({ maxItems: 1 }, []), /not checked/);
});

test("per_gb_month_usd = price_usd_month / storage_gb", () => {
	for (const item of competitors.items) {
		const want = item.price_usd_month / item.storage_gb;
		assert.ok(Math.abs(item.per_gb_month_usd - want) < 1e-6, `${item.name} (${item.billing}): ${item.per_gb_month_usd} != ${want}`);
	}
});

test("per_person_month_10gb_usd is the cheapest whole plan that holds 10 GB, not a pro-rated share", () => {
	for (const item of competitors.items) {
		const want = cheapestHolding10gb(item, competitors.items);
		assert.notEqual(want, null, `${item.vendor} has no plan that holds 10 GB`);
		assert.equal(item.per_person_month_10gb_usd, want, `${item.name} (${item.billing})`);
	}
	const obsidianStandard = competitors.items.find((item) => item.name === "Obsidian Sync Standard" && item.billing === "annual");
	assert.equal(obsidianStandard.per_person_month_10gb_usd, 8, "1 GB Standard cannot hold 10 GB: a person pays for Plus");
});

test("one item per plan and cadence, every price read on as_of, and the plans Zach named are present", () => {
	const keys = competitors.items.map((item) => `${item.name}|${item.billing}`);
	assert.equal(new Set(keys).size, keys.length);
	for (const item of competitors.items) assert.equal(item.accessed, competitors.as_of, item.name);
	for (const name of ["Dropbox Plus", "Dropbox Standard", "Google One Basic 100 GB", "Google One 2 TB", "Obsidian Sync Standard", "Obsidian Sync Plus", "iCloud+ 50 GB", "iCloud+ 200 GB"]) {
		assert.ok(competitors.items.some((item) => item.name === name), `${name} missing`);
	}
	assert.ok(competitors.items.some((item) => item.vendor === "Microsoft"), "OneDrive missing");
});
