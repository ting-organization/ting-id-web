#!/usr/bin/env node
// Tests recovery phrases (web/js/phrase.js) against published vectors and
// against Node's own crypto: the BIP-39 word list, words from entropy and
// their checksum, seeds, BIP-32 derivation, the key of RECOVERY.md's phrase in
// Ting ID, RFC 6979 nonces on the RFC's own examples, and random signatures
// verified by OpenSSL, each in its low form and the same every time.
//
//   node scripts/test-phrase.mjs [rounds]
//
// Exits 1 on the first group with a failure.
import { createHash, createPublicKey, ECDH, pbkdf2Sync, randomBytes, verify } from 'node:crypto';
import { hex, unhex } from '../kit/web/bytes.js';
import { WORDS } from '../web/js/bip39-english.js';
import { derive, keyOf, N, newWords, nonces, normalise, problem, publicKeyOf, seedOf, sign, wordsOf } from '../web/js/phrase.js';

const rounds = Number(process.argv[2] ?? 2000);
let failures = 0;
let checks = 0;
const check = (ok, what) => {
  checks++;
  if (!ok) {
    failures++;
    console.error(`  FAIL ${what}`);
  }
};
const group = async (name, run) => {
  const before = failures;
  const at = checks;
  const started = performance.now();
  await run();
  const ms = (performance.now() - started).toFixed(0);
  console.log(`${failures === before ? 'ok  ' : 'FAIL'} ${name}: ${checks - at} checks, ${ms} ms`);
};
const sha = (data) => new Uint8Array(createHash('sha256').update(data).digest());
const big = (h) => BigInt(`0x${h}`);
const ABOUT = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

await group('word list', () => {
  check(WORDS.length === 2048, 'has 2,048 words');
  check(new Set(WORDS).size === 2048, 'no word twice');
  check(WORDS.every((w, i) => i === 0 || WORDS[i - 1] < w), 'sorted');
  check(WORDS.every((w) => /^[a-z]{3,8}$/.test(w)), 'lower-case letters only');
  // SHA-256 of bip-0039/english.txt as published.
  check(hex(sha(`${WORDS.join('\n')}\n`)) === '2f5eed53a4727b4bf8880d8f3f199efc90e58503646d9ff8eff3a2ed3b24dbda', 'is english.txt');
});

// The BIP's own vectors: entropy and the words it gives.
const VECTORS = [
  ['00000000000000000000000000000000', ABOUT],
  ['7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f', 'legal winner thank year wave sausage worth useful legal winner thank yellow'],
  ['80808080808080808080808080808080', 'letter advice cage absurd amount doctor acoustic avoid letter advice cage above'],
  ['ffffffffffffffffffffffffffffffff', 'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong'],
  ['000000000000000000000000000000000000000000000000', `${'abandon '.repeat(17)}agent`],
  ['7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f', 'legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth useful legal will'],
  ['0000000000000000000000000000000000000000000000000000000000000000', `${'abandon '.repeat(23)}art`],
  ['ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff', `${'zoo '.repeat(23)}vote`],
  ['9e885d952ad362caeb4efe34a8e91bd2', 'ozone drill grab fiber curtain grace pudding thank cruise elder eight picnic'],
];

await group('words from entropy', () => {
  for (const [entropy, words] of VECTORS) {
    check(wordsOf(unhex(entropy)).join(' ') === words, `entropy ${entropy}`);
    check(problem(words) === null, `${words.split(' ').length} words check out`);
  }
  for (let i = 0; i < 300; i++) {
    const n = [16, 20, 24, 28, 32][i % 5];
    const words = wordsOf(randomBytes(n));
    check(words.length === (n * 8 + n / 4) / 11 && problem(words) === null, `random ${n} bytes round trip`);
  }
  const fresh = new Set();
  for (let i = 0; i < 100; i++) {
    const words = newWords();
    check(words.length === 12 && problem(words) === null, 'new words are 12 that check out');
    fresh.add(words.join(' '));
  }
  check(fresh.size === 100, 'new words differ every time');
});

await group('problems', () => {
  check(problem(`  ${ABOUT.toUpperCase().replace(/ /g, '  \n ')}  `) === null, 'case and spacing are ignored');
  check(problem(ABOUT.split(' ')) === null, 'a list of words works too');
  check(normalise(' Abandon\tABOUT ').join(' ') === 'abandon about', 'normalise');
  check(problem('') === 'Use 12, 15, 18, 21 or 24 words', 'no words');
  check(problem(ABOUT.split(' ').slice(1)) === 'Use 12, 15, 18, 21 or 24 words', '11 words');
  check(problem(`${ABOUT} abandon`) === 'Use 12, 15, 18, 21 or 24 words', '13 words');
  check(problem(ABOUT.replace('about', 'foo')) === '“foo” is not a recovery phrase word', 'an unknown word is named');
  check(problem('abandon '.repeat(12)) === 'Those words do not check out: look at their spelling and order', 'a bad checksum');
  check(problem(ABOUT.replace('about', 'above')) !== null, 'one word changed');
  // Swapping two different words breaks the checksum nearly always: count how often it holds.
  let held = 0;
  for (let i = 0; i < 500; i++) {
    const words = newWords();
    const [a, b] = [i % 12, (i * 7 + 3) % 12];
    if (a === b || words[a] === words[b]) continue;
    [words[a], words[b]] = [words[b], words[a]];
    if (problem(words) === null) held++;
  }
  check(held < 80, `a swap is caught most of the time (it held ${held} of about 500 times; 1 in 16 expected)`);
});

await group('seeds', async () => {
  check(hex(await seedOf(ABOUT)) === '5eb00bbddcf069084889a8ab9155568165f5c453ccb85e70811aaed6f6da5fc19a5ac40b389cd370d086206dec8aa6c43daea6690f20ad3d8d48b2d2ce9e38e4', 'abandon … about');
  for (const [, words] of VECTORS) {
    const node = pbkdf2Sync(words, 'mnemonic', 2048, 64, 'sha512').toString('hex');
    check(hex(await seedOf(words)) === node, `seed of ${words.slice(0, 24)}… matches Node's PBKDF2`);
  }
  check(hex(await seedOf(ABOUT.toUpperCase())) === hex(await seedOf(ABOUT)), 'typed in capitals, the same seed');
  let refused = false;
  await seedOf('abandon '.repeat(12)).catch(() => { refused = true; });
  check(refused, 'words that do not check out make no seed');
});

await group('BIP-32', async () => {
  // Test vector 1 of BIP-32, private keys along m/0'/1/2'/2/1000000000.
  const seed1 = unhex('000102030405060708090a0b0c0d0e0f');
  const chain1 = [
    ['m', 'e8f32e723decf4051aefac8e2c93c9c5b214313817cdb01a1494b917c8436b35'],
    ["m/0'", 'edb2e14f9ee77d26dd93b4ecede8d16ed408ce149b6cd80b0715a2d911a0afea'],
    ["m/0'/1", '3c6cb8d0f6a264c91ea8b5030fadaa8e538b020f0a387421a12de9319dc93368'],
    ["m/0'/1/2'", 'cbce0d719ecf7431d88e6a89fa1483e02e35092af60c042b1df2ff59fa424dca'],
    ["m/0'/1/2'/2", '0f479245fb19a38a1954c5c7c0ebab2f9bdfd96a17563ef28a6a4b1a2a764ef4'],
    ["m/0'/1/2'/2/1000000000", '471b76e389e528d6de6d816857e012c5455051cad6660850e58372a6c3e6e7c8'],
  ];
  for (const [path, key] of chain1) check((await derive(seed1, path)) === big(key), `vector 1 ${path}`);
  check((await derive(seed1, 'm/0h/1/2H/2/1000000000')) === big(chain1[5][1]), 'h and H mark hardened steps too');
  // Test vector 3: a master key with a leading zero byte, kept in the hardened step.
  const seed3 = unhex('4b381541583be4423346c643850da4b320e46a87ae3d2a4e6da11eba819cd4acba45d239319ac14f863b8d5ab5a0d0c64d2e8a1e7d1457df2e5a3c51c73235be');
  check((await derive(seed3, 'm')) === big('00ddb80b067e0d4993197fe10f2657a844a384589847602d56f0c629c81aae32'), 'vector 3 m');
  check((await derive(seed3, "m/0'")) === big('491f7a2eebc7b57028e0d3faa0acda02e75c33b03c48fb288c41e2ea44e1daef'), "vector 3 m/0'");
  for (const bad of ['', '0', 'm/x', "m/2147483648'", 'm/-1', "m/1''"]) {
    let refused = false;
    await derive(seed1, bad).catch(() => { refused = true; });
    check(refused, `path ${JSON.stringify(bad)} refused`);
  }
});

await group('the key of RECOVERY.md', async () => {
  const started = performance.now();
  const { secret, publicKey } = await keyOf(ABOUT);
  console.log(`     keyOf took ${(performance.now() - started).toFixed(1)} ms`);
  check(hex(publicKey) === '047388c4cccd1893555407977f70e303c242c3d3d6f992ea01583af171a2c02c67136ba4103689143e9d458d7891d2c0c1ea98db313a9aa72ea76bcbbb6ebde46b', 'abandon … about gives Ting ID\'s key');
  check(hex(publicKeyOf(secret)) === hex(publicKey), 'publicKeyOf agrees');
});

await group('public keys', () => {
  const edges = [1n, 2n, 3n, N - 1n, N - 2n, 1n << 128n, (1n << 255n) + 1n];
  const randoms = Array.from({ length: 200 }, () => BigInt(`0x${randomBytes(32).toString('hex')}`) % (N - 1n) + 1n);
  for (const secret of [...edges, ...randoms]) {
    const ecdh = new ECDH('secp256k1');
    ecdh.setPrivateKey(Buffer.from(secret.toString(16).padStart(64, '0'), 'hex'));
    check(hex(publicKeyOf(secret)) === ecdh.getPublicKey('hex', 'uncompressed'), `public key of ${secret.toString(16).slice(0, 12)}…`);
  }
  for (const bad of [0n, N, N + 1n, -1n, 5]) {
    let refused = false;
    try { publicKeyOf(bad); } catch { refused = true; }
    check(refused, `secret ${bad} refused`);
  }
});

await group('RFC 6979 nonces', async () => {
  const first = async (secret, digest, order) => (await nonces(secret, digest, order).next()).value;
  // RFC 6979 A.2.5: P-256 with SHA-256, the RFC's own key and messages.
  const p256 = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
  const x = big('c9afa9d845ba75166b5c215767b1d6934e50c3db36e89b127b8a622b120f6721');
  check((await first(x, sha('sample'), p256)) === big('a6e3c57dd01abe90086538398355dd4c3b17aa873382b0f24d6129493d8aad60'), 'P-256, SHA-256, "sample"');
  check((await first(x, sha('test'), p256)) === big('d16b6ae827f17175e040871a1c7ec3500192c4c92677336ec2537acaee0008e0'), 'P-256, SHA-256, "test"');
  // secp256k1, as other libraries publish it.
  const k1 = [
    [1n, 'Satoshi Nakamoto', '8f8a276c19f4149656b280621e358cce24f5f52542772691ee69063b74f15d15',
      '934b1ea10a4b3c1757e2b0c017d0b6143ce3c9a7e6a4a49860d7a6ab210ee3d8', '2442ce9d2b916064108014783e923ec36b49743e2ffa1c4496f01a512aafd9e5'],
    [1n, 'All those moments will be lost in time, like tears in rain. Time to die...', '38aa22d72376b4dbc472e06c3ba403ee0a394da63fc58d88686c611aba98d6b3',
      '8600dbd41e348fe5c9465ab92d23e3db8b98b873beecd930736488696438cb6b', '547fe64427496db33bf66019dacbf0039c04199abb0122918601db38a72cfc21'],
    [big('f8b8af8ce3c7cca5e300d33939540c10d45ce001b8f252bfbc57ba0342904181'), 'Alan Turing', '525a82b70e67874398067543fd84c83d30c175fdc45fdeee082fe13b1d7cfdf1',
      '7063ae83e7f62bbb171798131b4a0564b956930092b33b07b395615d9ec7e15c', '58dfcc1e00a35e1572f366ffe34ba0fc47db1e7189759b9fb233c5b05ab388ea'],
  ];
  for (const [secret, message, k, r, s] of k1) {
    check((await first(secret, sha(message))) === big(k), `secp256k1 nonce, "${message.slice(0, 20)}"`);
    check(hex(await sign(secret, sha(message))) === r + s, `secp256k1 signature, "${message.slice(0, 20)}"`);
  }
});

await group(`signatures (${rounds} random, checked by OpenSSL)`, async () => {
  const half = N >> 1n;
  const spki = (key) => createPublicKey({ key: Buffer.concat([Buffer.from('3056301006072a8648ce3d020106052b8104000a034200', 'hex'), key]), format: 'der', type: 'spki' });
  for (let i = 0; i < rounds; i++) {
    const secret = i < 4 ? [1n, 2n, N - 1n, N - 2n][i] : BigInt(`0x${randomBytes(32).toString('hex')}`) % (N - 1n) + 1n;
    const message = randomBytes(i % 97);
    const digest = sha(message);
    const signature = await sign(secret, digest);
    const key = spki(publicKeyOf(secret));
    check(signature.length === 64, 'is 64 bytes');
    check(BigInt(`0x${hex(signature.subarray(32))}`) <= half, 's is low');
    check(verify('sha256', message, { key, dsaEncoding: 'ieee-p1363' }, signature), `verifies (round ${i})`);
    if (i % 10 === 0) {
      check(hex(await sign(secret, digest)) === hex(signature), 'the same every time');
      const bent = signature.slice();
      bent[i % 64] ^= 1 << (i % 8);
      check(!verify('sha256', message, { key, dsaEncoding: 'ieee-p1363' }, bent), 'a changed bit fails');
      const other = sha(Buffer.concat([message, Buffer.from([1])]));
      check(hex(await sign(secret, other)) !== hex(signature), 'another digest, another signature');
    }
  }
  for (const [secret, digest] of [[0n, sha('x')], [N, sha('x')], [1n, sha('x').subarray(1)]]) {
    let refused = false;
    await sign(secret, digest).catch(() => { refused = true; });
    check(refused, 'a bad secret or digest is refused');
  }
});

console.log(`${checks} checks, ${failures} failed`);
process.exit(failures ? 1 : 0);
