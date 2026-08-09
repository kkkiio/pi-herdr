import { After, setDefaultTimeout } from "@cucumber/cucumber";

import { PiHerdrWorld } from "./world.js";

setDefaultTimeout(30_000);

After(async function (this: PiHerdrWorld) {
	await this.cleanup();
});
