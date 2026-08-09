#!/usr/bin/env node
/**
 * `xch01` — the requirement no phase owned, given an owner and a measured branch.
 *
 *     PLAZO_XCH01=1 pnpm --filter @plazo/arc-verify xch01
 *
 * It spends nothing on either branch. **Both branches exit 0**: an unfunded origin EOA is a
 * precondition that was not met (DEC-38 — Gateway burn intents accept EOA signatures only,
 * and this project holds no EOA on a second Gateway-supported testnet), and it is reported
 * with measured held, required and shortfall in the three units the gap is actually paid in.
 *
 * The assertion worth the most runs on **both** branches and needs neither a chain nor a
 * key: Circle Gateway's EIP-712 domain is `{name, version}` and nothing else (DEC-37), and
 * adding `chainId` makes every signature silently invalid. It is demonstrated firing.
 *
 * Whatever it prints goes into `contracts/test/fork/FINDINGS.md`, finding 37.
 */
import {runXch01} from "./xch01.js";

runXch01().catch((error: unknown) => {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
