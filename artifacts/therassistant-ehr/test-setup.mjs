// Registers the CSS-stub loader used by `pnpm test`. Imported via
// `node --import ./test-setup.mjs` so it runs before any test module.
import { register } from "node:module";
import { pathToFileURL } from "node:url";

register("./test-css-loader.mjs", pathToFileURL("./").href);
