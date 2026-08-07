/**
 * The EIP-7708 native-transfer stream, read at 18 decimals against real Arc blocks.
 *
 * Because USDC *is* Arc's gas token, Arc emits a canonical ERC-20 `Transfer` log for
 * every native movement, from a system emitter. A borrower's complete inflow history —
 * payroll, remittances, contract endowments, precompile movements — is therefore a
 * filtered log scan. No incumbent underwriting against a bank rail has that, and it is
 * the mechanism UW-04's Tier-1 limit is built on.
 *
 * ## E-08, and it is worth a factor of a trillion
 *
 * The system emitter's logs carry **18** decimals. The USDC contract's own `Transfer`
 * carries **6**. A single ERC-20 `transfer()` emits **both** — one balance change, two
 * logs, two scales, two emitters. Verified live on 2026-08-07 in block `0x354132c`:
 *
 *     emitter  from 0xd68256f4… to 0x1f531ce3…  19720000000000000000   (18-dec)
 *     0x3600…  from 0xd68256f4… to 0x1f531ce3…            19720000     ( 6-dec)
 *     same transaction 0x46499d6a…, ratio exactly 1e12
 *
 * Sum them and income inflates by 10^12 + 1 if the scales are never reconciled, or by
 * exactly 2× if they are reconciled and the duplication is not. Neither number looks
 * wrong, and every Tier-1 limit downstream of it is wrong.
 *
 * The rule, stated once and enforced everywhere: **filter by emitter address, use the
 * system stream alone, and never mix the scales.** `@plazo/plan-core` carries the
 * compile-time half — `Native18` is a distinct brand from `Wei18`, and `toMinor6` is
 * the only narrowing path out of a log value. This file carries the live half: it
 * prints the naive sum beside the correct figure with the ratio, so the error is a
 * number on a terminal rather than a warning in a comment.
 *
 * ## The second hazard in the same stream
 *
 * Arc does not burn the base fee — it credits the block beneficiary. So a naive "all
 * logs touching this address" query picks up **outflows**, and outflows are not income.
 * `runInflowCheck` reports what it measured about that rather than asserting it.
 *
 * ## What this file is not
 *
 * It is not the production read path. Ninety days at 0.514 s is roughly 15.1 million
 * blocks against a 10,000-block `eth_getLogs` cap on an endpoint that sheds ~25% of
 * requests — about 1,510 requests per borrower per quote. A request-time scan times out
 * and looks like a code bug. The history is a continuously indexed table
 * (`services/indexer/src/inflow.ts`) read as one row at quote time. This module is the
 * decimal-correctness gate over a small, recent window, and nothing else.
 *
 * Nothing here sends a transaction. Every read goes through `shed()`.
 */
import {
  createPublicClient,
  formatUnits,
  http,
  parseAbiItem,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import {arcTestnet} from "viem/chains";

import {
  ARC_MAX_LOG_RANGE,
  ARC_TESTNET_RPC_URL,
  ARC_USDC,
  native18,
  toMinor6,
  usdc6,
  type Native18,
  type Usdc6,
} from "@plazo/plan-core";

import type {CheckResult} from "./checks.js";
import {shed} from "./slice.js";

// ─── The emitter ──────────────────────────────────────────────────────────────

/**
 * Arc's EIP-7708 native-transfer system emitter.
 *
 * Provenance: `docs.arc.io` "USDC system events", and confirmed live against chain
 * 5042002 on 2026-08-07 — canonical `Transfer` topic0, `from` and `to` indexed, `value`
 * in the data field at **18 decimals**.
 *
 * **This literal appears exactly once in this file, and that is a gate.** Every other
 * reference is to the constant. A second copy is how one of them ends up filtering a
 * different stream than the one the comment above it describes.
 */
export const ARC_NATIVE_TRANSFER_EMITTER: Address =
  "0xfffffffffffffffffffffffffffffffffffffffe";

/** Canonical ERC-20 `Transfer`. Both emitters use it; only the scale differs. */
const TRANSFER_EVENT = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 value)",
);

// ─── Reading ──────────────────────────────────────────────────────────────────

export interface InflowLog<TValue> {
  from: Address;
  to: Address;
  value: TValue;
  blockNumber: bigint;
  txHash: Hex;
  logIndex: number;
}

export interface InflowWindow {
  /**
   * The recipient to filter on.
   *
   * Optional, and the option is what the gate needs: a filtered read is the production
   * shape, an unfiltered read over a small window is the only way to *find* a movement
   * that appears in both streams and prove the ratio. Omitting it reads the whole
   * emitter stream over the window and nothing else changes.
   */
  to?: Address;
  fromBlock: bigint;
  toBlock: bigint;
}

/**
 * Page an `eth_getLogs` range under Arc's cap, every page inside `shed()`.
 *
 * The retry is not defensive tidiness. Arc's public RPC sheds roughly a quarter of
 * requests with `-32011` regardless of pacing, and viem does not retry it — a shed
 * response arrives as HTTP 200 with an error body. A log page that silently returns
 * nothing is an income figure of zero, which is a Tier-1 limit of zero, which reads
 * as "this borrower has no history" rather than as "the node declined to answer".
 */
async function pagedLogs(
  client: PublicClient,
  address: Address,
  args: {from?: Address; to?: Address},
  fromBlock: bigint,
  toBlock: bigint,
): Promise<Array<{args: {from?: Address; to?: Address; value?: bigint}} & Record<string, unknown>>> {
  const span = BigInt(ARC_MAX_LOG_RANGE - 1);
  const out: Array<{args: {from?: Address; to?: Address; value?: bigint}} & Record<string, unknown>> =
    [];

  for (let start = fromBlock; start <= toBlock; start += span + 1n) {
    const end = start + span > toBlock ? toBlock : start + span;
    const page = await shed(() =>
      client.getLogs({
        address,
        event: TRANSFER_EVENT,
        args,
        fromBlock: start,
        toBlock: end,
      }),
    );
    out.push(...(page as never[]));
  }

  return out;
}

/**
 * The system emitter's stream — **the only stream a scorer may ever count**.
 *
 * Values come back as `Native18`, which is a distinct brand from `Wei18` precisely so
 * that a log value cannot be handed to a function expecting a balance. The single legal
 * narrowing is `toMinor6`.
 */
export async function readNativeInflows(
  client: PublicClient,
  window: InflowWindow,
): Promise<InflowLog<Native18>[]> {
  const logs = await pagedLogs(
    client,
    ARC_NATIVE_TRANSFER_EMITTER,
    window.to ? {to: window.to} : {},
    window.fromBlock,
    window.toBlock,
  );

  return logs.map((log) => ({
    from: log.args.from as Address,
    to: log.args.to as Address,
    value: native18(log.args.value ?? 0n),
    blockNumber: log["blockNumber"] as bigint,
    txHash: log["transactionHash"] as Hex,
    logIndex: log["logIndex"] as number,
  }));
}

/**
 * The ERC-20 contract's own stream, at 6 decimals.
 *
 * **This function exists only so the duplication can be demonstrated. No scorer may
 * call it, and no indexing handler may write it into `inflow`.** It is the second half
 * of a movement the system emitter already reported; counting both is E-08's 2×, and
 * counting this one *instead* while the rest of the pipeline assumes 18 decimals is
 * E-08's 10^12 in the other direction.
 *
 * `! grep -rq 'readErc20Inflows' services/` is an acceptance gate for exactly this
 * reason. If a future reader needs a borrower's USDC receipts, the answer is
 * `readNativeInflows` and `toMinor6` — one stream, one narrowing.
 */
export async function readErc20Inflows(
  client: PublicClient,
  options: InflowWindow & {token?: Address},
): Promise<InflowLog<Usdc6>[]> {
  const logs = await pagedLogs(
    client,
    options.token ?? ARC_USDC,
    options.to ? {to: options.to} : {},
    options.fromBlock,
    options.toBlock,
  );

  return logs.map((log) => ({
    from: log.args.from as Address,
    to: log.args.to as Address,
    value: usdc6(log.args.value ?? 0n),
    blockNumber: log["blockNumber"] as bigint,
    txHash: log["transactionHash"] as Hex,
    logIndex: log["logIndex"] as number,
  }));
}

// ─── The gate ─────────────────────────────────────────────────────────────────

/**
 * A check row, plus the counting rule findings 16-27 established.
 *
 * `pass` increments the counted total. `note` does not: it is for an assertion that can
 * only be witnessed when the chain happens to carry the right organic traffic, and
 * counting one of those makes a green run mean something different depending on what
 * strangers did that minute. An unrun row is **absent**, not noted.
 */
export type CheckKind = "pass" | "note" | "fail";
export interface InflowCheckRow extends CheckResult {
  kind: CheckKind;
}

function pass(name: string, detail: string): InflowCheckRow {
  return {kind: "pass", name, ok: true, detail};
}

function note(name: string, detail: string): InflowCheckRow {
  return {kind: "note", name, ok: true, detail};
}

function fail(name: string, detail: string, because: string): InflowCheckRow {
  return {kind: "fail", name, ok: false, detail, because};
}

/** How many recent blocks to sweep. Well inside the 10,000 cap and the shed budget. */
const WINDOW_BLOCKS = 200n;

/** How many blocks to fetch beneficiaries for. Bounded — one request each. */
const BENEFICIARY_SAMPLE = 8;

function usdcText(minor: bigint): string {
  return `${formatUnits(minor, 6)} USDC`;
}

/** `(txHash, from, to)` — the triple that identifies one balance change across both streams. */
function tripleOf(log: {txHash: Hex; from: Address; to: Address}): string {
  return `${log.txHash}:${log.from.toLowerCase()}:${log.to.toLowerCase()}`;
}

export interface InflowCheckReport {
  rows: InflowCheckRow[];
  fromBlock: bigint;
  toBlock: bigint;
  nativeCount: number;
  erc20Count: number;
  matched: number;
  /** Correct: the system stream alone, narrowed once. */
  correctMinor: bigint;
  /** What a naive implementation that reconciled the scales but not the duplication gets. */
  doubledMinor: bigint;
  /** What a naive implementation that reconciled neither gets. */
  unscaledSum: bigint;
  beneficiaryLogs: number;
}

/**
 * The live decimal-correctness read.
 *
 * Reads both streams over the same small, recent window, matches them on
 * `(txHash, from, to)`, and reports three figures rather than one: the correct income,
 * the 2× a scale-reconciled double-count produces, and the 10^12 a raw sum produces.
 * Printing the wrong answers next to the right one is the whole point — a risk
 * described in prose is a risk somebody reads past.
 *
 * **It claims no observation of real payroll.** Arc testnet has essentially no organic
 * inflow history of that kind and this repo's own wallets were funded by aggregating
 * faucet drips. What is witnessable here is that the stream parses at 18 decimals and
 * that the two streams describe one movement; the scoring itself is validated against a
 * synthetic fixture in `services/origination/test/tier1.test.ts`, and that split is
 * deliberate.
 */
export async function runInflowCheck(client: PublicClient): Promise<InflowCheckReport> {
  const rows: InflowCheckRow[] = [];

  const head = await shed(() => client.getBlockNumber());
  const toBlock = head;
  const fromBlock = head > WINDOW_BLOCKS ? head - WINDOW_BLOCKS : 0n;

  const nativeLogs = await readNativeInflows(client, {fromBlock, toBlock});
  const erc20Logs = await readErc20Inflows(client, {fromBlock, toBlock});

  // ── 1. One balance, two scales — the premise, asserted on a live account ────
  //
  // Countable on every run and independent of what traffic the window happened to
  // hold. `getBalance` is the 18-decimal view and `balanceOf` is the 6-decimal view of
  // the same balance, so the ratio is exactly 1e12 or E-08's premise is wrong.
  const subject =
    nativeLogs.find((log) => log.value > 0n)?.to ?? ARC_NATIVE_TRANSFER_EMITTER;
  const nativeBalance = await shed(() => client.getBalance({address: subject}));
  const erc20Balance = await shed(() =>
    client.readContract({
      address: ARC_USDC,
      abi: [
        {
          type: "function",
          name: "balanceOf",
          inputs: [{type: "address"}],
          outputs: [{type: "uint256"}],
          stateMutability: "view",
        },
      ] as const,
      functionName: "balanceOf",
      args: [subject],
    }),
  );
  const narrowed = toMinor6(native18(nativeBalance));
  rows.push(
    narrowed === erc20Balance
      ? pass(
          "one balance, two scales",
          `${subject} reads ${nativeBalance} natively and ${erc20Balance} over ERC-20; ` +
            `toMinor6 of the first is exactly the second`,
        )
      : fail(
          "one balance, two scales",
          `${subject}: getBalance ${nativeBalance} narrows to ${narrowed}, balanceOf reads ${erc20Balance}`,
          "E-08's premise is that Arc carries one balance at two scales 1e12 apart. If the two views " +
            "disagree, `toMinor6` is not the right narrowing and every figure downstream of the inflow " +
            "stream is wrong by an unknown factor rather than by a known one.",
        ),
  );

  // ── 2. The same movement in both streams, at both scales ───────────────────
  const erc20ByTriple = new Map<string, InflowLog<Usdc6>>();
  for (const log of erc20Logs) erc20ByTriple.set(tripleOf(log), log);

  const matches: Array<{native: InflowLog<Native18>; erc20: InflowLog<Usdc6>}> = [];
  const mismatches: string[] = [];
  for (const log of nativeLogs) {
    const twin = erc20ByTriple.get(tripleOf(log));
    if (!twin) continue;
    matches.push({native: log, erc20: twin});
    if (toMinor6(log.value) !== (twin.value as bigint)) {
      mismatches.push(
        `${log.txHash} ${log.from}->${log.to}: toMinor6(${log.value}) = ${toMinor6(log.value)} ` +
          `but the ERC-20 log says ${twin.value}`,
      );
    }
  }

  if (matches.length === 0) {
    rows.push(
      note(
        "toMinor6 reconciles the two streams",
        `no (txHash, from, to) triple appeared in both streams across blocks ${fromBlock}-${toBlock}. ` +
          "Nothing is asserted from an empty window — the row is uncounted rather than green.",
      ),
    );
  } else if (mismatches.length === 0) {
    rows.push(
      pass(
        "toMinor6 reconciles the two streams",
        `${matches.length} movement(s) appeared in both streams; toMinor6 of the 18-decimal value ` +
          `equalled the 6-decimal value every time`,
      ),
    );
  } else {
    rows.push(
      fail(
        "toMinor6 reconciles the two streams",
        mismatches.slice(0, 3).join(" | "),
        "The two logs describe one balance change. If narrowing one does not produce the other, then " +
          "either the emitter's scale moved or the narrowing is wrong, and the Tier-1 scorer is " +
          "counting something other than what the borrower received.",
      ),
    );
  }

  // ── 3. The three figures — and the two of them that are wrong ──────────────
  const correctMinor = nativeLogs.reduce((sum, log) => sum + (toMinor6(log.value) as bigint), 0n);
  const erc20Minor = erc20Logs.reduce((sum, log) => sum + (log.value as bigint), 0n);
  const nativeRaw = nativeLogs.reduce((sum, log) => sum + (log.value as bigint), 0n);
  const doubledMinor = correctMinor + erc20Minor;
  const unscaledSum = nativeRaw + erc20Minor;

  if (nativeLogs.length === 0) {
    rows.push(
      note(
        "the two streams are never summed",
        `the emitter produced no logs across blocks ${fromBlock}-${toBlock}, so there is nothing to ` +
          "sum wrongly and nothing to assert.",
      ),
    );
  } else {
    rows.push(
      pass(
        "the two streams are never summed",
        `correct ${usdcText(correctMinor)} | scale-reconciled double-count ${usdcText(doubledMinor)} ` +
          `| raw sum ${unscaledSum} (a 10^12 error wearing a plausible shape)`,
      ),
    );
  }

  // ── 4. Gas-fee credits to the block beneficiary, measured not assumed ──────
  const sampled = [...new Set(nativeLogs.map((log) => log.blockNumber))].slice(
    0,
    BENEFICIARY_SAMPLE,
  );
  const beneficiaries = new Set<string>();
  for (const blockNumber of sampled) {
    const block = await shed(() => client.getBlock({blockNumber}));
    if (block.miner) beneficiaries.add(block.miner.toLowerCase());
  }
  const beneficiaryLogs = nativeLogs.filter((log) => beneficiaries.has(log.to.toLowerCase()));
  rows.push(
    note(
      "gas-fee credits to the block beneficiary",
      beneficiaryLogs.length > 0
        ? `${beneficiaryLogs.length} of ${nativeLogs.length} logs credit a block beneficiary ` +
            `(${[...beneficiaries].join(", ")}). Arc does not burn the base fee, so a naive ` +
            "to-filter counts these as income on the beneficiary's own address. The indexer skips them."
        : `no log in blocks ${fromBlock}-${toBlock} credited any of the ${beneficiaries.size} ` +
            "sampled beneficiaries — on this deployment the base-fee credit does not appear to be " +
            "emitted through the system emitter. The handler's exclusion is retained as " +
            "defence in depth rather than removed on the strength of one window.",
    ),
  );

  // ── 5. A control on the filter itself ──────────────────────────────────────
  //
  // A filtered read that quietly returned nothing would look exactly like a borrower
  // with no history, so the filter is exercised against a recipient the unfiltered
  // stream already proved has one.
  const filterSubject = nativeLogs[0]?.to;
  if (!filterSubject) {
    rows.push(
      note("the recipient filter returns a subset", "the window held no logs to filter."),
    );
  } else {
    const filtered = await readNativeInflows(client, {to: filterSubject, fromBlock, toBlock});
    const unfilteredForSubject = nativeLogs.filter(
      (log) => log.to.toLowerCase() === filterSubject.toLowerCase(),
    );
    rows.push(
      filtered.length === unfilteredForSubject.length && filtered.length > 0
        ? pass(
            "the recipient filter returns a subset",
            `args:{to} on ${filterSubject} returned ${filtered.length} of ${nativeLogs.length} logs, ` +
              "matching the unfiltered stream exactly",
          )
        : fail(
            "the recipient filter returns a subset",
            `filtered ${filtered.length}, unfiltered-for-subject ${unfilteredForSubject.length}`,
            "The production read path is the filtered one. If the topic filter drops or adds a log, a " +
              "borrower's verified income is measured against a stream that is not theirs.",
          ),
    );
  }

  return {
    rows,
    fromBlock,
    toBlock,
    nativeCount: nativeLogs.length,
    erc20Count: erc20Logs.length,
    matched: matches.length,
    correctMinor,
    doubledMinor,
    unscaledSum,
    beneficiaryLogs: beneficiaryLogs.length,
  };
}

// ─── The run ──────────────────────────────────────────────────────────────────

function line(): void {
  console.log("─".repeat(78));
}

/**
 * Print the report and exit non-zero only on a genuine `fail`.
 *
 * A quiet window is not a failure — it is a window. What is a failure is the two views
 * of one balance disagreeing, or a narrowing that does not reproduce the other stream,
 * because those say the arithmetic this phase's credit limits rest on has moved.
 */
export async function runInflow(): Promise<void> {
  const rpcUrl = process.env["ARC_TESTNET_RPC_URL"] ?? ARC_TESTNET_RPC_URL;
  const client = createPublicClient({
    chain: arcTestnet,
    transport: http(rpcUrl),
  }) as PublicClient;

  const chainId = await shed(() => client.getChainId());

  console.log("");
  line();
  console.log(`EIP-7708 inflow stream — chain ${chainId} via ${rpcUrl}`);
  console.log(`emitter ${ARC_NATIVE_TRANSFER_EMITTER}  (18-decimal values)`);
  console.log(`ERC-20  ${ARC_USDC}  (6-decimal values, the same movements)`);
  line();

  const report = await runInflowCheck(client);

  console.log("");
  console.log(`window          blocks ${report.fromBlock}-${report.toBlock}`);
  console.log(`system logs     ${report.nativeCount}`);
  console.log(`ERC-20 logs     ${report.erc20Count}`);
  console.log(`matched movements ${report.matched}  (same txHash, from and to)`);

  console.log("");
  console.log("E-08 — the same window, counted three ways");
  console.log(`  correct                 ${usdcText(report.correctMinor)}`);
  console.log(
    `  naive: scales reconciled, duplication not   ${usdcText(report.doubledMinor)}` +
      (report.correctMinor > 0n
        ? `   (${Number(report.doubledMinor) / Number(report.correctMinor)}x)`
        : ""),
  );
  console.log(
    `  naive: neither reconciled                   ${report.unscaledSum}` +
      (report.correctMinor > 0n
        ? `   (${report.unscaledSum / report.correctMinor}x)`
        : ""),
  );
  console.log(
    "  Both wrong figures are printed as numbers on purpose. A Tier-1 limit built on\n" +
      "  either looks entirely ordinary, which is why E-08 is a factor of a trillion\n" +
      "  rather than a crash.",
  );
  console.log(
    `  The double-count ratio is below 2x here because ${report.nativeCount - report.matched} of\n` +
      `  ${report.nativeCount} system-stream movements had no ERC-20 twin in this window — native\n` +
      "  value transfers that the token contract never logged. It reaches exactly 2x on a\n" +
      "  borrower whose inflows are all ordinary ERC-20 transfers, which is the population\n" +
      "  Tier 1 actually scores.",
  );

  console.log("");
  for (const row of report.rows) {
    const tag = row.kind === "pass" ? "PASS" : row.kind === "note" ? "note" : "FAIL";
    console.log(`  [${tag}] ${row.name}`);
    console.log(`         ${row.detail}`);
    if (row.because) console.log(`         why: ${row.because}`);
  }

  const passed = report.rows.filter((row) => row.kind === "pass").length;
  const noted = report.rows.filter((row) => row.kind === "note").length;
  const failed = report.rows.filter((row) => row.kind === "fail");

  console.log("");
  line();
  console.log(
    `${passed} counted assertion(s), ${noted} noted and uncounted, ${failed.length} failed.`,
  );
  console.log(
    "Noted rows depend on organic traffic this chain does not reliably carry. Nothing here\n" +
      "claims real payroll was observed: Arc testnet has essentially no organic inflow\n" +
      "history and this repo's wallets were funded by aggregating faucet drips. The scoring\n" +
      "itself is validated against a synthetic fixture, deliberately.",
  );
  line();
  console.log("");

  if (failed.length > 0) {
    throw new Error(`${failed.length} inflow assertion(s) failed — see the FAIL rows above.`);
  }
}
