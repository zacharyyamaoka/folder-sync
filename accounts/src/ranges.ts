// HTTP Range for a folder's files (PEP 0003 §3.3, RFC 9110 §14): what lets a <video src> on an app's own origin play
// and seek, and a long .log be read from its end.
//
// - One range (bytes=a-b, a-, -n) answers 206 with Content-Range, reading only those bytes from storage (a ranged GET
//   through the folder's read-only credential, streamed through, never the whole object in memory).
// - A range past the end answers 416 with Content-Range: bytes */<size>.
// - Several ranges, or one this does not parse, answer 200 with the whole body (RFC 9110 lets a server ignore Range).
// - If-Range names the ETag the client holds: still current, the range; anything else (another ETag, a weak one, a
//   date: these files have no Last-Modified), the whole body.
// - HEAD with a range answers the 206's headers and reads no file bytes.
//
// WHY a range is checked by size, not sha256: a whole file is checked against its manifest's sha256 (the reader), but a
// range cannot be without reading all of it, which is what a range is for avoiding. A stored object whose size is not
// the manifest's is another version (a machine's upload in flight): 404, as a whole read that keeps changing is.

import { fail, headers } from "./app.ts";
import type { Project, ManifestEntry } from "../../readers/worker/src/folder-sync-read.ts";
import { S3Bucket } from "./s3-bucket.ts";

export type Wanted = { kind: "all" } | { kind: "one"; start: number; end: number } | { kind: "unsatisfiable" };

/** The one range `header` asks of `size` bytes, or "all" when the whole body is the answer. */
export function wanted(header: string | null, size: number): Wanted {
	if (header === null) return { kind: "all" };
	const asked = /^\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*$/i.exec(header);
	// several ranges (a comma), another unit, or nonsense: the whole body, 200
	if (!asked || (asked[1] === "" && asked[2] === "")) return { kind: "all" };
	if (asked[1] === "") {
		const suffix = Number(asked[2]);
		if (!Number.isSafeInteger(suffix)) return { kind: "all" };
		if (suffix === 0 || size === 0) return { kind: "unsatisfiable" };
		return { kind: "one", start: Math.max(0, size - suffix), end: size - 1 };
	}
	const start = Number(asked[1]);
	const end = asked[2] === "" ? size - 1 : Number(asked[2]);
	if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return { kind: "all" };
	if (start >= size) return { kind: "unsatisfiable" };
	if (end < start) return { kind: "all" }; // bytes=5-2 is invalid, so ignored
	return { kind: "one", start, end: Math.min(end, size - 1) };
}

/** The ranged answer for `entry`, or null when the whole file is the answer (no Range, several, or If-Range stale).
 *  `base` holds the file's Content-Type, ETag, Cache-Control (and CSP); `head`: no body, and no file bytes read. */
export async function rangedFile(request: Request, reader: Project, host: string, entry: ManifestEntry, base: Record<string, string>, head: boolean): Promise<Response | null> {
	const ifRange = request.headers.get("If-Range");
	// WHY strong comparison only (RFC 9110 §13.1.5): a weak validator, or a date, never proves the bytes are the same
	if (ifRange !== null && ifRange.trim() !== base.ETag) return null;
	const range = wanted(request.headers.get("Range"), entry.size);
	if (range.kind === "all") return null;
	// the error is JSON, so the file's own Content-Type (and CSP) stay off it
	if (range.kind === "unsatisfiable") return fail(416, "range", `this file is ${entry.size} bytes`, { ETag: base.ETag, "Cache-Control": base["Cache-Control"], "Accept-Ranges": "bytes", "Content-Range": `bytes */${entry.size}` });
	const length = range.end - range.start + 1;
	const ranged = { ...base, "Content-Range": `bytes ${range.start}-${range.end}/${entry.size}`, "Content-Length": String(length) };
	if (head) return new Response(null, { status: 206, headers: headers(ranged) });
	const key = `${reader.root}${reader.project}/hosts/${host}/${entry.path}`;
	let body: ReadableStream<Uint8Array> | ArrayBuffer;
	if (reader.bucket instanceof S3Bucket) {
		const object = await reader.bucket.getRange(key, range.start, length);
		if (!object || object.size !== entry.size) {
			await object?.body?.cancel();
			return fail(404, "not_found", "that file changed or went away while it was read");
		}
		body = object.body ?? new ArrayBuffer(0);
	} else {
		// a reader without ranged reads (none in this Worker): the whole file, sha256-checked, then the slice
		const data = await reader.read(host, entry.path);
		body = data.slice(range.start, range.end + 1);
	}
	return new Response(body, { status: 206, headers: headers(ranged) });
}
