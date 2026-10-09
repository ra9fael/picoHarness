import { build } from "esbuild";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const r = await build({
  entryPoints: ["src/ui/main.ts"],
  bundle: true,
  minify: true,
  format: "iife",
  target: "es2022",
  write: false,
});

const js = r.outputFiles[0].text;
const css =
  readFileSync("src/ui/style.css", "utf8") +
  "\n" +
  readFileSync("node_modules/@xterm/xterm/css/xterm.css", "utf8");
const html = readFileSync("src/ui/index.html", "utf8")
  .replaceAll("/*__STYLE__*/", () => css)
  .replaceAll("/*__BUNDLE__*/", () => js);

mkdirSync("dist", { recursive: true });
writeFileSync("dist/index.html", html);
console.log(`dist/index.html ${(html.length / 1024).toFixed(1)} KB (js ${(js.length / 1024).toFixed(1)} KB)`);
