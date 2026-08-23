import { globSync } from "node:fs";
const featureFiles = globSync("test/bdd/features/**/*.feature").sort();
if (featureFiles.length === 0) {
	throw new Error("No BDD feature files were found under test/bdd/features.");
}

export default {
	paths: featureFiles,
	import: ["test/bdd/support/**/*.ts", "test/bdd/steps/**/*.ts"],
	format: ["progress"],
	order: "defined",
	parallel: 0,
	strict: true,
	// Real Herdr scenarios run only under HERDR_E2E=1 (npm run test:e2e).
	tags: process.env.HERDR_E2E === "1" ? "@herdr-e2e" : "not @herdr-e2e",
};
