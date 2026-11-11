// What each transaction may spend, in C, S, D, G: a ceiling, of which only
// what is used is charged. A passkey check through the identity registry
// costs about 12M C, a whole passkey payment about 15M.
export const BUDGETS = {
  /** A coin action or cancel, or a registry operation, sent alone. */
  execute: [40_000_000, 512, 1_048_576, 1_048_576],
  /** A program call (TCR-1), or a batch. */
  batch: [100_000_000, 1024, 2_097_152, 2_097_152],
  /** Running a scheduled coin action: no signature to check. */
  claim: [2_000_000, 64, 65_536, 65_536],
};
