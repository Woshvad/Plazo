/**
 * `pnpm --filter @plazo/arc-verify gov08`
 *
 * Gated behind `PLAZO_GOV08=1`. Exits 0 on both funding branches: an unmet
 * precondition reported clearly is a pass, not a failure, and GOV-08's proof of record
 * is `forge test --root contracts --mt test_operatorFreeLoop` either way.
 */
import {runGov08} from "./gov08.js";

runGov08().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
