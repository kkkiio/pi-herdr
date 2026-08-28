import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const work = mkdtempSync(join(tmpdir(), "pi-herdr-verify-"));

function run(args, cwd) {
	const result = spawnSync(npmCommand, args, { cwd, encoding: "utf8" });
	if (result.error) throw new Error(`Unable to run npm: ${result.error.message}`);
	if (result.status !== 0) {
		throw new Error(`npm ${args.join(" ")} failed with exit code ${result.status}:\n${result.stderr.trim()}`);
	}
	return result.stdout;
}

try {
	// Pack for real, then install the tarball into a clean project the way pi
	// installs distributed packages: production dependencies only.
	const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
	const packReport = JSON.parse(run(["pack", "--json", "--ignore-scripts", "--pack-destination", work], process.cwd()));
	const tarball = Array.isArray(packReport) ? packReport[0]?.filename : undefined;
	if (typeof tarball !== "string") throw new Error("npm pack returned an unexpected report shape.");

	const sandbox = join(work, "sandbox");
	mkdirSync(sandbox, { recursive: true });
	writeFileSync(join(sandbox, "package.json"), '{"name":"verify-sandbox","private":true}\n', "utf8");
	run(["install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", join(work, tarball)], sandbox);

	const installedEntry = join(sandbox, "node_modules", manifest.name, "dist", "index.js");
	const entry = await import(pathToFileURL(installedEntry).href);
	if (typeof entry.default !== "function" || typeof entry.HerdrClient !== "function") {
		throw new Error("The installed extension entry does not expose its default factory and HerdrClient API.");
	}

	process.stdout.write("npm package install smoke verified.\n");
} finally {
	rmSync(work, { recursive: true, force: true });
}
