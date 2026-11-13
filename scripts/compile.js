// Compiles the TypeScript sources into out/ (main process, preload, lib/ and
// the window's script). Run by `npm start` and the build scripts, and by
// electron-builder itself (build.beforeBuild in package.json), so every way of
// building an installer packs freshly compiled code.
//   node scripts/compile.js           -> clean out/ and compile
//   node scripts/compile.js --check   -> type-check only (no output)
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const tsc = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc');
const projects = ['tsconfig.json', path.join('renderer', 'tsconfig.json')];
// Only type-checked (they emit nothing).
const checkOnly = [path.join('scripts', 'tsconfig.json')];

function compile(check = false) {
  // Start clean, so files removed from the sources don't linger in out/.
  if (!check) fs.rmSync(path.join(root, 'out'), { recursive: true, force: true });
  for (const project of projects) {
    execFileSync(process.execPath, [tsc, '-p', project, ...(check ? ['--noEmit'] : [])], { cwd: root, stdio: 'inherit' });
  }
  if (check) for (const project of checkOnly) execFileSync(process.execPath, [tsc, '-p', project], { cwd: root, stdio: 'inherit' });
}

if (require.main === module) {
  try {
    compile(process.argv.includes('--check'));
  } catch {
    process.exit(1); // (tsc has printed the errors)
  }
}

// electron-builder's beforeBuild hook. Returning nothing lets it carry on as usual.
module.exports = async () => {
  compile();
};
