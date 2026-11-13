// Bumps the app version in package.json and package-lock.json.
// Usage:
//   node scripts/bump-version.js patch|minor|major   -> 1.0.0 -> 1.0.1 / 1.1.0 / 2.0.0
//   node scripts/bump-version.js 1.2.3               -> set an explicit version
//   node scripts/bump-version.js --show              -> print the current version
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const pkgPath = path.join(root, "package.json");
const lockPath = path.join(root, "package-lock.json");

/** @param {string} p */
const readJson = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
/** @param {string} p @param {unknown} data */
const writeJson = (p, data) =>
  fs.writeFileSync(p, JSON.stringify(data, null, 2) + "\n", "utf8");

const pkg = readJson(pkgPath);
const current = pkg.version;
const arg = process.argv[2];

if (!arg || arg === "--show") {
  console.log(current);
  process.exit(0);
}

const semver = /^(\d+)\.(\d+)\.(\d+)$/;
const m = current.match(semver);
if (!m) {
  console.error(`Current version "${current}" is not x.y.z`);
  process.exit(1);
}
let [major, minor, patch] = m.slice(1).map(Number);

let next;
if (arg === "major") next = `${major + 1}.0.0`;
else if (arg === "minor") next = `${major}.${minor + 1}.0`;
else if (arg === "patch") next = `${major}.${minor}.${patch + 1}`;
else if (semver.test(arg)) next = arg;
else {
  console.error(`Invalid argument "${arg}". Use patch, minor, major or x.y.z`);
  process.exit(1);
}

pkg.version = next;
writeJson(pkgPath, pkg);

if (fs.existsSync(lockPath)) {
  const lock = readJson(lockPath);
  lock.version = next;
  if (lock.packages && lock.packages[""]) lock.packages[""].version = next;
  writeJson(lockPath, lock);
}

console.log(`Version ${current} -> ${next}`);
