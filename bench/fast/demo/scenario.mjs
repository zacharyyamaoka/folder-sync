// The hero recorder's scripted writes and their clocks (bench/fast/demo/hero.mjs), in a worker thread of their own so
// the page server, the directory scans and the screenshots never sit on the event loop that times a write.
//
// Every readout is measured the way bench/fast/fs_bench.mjs measures its trials (CONTRACT.md): the clock starts just
// before the write (a write-then-rename on A, or the PUT through /fs/ for the web) and stops when the reader's disk
// holds the same sha256, polled every 10 ms. It posts {type:"wrote"} as each write starts, {type:"arrived"} as each
// one is measured, and {type:"finished"} when every one is measured or timed out.

import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parentPort, workerData } from "node:worker_threads";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => performance.timeOrigin + performance.now();
const sha256 = (b) => createHash("sha256").update(b).digest("hex");
// fs_bench.mjs's TIMEOUT_MS for these workloads
const TIMEOUT_MS = { "1k": 60_000, many100: 120_000 };

/** fs_bench.mjs's content() for its 1 KB JSON workloads. */
function content(tag, size = 1024) {
	const head = JSON.stringify({ tag, t: new Date().toISOString(), pad: "" });
	const pad = randomBytes(size).toString("hex").slice(0, size - head.length);
	return Buffer.from(JSON.stringify({ tag, t: new Date().toISOString(), pad }));
}

function want(rel, bytes) {
	return { rel, bytes, sha: sha256(bytes) };
}

/** fs_bench.mjs's writeLocal(): an editor's save, write-then-rename (the watcher ignores the `~` temp name). */
function writeLocal(folder, rel, bytes) {
	const target = join(folder, rel);
	mkdirSync(dirname(target), { recursive: true });
	writeFileSync(`${target}.tmp~`, bytes);
	renameSync(`${target}.tmp~`, target);
}

/** fs_bench.mjs's diskReader(): does path hold want? Hashes only when the size matches and the file changed. */
function diskReader() {
	const seen = new Map();
	return (path, w) => {
		let st;
		try { st = statSync(path); } catch { return false; }
		if (st.size !== w.bytes.length) return false;
		const key = `${st.ino}:${st.mtimeMs}:${st.size}`;
		const cached = seen.get(path);
		if (cached && cached.key === key && cached.sha === w.sha) return cached.ok;
		let ok = false;
		try { ok = sha256(readFileSync(path)) === w.sha; } catch { ok = false; }
		seen.set(path, { key, sha: w.sha, ok });
		return ok;
	};
}

/** fs_bench.mjs's pollAll(): {first, last, held} in ms after t0 (null when never). */
async function pollAll(n, check, t0, timeoutMs, period) {
	const held = new Array(n).fill(null);
	let pending = [...Array(n).keys()];
	const deadline = t0 + timeoutMs;
	while (pending.length && now() < deadline) {
		const started = now();
		const still = [];
		for (const i of pending) {
			if (await check(i)) held[i] = now() - t0;
			else still.push(i);
		}
		pending = still;
		if (pending.length) await sleep(Math.max(0, period - (now() - started)));
	}
	const times = held.filter((x) => x !== null);
	return { first: times.length ? Math.min(...times) : null, last: pending.length ? null : Math.max(...times), held };
}

/** fs_bench.mjs's Online.put(): PUT /fs/v1/folders/<p>/web/<path> with the web machine's bearer. */
async function put(rel, body) {
	const { webBase, project, token } = workerData;
	const answer = await fetch(`${webBase}/fs/v1/folders/${project}/web/${rel}`, { method: "PUT", body, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/octet-stream" } });
	const text = await answer.text();
	if (answer.status !== 200) throw new Error(`PUT web/${rel}: ${answer.status} ${text.slice(0, 200)}`);
	return JSON.parse(text);
}

async function step(s, disk) {
	const { aFolder, bFolder, aId, webHost } = workerData;
	const files = s.kind === "burst"
		? [...Array(100).keys()].map((i) => want(`${s.dir}/f${String(i).padStart(3, "0")}.json`, content(`${s.id}-${i}`)))
		: [want(s.rel, content(s.id))];
	let t0;
	let putMs = null;
	let reader;
	try {
		if (s.kind === "web") {
			t0 = now();
			parentPort.postMessage({ type: "wrote", id: s.id, t_write: t0 });
			await put(files[0].rel, files[0].bytes);
			putMs = now() - t0;
			reader = (i) => disk(join(aFolder, "hosts", webHost, files[i].rel), files[i]);
		} else {
			t0 = now();
			parentPort.postMessage({ type: "wrote", id: s.id, t_write: t0 });
			for (const f of files) writeLocal(aFolder, f.rel, f.bytes);
			reader = (i) => disk(join(bFolder, "hosts", aId, files[i].rel), files[i]);
		}
	} catch (error) {
		parentPort.postMessage({ type: "arrived", id: s.id, status: "error", note: String(error.message || error).slice(0, 300) });
		return;
	}
	const result = await pollAll(files.length, reader, t0, TIMEOUT_MS[s.kind === "burst" ? "many100" : "1k"], 10);
	parentPort.postMessage({
		type: "arrived", id: s.id, status: result.last === null ? "timeout" : "ok", ms: result.last, first_ms: s.kind === "burst" ? result.first : null,
		put_ms: putMs, lost: result.held.filter((x) => x === null).length, bytes: files.reduce((n, f) => n + f.bytes.length, 0),
	});
}

parentPort.once("message", async ({ tStart }) => {
	const disk = diskReader();
	const running = [];
	for (const s of workerData.steps) {
		await sleep(Math.max(0, tStart + s.at_ms - now()));
		running.push(step(s, disk));
	}
	await Promise.all(running);
	parentPort.postMessage({ type: "finished" });
});
