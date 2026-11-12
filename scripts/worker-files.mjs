#!/usr/bin/env node
// Writes into the assembled site's sw.js the files the service worker keeps
// for opening without a network, and a version made from their contents: a
// change anywhere in the site changes sw.js, which makes it a new worker that
// fetches the whole site afresh.
//
//   node scripts/worker-files.mjs _site
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

const site = resolve(process.argv[2] ?? '_site');
const worker = join(site, 'sw.js');

const files = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path);
    else if (path !== worker) files.push(relative(site, path).split(sep).join('/'));
  }
})(site);
files.sort();

const hash = createHash('sha256');
for (const file of files) {
  const bytes = readFileSync(join(site, file));
  hash.update(`${file}\n${bytes.length}\n`).update(bytes);
}
const version = hash.digest('hex').slice(0, 16);

let text = readFileSync(worker, 'utf8');
const fill = (pattern, line) => {
  if (!pattern.test(text)) {
    console.error(`sw.js has no line ${pattern} to fill in`);
    process.exit(1);
  }
  text = text.replace(pattern, () => line);
};
// (?=\r?$): a Windows checkout ends its lines in CRLF.
fill(/^const VERSION = '[^']*';(?=\r?$)/m, `const VERSION = '${version}';`);
fill(/^const FILES = \[\];(?=\r?$)/m, `const FILES = ${JSON.stringify(['./', ...files])};`);
writeFileSync(worker, text);
console.log(`sw.js keeps ${files.length} files, version ${version}`);
