import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const result = spawnSync(npmCommand, ["pack", "--dry-run", "--json", "--ignore-scripts"], {
	cwd: process.cwd(),
	encoding: "utf8",
});

if (result.error) {
	throw new Error(`Unable to inspect the npm package: ${result.error.message}`);
}
if (result.status !== 0) {
	throw new Error(`npm pack failed with exit code ${result.status}:\n${result.stderr.trim()}`);
}

let reports;
try {
	reports = JSON.parse(result.stdout);
} catch (error) {
	throw new Error(`npm pack returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
}

if (!Array.isArray(reports) || reports.length !== 1 || !Array.isArray(reports[0]?.files)) {
	throw new Error("npm pack returned an unexpected report shape.");
}

const packagedFiles = new Set(reports[0].files.map((entry) => entry.path));
const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const requiredFiles = [
	"package.json",
	"README.md",
	"dist/index.js",
	"dist/index.d.ts",
	"agents/explorer.md",
	"assets/pi-herdr-logo.png",
];
const forbiddenPrefixes = [".github/", "docs/", "scripts/", "src/", "test/"];
const missingFiles = requiredFiles.filter((file) => !packagedFiles.has(file));
const leakedFiles = [...packagedFiles].filter((file) => forbiddenPrefixes.some((prefix) => file.startsWith(prefix)));
const extensionTargets = Array.isArray(manifest.pi?.extensions) ? manifest.pi.extensions : [];
const missingExtensionTargets = extensionTargets
	.filter((target) => typeof target === "string")
	.map((target) => target.replace(/^\.\//, ""))
	.filter((target) => !packagedFiles.has(target));
const expectedEntry = "./dist/index.js";
const expectedTypes = "./dist/index.d.ts";
const manifestEntriesAreValid =
	manifest.main === expectedEntry &&
	manifest.types === expectedTypes &&
	manifest.exports?.["."]?.import === expectedEntry &&
	manifest.exports?.["."]?.types === expectedTypes;

if (
	missingFiles.length > 0 ||
	leakedFiles.length > 0 ||
	extensionTargets.length !== 1 ||
	extensionTargets[0] !== "./dist/index.js" ||
	missingExtensionTargets.length > 0 ||
	!manifestEntriesAreValid
) {
	const diagnostics = [];
	if (missingFiles.length > 0) {
		diagnostics.push(`missing required files: ${missingFiles.join(", ")}`);
	}
	if (leakedFiles.length > 0) {
		diagnostics.push(`unexpected development files: ${leakedFiles.join(", ")}`);
	}
	if (extensionTargets.length !== 1 || extensionTargets[0] !== "./dist/index.js") {
		diagnostics.push('package.json#pi.extensions must contain exactly "./dist/index.js"');
	}
	if (missingExtensionTargets.length > 0) {
		diagnostics.push(`extension targets absent from the package: ${missingExtensionTargets.join(", ")}`);
	}
	if (!manifestEntriesAreValid) {
		diagnostics.push(
			"package.json main/types/exports must point to the compiled dist/index.js and dist/index.d.ts entry",
		);
	}
	throw new Error(`Invalid npm package contents:\n- ${diagnostics.join("\n- ")}`);
}

let compiledEntry;
try {
	compiledEntry = await import(new URL(`../${manifest.main.replace(/^\.\//, "")}`, import.meta.url));
} catch (error) {
	throw new Error(
		`Unable to import the compiled package.json#main entry: ${error instanceof Error ? error.message : String(error)}`,
	);
}
if (typeof compiledEntry.default !== "function" || typeof compiledEntry.HerdrClient !== "function") {
	throw new Error("The compiled extension entry does not expose its default factory and HerdrClient API.");
}

process.stdout.write(`npm package verified (${packagedFiles.size} files).\n`);
