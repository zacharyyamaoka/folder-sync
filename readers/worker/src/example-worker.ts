// A minimal Worker that serves a folder-sync project read-only through its R2 binding:
//   GET /<project>/files                  → JSON list of every host's files
//   GET /<project>/file/<host-id>/<path>  → the file's bytes
// Put it behind Cloudflare Access like the viewer; it is an example, not a product.
import { ContractError, Project, type R2BucketLike } from "./folder-sync-read.ts";

interface Env {
	BUCKET: R2BucketLike;
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		const [project, verb, hostId, ...rest] = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
		if (!project || !verb) return new Response("GET /<project>/files or /<project>/file/<host-id>/<path>\n", { status: 404 });
		const reader = new Project(env.BUCKET, project);
		try {
			if (verb === "files") return Response.json(await reader.files());
			if (verb === "file" && hostId && rest.length) {
				return new Response(await reader.read(hostId, rest.join("/")));
			}
		} catch (error) {
			if (error instanceof ContractError) return new Response(error.message + "\n", { status: 404 });
			throw error;
		}
		return new Response("not found\n", { status: 404 });
	},
};
