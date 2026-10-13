// Dead-link check for the documentation tree (README.md, README.en.md, docs/**).
// GitHub renders `[text](target#fragment)` by slugging the heading text, so a
// renamed section silently breaks every link that pointed into it. This walks
// every .md in the repository, builds each file's heading-slug set with the same
// rule, then resolves each relative link's path and fragment. Non-zero exit on
// any dead target, so it can gate a release.
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";

const SKIP = new Set([".git", "node_modules", "dist", ".venv", "build"]);

const slug = (t) =>
  t
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N} \-_]/gu, "")
    .replace(/ /g, "-");

const root = resolve(process.argv[2] || ".");
const files = [];
const walk = (d) => {
  for (const e of readdirSync(d)) {
    if (SKIP.has(e)) continue;
    const p = join(d, e);
    if (statSync(p).isDirectory()) walk(p);
    else if (e.endsWith(".md")) files.push(p);
  }
};
walk(root);

const headings = new Map();
for (const f of files) {
  const s = new Set();
  for (const line of readFileSync(f, "utf8").split("\n")) {
    const m = /^#{1,6}\s+(.*)$/.exec(line);
    if (m) s.add(slug(m[1]));
  }
  headings.set(f, s);
}

const rel = (f) => f.slice(root.length + 1).replace(/\\/g, "/");
let dead = 0;
for (const f of files) {
  for (const m of readFileSync(f, "utf8").matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
    const ref = m[1];
    if (/^(https?:|mailto:)/.test(ref)) continue;
    const [pathPart, frag] = ref.split("#");
    const target = pathPart ? resolve(dirname(f), pathPart) : f;
    if (pathPart && !existsSync(target)) {
      console.log(`missing file  ${rel(f)}  ->  ${ref}`);
      dead++;
    } else if (frag && target.endsWith(".md") && !headings.get(target)?.has(slug(frag))) {
      console.log(`dead anchor   ${rel(f)}  ->  ${ref}`);
      dead++;
    }
  }
}
console.log(dead ? `${dead} dead link(s) in ${files.length} files` : `OK: ${files.length} files, 0 dead links`);
process.exit(dead ? 1 : 0);
