const fs = require("node:fs");
const path = require("node:path");

const root = process.cwd();
const packages = [
  ["dist/esm/package.json", { type: "module" }],
  ["dist/cjs/package.json", { type: "commonjs" }]
];

for (const [relativePath, contents] of packages) {
  const fullPath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, `${JSON.stringify(contents, null, 2)}\n`);
}
