#!/usr/bin/env node
// Checks the assembled site before it is published: every module parses,
// every relative import and asset it names is in the site, the page keeps
// its Content Security Policy, the manifest's icons are there, the service
// worker keeps exactly the site's files, and the policy CodeHash the wallet
// trusts is the one program.wasm has.
//
//   node scripts/check-site.mjs _site
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const site = resolve(process.argv[2] ?? '_site');
const problems = [];
const files = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path);
    else files.push(path);
  }
})(site);

for (const file of files.filter((f) => f.endsWith('.js'))) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (e) {
    problems.push(`${relative(site, file)} does not parse: ${e.stderr.toString().split('\n')[0]}`);
  }
  const text = readFileSync(file, 'utf8');
  for (const m of text.matchAll(/(?:import|export)\s[^'"]*?from\s+['"](\.[^'"]+)['"]|import\(\s*['"](\.[^'"]+)['"]\s*\)/g)) {
    // Resolved as the browser will, as a URL: `..` at the site's root stays there.
    const url = new URL(m[1] ?? m[2], `https://site/${relative(site, file)}`);
    const target = join(site, decodeURIComponent(url.pathname));
    if (!existsSync(target)) problems.push(`${relative(site, file)} imports ${m[1] ?? m[2]}, which is not in the site`);
  }
}

const html = readFileSync(join(site, 'index.html'), 'utf8');
if (!/http-equiv="Content-Security-Policy"/.test(html)) problems.push('index.html lost its Content Security Policy');
for (const m of html.matchAll(/(?:src|href)="([^"#:]+)"/g)) {
  if (!existsSync(resolve(site, m[1]))) problems.push(`index.html names ${m[1]}, which is not in the site`);
}
const css = readFileSync(join(site, 'css/app.css'), 'utf8');
for (const m of css.matchAll(/url\('([^']+)'\)/g)) {
  if (!existsSync(resolve(site, 'css', m[1]))) problems.push(`app.css names ${m[1]}, which is not in the site`);
}

let manifest = null;
try {
  manifest = JSON.parse(readFileSync(join(site, 'manifest.webmanifest'), 'utf8'));
} catch (e) {
  problems.push(`manifest.webmanifest does not parse: ${e.message}`);
}
for (const icon of manifest?.icons ?? []) {
  if (!existsSync(resolve(site, icon.src))) problems.push(`manifest.webmanifest names ${icon.src}, which is not in the site`);
}
if (manifest && !manifest.icons?.some((i) => i.purpose === 'maskable')) problems.push('manifest.webmanifest has no maskable icon');

const worker = readFileSync(join(site, 'sw.js'), 'utf8');
const kept = JSON.parse(/^const FILES = (\[.*\]);\r?$/m.exec(worker)?.[1] ?? '[]');
const served = new Set(files.map((f) => relative(site, f).split('\\').join('/')).filter((f) => f !== 'sw.js'));
if (!/^const VERSION = '[0-9a-f]{16}';\r?$/m.test(worker) || !kept.includes('./')) {
  problems.push('sw.js was not given its files: run scripts/worker-files.mjs');
} else {
  for (const f of kept) if (f !== './' && !served.has(f)) problems.push(`sw.js keeps ${f}, which is not in the site`);
  for (const f of served) if (!kept.includes(f)) problems.push(`sw.js does not keep ${f}`);
}

const code = readFileSync(new URL('../program.wasm', import.meta.url));
const tag = Buffer.from('code');
const codeHash = createHash('sha256').update(Buffer.concat([Buffer.from('Ting/'), Buffer.from([tag.length, 0]), tag, code])).digest('hex');
const trusted = /POLICY_CODE_HASH = '([0-9a-f]{64})'/.exec(readFileSync(join(site, 'js/chain/net.js'), 'utf8'))?.[1];
if (trusted !== codeHash) problems.push(`the wallet trusts policy CodeHash ${trusted}, but program.wasm is ${codeHash}`);

if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log(`site ok: ${files.length} files, policy CodeHash ${codeHash}`);
