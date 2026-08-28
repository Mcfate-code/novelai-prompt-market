// Regression gate: parse the browser ES modules as strict ESM.
//
// `node --check` on a `.js` file (no "type":"module" in package.json) does NOT
// catch top-level orphan fragments like a trailing `} else if (...) {...}`
// after `export default ...`. Use vm.SourceTextModule so every listed file is
// parsed as true ES module syntax; a SyntaxError aborts with exit code 1.
//
// Usage: node --experimental-vm-modules scripts/check_js_syntax.mjs [files...]

import { readFile } from "node:fs/promises";
import { SourceTextModule } from "node:vm";

const DEFAULTS = [
  "static/nsfw-builder.js",
  "static/visual-builder.js",
  "static/tag-assistant.js",
  "static/prompt-document.js",
  "static/prompt-tokenizer.js",
  "static/pose-variation.js",
  "static/app.js",
];

const files = process.argv.slice(2).length > 0 ? process.argv.slice(2) : DEFAULTS;

let failed = 0;
for (const file of files) {
  try {
    const source = await readFile(file, "utf8");
    new SourceTextModule(source);
    console.log(`PASS ${file}`);
  } catch (err) {
    failed += 1;
    console.error(`FAIL ${file}: ${err.constructor.name}: ${err.message}`);
  }
}

if (failed > 0) {
  console.error(`\n${failed} file(s) failed ES module syntax check.`);
  process.exit(1);
}
console.log("\nAll browser ES modules parse as strict ESM.");
