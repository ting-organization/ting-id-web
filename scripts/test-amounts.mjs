#!/usr/bin/env node
// Amounts as people type them (web/js/ui.js): a decimal dot or comma, digits
// grouped by spaces, and never a comma read as a thousands separator.
//
//   node scripts/test-amounts.mjs
import { amountProblem, linkAmount, parseAmount } from '../web/js/ui.js';

const D = 8;
const cases = [
  ['0.55', 55_000_000n],
  ['0,55', 55_000_000n],
  [' 12,5 ', 1_250_000_000n],
  ['12.', 1_200_000_000n],
  ['.5', 50_000_000n],
  ['1 000', 100_000_000_000n],
  ['1 000.25', 100_025_000_000n],
  ['0,555', 55_500_000n],
  ['0,12345678', 12_345_678n],
  ['7', 700_000_000n],
  ['1,000', null],
  ['12,500', null],
  ['1,000.50', null],
  ['1.000,50', null],
  ['1,2,3', null],
  [',5', null],
  ['0,123456789', null],
  ['', null],
  ['abc', null],
  ['1e3', null],
  ['-1', null],
];

let failed = 0;
for (const [text, want] of cases) {
  const got = parseAmount(text, D);
  if (got !== want) {
    failed++;
    console.error(`parseAmount(${JSON.stringify(text)}) = ${got}, want ${want}`);
  }
}
const sayings = [
  ['1,000', 'Write a thousand as 1000, and decimals as 1.5 or 1,5'],
  ['abc', `Enter an amount like 12.5, with at most ${D} decimals`],
];
for (const [text, want] of sayings) {
  if (amountProblem(text, D) !== want) {
    failed++;
    console.error(`amountProblem(${JSON.stringify(text)}) = ${amountProblem(text, D)}`);
  }
}
for (const [units, want] of [[55_000_000n, '0.55'], [123_456_789_000_000n, '1234567.89'], [700_000_000n, '7']]) {
  if (linkAmount(units, D) !== want) {
    failed++;
    console.error(`linkAmount(${units}) = ${linkAmount(units, D)}, want ${want}`);
  }
  if (parseAmount(linkAmount(units, D), D) !== units) {
    failed++;
    console.error(`linkAmount(${units}) does not read back`);
  }
}
const total = cases.length + sayings.length + 6;
console.log(`${total - failed} of ${total} amount checks pass`);
if (failed) process.exit(1);
