// Builds dist/mock.html: the production single-file UI with the Web Serial mock
// injected ahead of its bundle, so the workbench can be smoke-tested in a browser
// without owning a physical port. Run `npm run build` first — this reads its output.
import { readFileSync, writeFileSync } from "node:fs";

const html = readFileSync("dist/index.html", "utf8");
const mock = readFileSync("tools/mock_serial.js", "utf8");
const at = html.indexOf("<script>("); // the minified bundle; the mock must install first
if (at < 0) throw new Error("dist/index.html has no bundle script — run npm run build");
const out =
  html.slice(0, at) + "<script>" + mock + "</script>\n  " + html.slice(at);
writeFileSync("dist/mock.html", out);
console.log(`dist/mock.html ${(out.length / 1024).toFixed(1)} KB`);
