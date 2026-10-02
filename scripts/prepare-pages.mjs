import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

const commit = process.env.BUILD_COMMIT;
assert.match(commit ?? "", /^[0-9a-f]{40}$/, "BUILD_COMMIT must be a full commit SHA");
const root = "dist";
function collect(directory) {
  return readdirSync(directory).sort().flatMap((name) => {
    const path = join(directory, name);
    const stat = lstatSync(path);
    assert(!stat.isSymbolicLink(), "Public build must not contain symlinks");
    if (stat.isDirectory()) return collect(path);
    assert(stat.isFile(), "Public build must contain only regular files");
    return [relative(root, path)];
  });
}
const files = collect(root).filter((path) => path !== "deployment.json");
for (const path of files) {
  assert(
    path === "index.html" ||
      path === "third-party-notices.txt" ||
      /^assets\/[A-Za-z0-9_-]+\.(js|css)$/.test(path),
    `Unexpected public file: ${path}`,
  );
}
const html = readFileSync(join(root, "index.html"), "utf8");
assert(html.includes("<title>カイセン</title>"), "Expected Kaisen entry point");
const assets = [...html.matchAll(/(?:src|href)="(\.\/assets\/[^"]+)"/g)].map(
  (match) => match[1].slice(2),
);
assert(assets.some((path) => path.endsWith(".js")), "Missing relative JavaScript entry");
assert(assets.some((path) => path.endsWith(".css")), "Missing relative CSS entry");
assert(!/(?:src|href)="\/(?!\/)/.test(html), "Root-relative URLs break the Pages project path");
for (const path of assets) assert(files.includes(path), `Missing public asset: ${path}`);
assert(files.includes("third-party-notices.txt"), "Missing third-party notices");
for (const path of files.filter((path) => path.endsWith(".js"))) {
  assert(!readFileSync(join(root, path), "utf8").includes("__kaisenReadState"),
    "Development observation hook must not be published");
}
const hashes = Object.fromEntries(files.map((path) => [
  path, createHash("sha256").update(readFileSync(join(root, path))).digest("hex"),
]));
const manifest = { repository: "chameleonjp-lab/kaisen", commit, files: hashes };
writeFileSync(join(root, "deployment.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(JSON.stringify(manifest, null, 2));
