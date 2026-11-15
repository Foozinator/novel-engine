/**
 * Regenerates `agents/prompt-history.json`: every version of every bundled
 * agent prompt that has ever shipped, as SHA-256 hashes (#39).
 *
 * `ensureAgents` uses it on installs that predate the prompt manifest: a
 * custom-agents file whose hash matches a past bundled version is unedited,
 * so it is safe to replace with the current one.
 *
 * Keys are lower-cased filenames (prompt files were renamed by case before).
 * Content is hashed with CRLF normalised to LF, matching `hashPrompt()` in
 * `src/main/bootstrap.ts`.
 *
 * Run after any change under agents/: `npm run agent-hashes`.
 * A test fails if a current prompt's hash is missing from the file.
 */
const { execFileSync } = require('child_process');
const { createHash } = require('crypto');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const agentsDir = path.join(root, 'agents');
const outFile = path.join(agentsDir, 'prompt-history.json');

const git = (...args) =>
  execFileSync('git', args, { cwd: root, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });

const hashPrompt = (buf) =>
  createHash('sha256').update(buf.toString('utf-8').replace(/\r\n/g, '\n')).digest('hex');

const isPrompt = (name) => name.toLowerCase().endsWith('.md');

/** @type {Map<string, Set<string>>} */
const history = new Map();
const add = (name, hash) => {
  const key = name.toLowerCase();
  if (!history.has(key)) history.set(key, new Set());
  history.get(key).add(hash);
};

// Every committed version.
const seenBlobs = new Set();
const commits = git('rev-list', 'HEAD', '--', 'agents/').toString().split('\n').filter(Boolean);
for (const commit of commits) {
  const tree = git('ls-tree', commit, 'agents/').toString().split('\n').filter(Boolean);
  for (const line of tree) {
    const [meta, filePath] = line.split('\t');
    const [, type, blob] = meta.split(' ');
    const name = path.posix.basename(filePath);
    if (type !== 'blob' || !isPrompt(name)) continue;
    const key = `${name.toLowerCase()}:${blob}`;
    if (seenBlobs.has(key)) continue;
    seenBlobs.add(key);
    add(name, hashPrompt(git('cat-file', 'blob', blob)));
  }
}

// The working tree, so regenerating before a commit includes the new version.
for (const name of fs.readdirSync(agentsDir)) {
  if (isPrompt(name)) add(name, hashPrompt(fs.readFileSync(path.join(agentsDir, name))));
}

const out = {};
for (const key of [...history.keys()].sort()) out[key] = [...history.get(key)].sort();
fs.writeFileSync(outFile, JSON.stringify(out, null, 2) + '\n');

const versions = Object.values(out).reduce((n, list) => n + list.length, 0);
console.log(`[agent-hashes] ${Object.keys(out).length} prompts, ${versions} versions → ${path.relative(root, outFile)}`);
