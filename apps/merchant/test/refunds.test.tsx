/**
 * The refunds screen, and the one claim on it that a merchant is asked to trust.
 *
 * D9 suppresses the schedule from the **end**. That means a partial refund retires the
 * *last* installments and the borrower's next due date does not move — which is the
 * surprising half, and the half a merchant will not believe from a sentence. So the
 * screen renders the before and after schedules side by side, and these assertions are
 * about **which rows carry which status**, not about which words appear on the page.
 *
 * That is why this file renders into jsdom and queries the DOM rather than matching
 * substrings. A screen that suppressed from the *front* would contain every string a
 * screen that suppressed from the back contains — same amounts, same dates, same copy —
 * and a substring test would go green on the exact defect it was written to catch.
 *
 * Three properties, matching the plan's acceptance criteria:
 *
 * 1. The "after" schedule suppresses from the last live index, and every earlier row keeps
 *    the due date and the amount it had in "before".
 * 2. A full-value preview renders the void label.
 * 3. A zero amount disables confirmation rather than offering it.
 */

import {renderToStaticMarkup} from "react-dom/server";
import {beforeEach, describe, expect, it} from "vitest";

import {previewFor, refunds, scheduleAfter, type RefundCandidate, type Refunds as RefundsPayload} from "../app/_data";
import {Refunds} from "../app/Refunds";
import {Payouts} from "../app/Payouts";
import {Settlements} from "../app/Settlements";
import {attestations, settlements} from "../app/_data";

let data: RefundsPayload;
let candidate: RefundCandidate;

beforeEach(async () => {
  data = await refunds();
  candidate = data.candidates[0]!;
  document.body.innerHTML = "";
});

function render(props: Parameters<typeof Refunds>[0]): HTMLElement {
  document.body.innerHTML = renderToStaticMarkup(<Refunds {...props} />);
  return document.body;
}

/** Every schedule row on one side, keyed by index. */
function rowsOf(root: HTMLElement, which: "before" | "after"): Map<number, HTMLElement> {
  const side = root.querySelector(`[data-schedule="${which}"]`);
  expect(side, `the ${which} schedule must render`).not.toBeNull();
  const rows = new Map<number, HTMLElement>();
  for (const node of (side as HTMLElement).querySelectorAll("[data-index]")) {
    rows.set(Number((node as HTMLElement).dataset["index"]), node as HTMLElement);
  }
  return rows;
}

// ─────────────────────────────────────────────────────────────────────────────

describe("the partial refund preview", () => {
  it("suppresses from the last live index and moves nothing before it", () => {
    const root = render({data, planId: candidate.planId, amount: "206000000"});

    const before = rowsOf(root, "before");
    const after = rowsOf(root, "after");
    expect(after.size).toBe(before.size);

    const preview = previewFor(candidate, "206000000")!;
    const first = preview.firstSuppressedIndex!;
    // The tail, and only the tail: the boundary is the final installment.
    expect(first).toBe(candidate.schedule.length - 1);

    for (const [index, beforeRow] of before) {
      const afterRow = after.get(index)!;
      expect(afterRow.dataset["due"]).toBe(beforeRow.dataset["due"]);
      expect(afterRow.textContent).toBe(beforeRow.textContent);
      expect(afterRow.dataset["status"]).toBe(index >= first ? "suppressed" : beforeRow.dataset["status"]);
    }
  });

  it("suppresses exactly one row on this preview, and it is the last one", () => {
    const root = render({data, planId: candidate.planId, amount: "206000000"});
    const after = [...rowsOf(root, "after").entries()];
    const suppressed = after.filter(([, node]) => node.dataset["status"] === "suppressed");

    expect(suppressed.map(([index]) => index)).toEqual([candidate.schedule.length - 1]);
  });

  it("does not render the void label for a partial refund", () => {
    const root = render({data, planId: candidate.planId, amount: "206000000"});
    expect(root.querySelector("[data-void]")).toBeNull();
  });

  it("shows the four values refundPreview returns, and offers confirmation", () => {
    const root = render({data, planId: candidate.planId, amount: "206000000"});
    const confirm = root.querySelector('[data-confirm="refund"]') as HTMLButtonElement;

    expect(confirm.hasAttribute("disabled")).toBe(false);
    expect(root.textContent).toContain("Principal retired");
    expect(root.textContent).toContain("Returned to the borrower");
    expect(root.textContent).toContain("First suppressed installment");
    expect(root.textContent).toContain("MDR rebated to you");
  });
});

describe("the void", () => {
  it("renders the void label on a full-value preview", () => {
    const root = render({data, planId: candidate.planId, amount: candidate.voidAmount});
    const label = root.querySelector("[data-void]");

    expect(label).not.toBeNull();
    expect(label?.textContent).toMatch(/full-value refund before fulfilment/i);
  });

  it("suppresses the whole remaining tail, leaving what the borrower already cleared", () => {
    const root = render({data, planId: candidate.planId, amount: candidate.voidAmount});
    const after = rowsOf(root, "after");
    const preview = previewFor(candidate, candidate.voidAmount)!;

    expect(preview.isVoid).toBe(true);
    expect(after.get(0)?.dataset["status"]).toBe("cleared");
    for (let index = preview.firstSuppressedIndex!; index < candidate.schedule.length; index++) {
      expect(after.get(index)?.dataset["status"]).toBe("suppressed");
    }
  });

  it("offers the void as its own action carrying voidAmountFor's answer", () => {
    const root = render({data, planId: candidate.planId, amount: undefined});
    const button = root.querySelector('[data-action="void"]') as HTMLButtonElement;

    expect(button).not.toBeNull();
    expect(button.getAttribute("value")).toBe(candidate.voidAmount);
    expect(button.getAttribute("name")).toBe("amount");
  });
});

describe("confirmation", () => {
  it("is disabled on a zero amount rather than submitting", () => {
    const root = render({data, planId: candidate.planId, amount: "0"});
    const confirm = root.querySelector('[data-confirm="refund"]') as HTMLButtonElement;

    expect(confirm.hasAttribute("disabled")).toBe(true);
    expect(root.textContent).toMatch(/A zero refund does nothing/);
    expect(root.querySelector("[data-schedule]")).toBeNull();
  });

  it("is disabled when no preview exists for the amount, and says why", () => {
    const root = render({data, planId: candidate.planId, amount: "12345"});
    const confirm = root.querySelector('[data-confirm="refund"]') as HTMLButtonElement;

    expect(confirm.hasAttribute("disabled")).toBe(true);
    // `data` is the sampled payload, so the honest reason is a missing address and not a
    // missing deployment: 06-13 deployed RefundEscrow at 0x901BF45C…, and copy still
    // saying it does not exist would send a merchant to chase a contract that is on chain.
    expect(root.textContent).toMatch(/no RefundEscrow address is configured here/);
    expect(root.textContent).not.toMatch(/not deployed/);
  });

  it("says something different when the payload is live and the amount was simply not asked about", () => {
    const root = render({data: {...data, live: true, sampled: ""}, planId: candidate.planId, amount: "12345"});
    const confirm = root.querySelector('[data-confirm="refund"]') as HTMLButtonElement;

    expect(confirm.hasAttribute("disabled")).toBe(true);
    expect(root.textContent).toMatch(/was not asked about/);
    expect(root.textContent).toMatch(/Submit the amount again/);
    // Still never a preview the merchant did not see. The confirm stays disabled either way.
    expect(root.querySelector("[data-schedule]")).toBeNull();
  });

  it("is disabled before an amount is chosen at all", () => {
    const root = render({data, planId: candidate.planId, amount: undefined});
    const confirm = root.querySelector('[data-confirm="refund"]') as HTMLButtonElement;
    expect(confirm.hasAttribute("disabled")).toBe(true);
  });
});

describe("scheduleAfter, under the screen", () => {
  it("agrees with what the screen rendered", () => {
    const preview = previewFor(candidate, "206000000")!;
    const computed = scheduleAfter(candidate.schedule, preview);
    const rendered = rowsOf(render({data, planId: candidate.planId, amount: "206000000"}), "after");

    for (const row of computed) {
      expect(rendered.get(row.index)?.dataset["status"]).toBe(row.status);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The other two screens from this task, asserted on the properties they exist for.
// ─────────────────────────────────────────────────────────────────────────────

describe("Settlements", () => {
  it("leads every row with the merchant's own order id", async () => {
    const book = await settlements();
    document.body.innerHTML = renderToStaticMarkup(<Settlements data={book} filter={{}} />);

    const first = document.body.querySelector("tbody tr td");
    expect(first?.textContent).toBe("A-10432");
    expect(document.body.textContent).toContain("Your order");
  });

  it("prints the MDR arithmetic and marks whether it balances", async () => {
    const book = await settlements();
    document.body.innerHTML = renderToStaticMarkup(<Settlements data={book} filter={{}} />);

    const lines = [...document.body.querySelectorAll("[data-arithmetic]")];
    expect(lines.length).toBe(book.settlements.length);
    for (const line of lines) {
      expect((line as HTMLElement).dataset["arithmetic"]).toBe("balances");
      expect(line.textContent).toMatch(/\$[\d,]+\.\d\d − \$[\d,]+\.\d\d − \$[\d,]+\.\d\d = \$[\d,]+\.\d\d/);
    }
  });

  it("flags a row whose arithmetic does not close, rather than printing it as fact", async () => {
    const book = await settlements();
    const broken = {
      ...book,
      settlements: [{...book.settlements[0]!, net: "1"}],
    };
    document.body.innerHTML = renderToStaticMarkup(<Settlements data={broken} filter={{}} />);

    const line = document.body.querySelector("[data-arithmetic]") as HTMLElement;
    expect(line.dataset["arithmetic"]).toBe("broken");
    expect(line.textContent).toMatch(/does not balance/);
  });
});

describe("Payouts", () => {
  it("names receiveMessage and offers the message and attestation as downloads", async () => {
    const book = await settlements();
    const attested = await attestations([]);
    document.body.innerHTML = renderToStaticMarkup(
      <Payouts settlements={book} attestations={attested} />,
    );

    expect(document.body.textContent).toContain(
      "MessageTransmitterV2.receiveMessage(message, attestation)",
    );
    const downloads = [...document.body.querySelectorAll("a[download]")];
    expect(downloads.length).toBe(2);
    for (const link of downloads) {
      expect(link.getAttribute("href")).toMatch(/^data:text\/plain;charset=utf-8,/);
    }
  });

  it("says that Plazo cannot do it and that anyone else can", async () => {
    const book = await settlements();
    const attested = await attestations([]);
    document.body.innerHTML = renderToStaticMarkup(
      <Payouts settlements={book} attestations={attested} />,
    );

    expect(document.body.textContent).toMatch(/no gas token on any chain but Arc/);
    expect(document.body.textContent).toMatch(/destinationCaller.{0,40}zero address/s);
  });

  it("identifies a burn by transaction hash and prints no nonce anywhere", async () => {
    const book = await settlements();
    const attested = await attestations([]);
    document.body.innerHTML = renderToStaticMarkup(
      <Payouts settlements={book} attestations={attested} />,
    );

    expect(document.body.textContent).toContain("Burn tx");
    expect(document.body.textContent?.toLowerCase()).not.toContain("nonce");
  });

  it("keeps the origination hash and the burn hash as separate rows (DEC-51)", async () => {
    const book = await settlements();
    const attested = await attestations([]);
    document.body.innerHTML = renderToStaticMarkup(
      <Payouts settlements={book} attestations={attested} />,
    );

    const dispatched = book.settlements.find((s) => s.dispatchTxHash !== null)!;
    const text = document.body.textContent ?? "";
    expect(text).toContain(dispatched.txHash!);
    expect(text).toContain(dispatched.dispatchTxHash!);
    expect(dispatched.txHash).not.toBe(dispatched.dispatchTxHash);
  });
});
