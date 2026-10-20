// Run by the Go end-to-end test: list and read a project through the Worker reader,
// over the stand-in bucket. Prints one JSON object on stdout.
//   FOLDER_SYNC_ENDPOINT=… FOLDER_SYNC_ACCESS_KEY_ID=… FOLDER_SYNC_SECRET_ACCESS_KEY=… \
//   node readers/worker/test/e2e.ts <bucket> <project>
import { Project } from "../src/folder-sync-read.ts";
import { S3Bucket } from "./s3-bucket.ts";

const [bucketName, projectName] = process.argv.slice(2);
const bucket = new S3Bucket(
	process.env.FOLDER_SYNC_ENDPOINT ?? "",
	bucketName,
	process.env.FOLDER_SYNC_ACCESS_KEY_ID ?? "",
	process.env.FOLDER_SYNC_SECRET_ACCESS_KEY ?? "",
	process.env.FOLDER_SYNC_REGION ?? "auto",
);
const project = new Project(bucket, projectName);
const files = await project.files();
const contents: Record<string, string> = {};
for (const file of files) {
	contents[`${file.hostId}/${file.path}`] = new TextDecoder().decode(await project.read(file.hostId, file.path));
}
bucket.calls.length = 0;
await project.files(); // a second listing: conditional GETs only
console.log(JSON.stringify({ files, contents, secondListingCalls: bucket.calls }));
