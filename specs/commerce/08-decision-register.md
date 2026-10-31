# 08 — Decision Register

> Status: **partly decided** · last updated **2026-10-31** (TD-07 and TD-08 approved by Youssef and implemented, `25` §9; FD-03 position recorded, still pending Ibrahim). Earlier passes: 2026-10-25 (gap-closure pass: status vocabulary, BD-31–BD-34, FD-24–FD-25, TD-17–TD-18, SD-07–SD-09, operational owners OD-01–OD-08, requirement traceability §8; v6 pass: BD-35, FD-26–FD-27, TD-19–TD-20, SD-10, RFD / NTF / HLD requirements, TD-13 caveat, FD-11 severity provenance). Full decision-level traceability: `16-traceability-matrix.md`. "Recommended" values are proposals, labelled as such; the design uses them only as configurable defaults until approved. **No decision was approved in the 2026-10-25 passes**; every item added then is pending its approver.

## 1. Approvers, statuses, categories

- **Approvers (TQ-00, resolved 2026-10-24):** **BD** (business) and **FD** (financial) → **Ibrahim**. **TD** (technical) and **SD** (security) → **Youssef**. **OD** (operational ownership, new) → the approver named on each row: Ibrahim names business owners, Youssef names technical owners. An accountant's review is advisable for FD items.
- **Status values** (one per decision):

  | Status | Meaning |
  |---|---|
  | **APPROVED** / **CONDITIONALLY APPROVED** | decided by the authorized approver, with date and conditions |
  | **REJECTED** | decided against by the authorized approver (none so far) |
  | **PENDING YOUSSEF** | waiting for the technical/security approver |
  | **PENDING IBRAHIM** | waiting for the business/financial approver; *(proposed)* marks items where a position was put forward by Youssef or by a brief |
  | **DEFERRED** | consciously not needed for the MVP; revisit later. **Deferred ≠ rejected:** a deferred capability stays in the architecture and is built later (e.g. PAYMOB, TD-21); only REJECTED removes it |
  | **BLOCKED UNTIL …** | cannot be decided until a fact or an earlier decision exists (named on the row) |

- **Severity** (separate column): **BLOCKING** — the gated phase cannot safely start; **IMPORTANT** — buildable behind configuration with the recommended default, but must be confirmed before that phase goes to production.
- Earlier labels map as follows: "OPEN" → PENDING (approver), "PROPOSED — awaiting Ibrahim" → PENDING IBRAHIM *(proposed)*, "POSTPONED" (TD-13) → APPROVED (the decision *was* to postpone).

## 2. What still blocks Phase 0

Phase 0 = safety hardening of today's checkout / cancel / stock code (`README.md` roadmap); the Paymob-specific hardening moved to the PAYMOB activation milestone on 2026-10-27 (TD-21 — deferred, not rejected). It does not depend on any business decision about custody, pricing or fulfilment.

### 2.1 Blocks the **start** of Phase 0 coding (approver: Youssef unless noted)
| ID | Decision | Why it blocks Phase 0 code |
|---|---|---|
| TD-04 | Extend `AdminAuditLog` (nullable actor, actor type, source, before/after state, correlation id) | schema shape of every audited action written in Phase 0 |
| TD-06 | Transactional outbox with per-consumer deliveries and leases; inline processing after commit is only an optimisation — recovery by boot sweep, piggy-back drain, admin drain and the operator schedule (TD-18) (`01` §7) | Phase 0 writes outbox rows for payment exceptions and expiries |
| TD-07 | Versioning and the `Idempotency-Key` compatibility window | changes the checkout contract — **resolved 2026-10-31** (approved + implemented, §3 row below) |
| TD-08 | Vendor stock API becomes delta / compare-and-set | breaking change to a vendor route — **resolved 2026-10-31** (approved + implemented, §3 row below) |
| TD-12 | Test-only race hooks | the concurrency suite required by TD-01 depends on them |
| FD-01 | Money representation (minor units, `Int` vs `BigInt`, currency precision) — **Ibrahim + Youssef** | Phase 0 adds `totalMinor` / `amountMinor` columns |

*Status 2026-10-31:* TD-07 and TD-08 are approved and implemented; TD-06 is implemented under the G-R0 instruction (formal status for Youssef to confirm, §3); **TD-04, TD-12 and FD-01 remain open.**

### 2.2 Blocks Phase 0 **production go-live** (code can be written and tested first)
| ID | Decision / fact | Approver / owner |
|---|---|---|
| TD-13 | Deployment requirements while workers are postponed (`01-target-architecture.md` §13) — someone must own the manual cadences | Youssef |
| BD-07 | Payment / reservation windows (defaults configured) | Ibrahim |
| ~~BD-17~~ | *Moved 2026-10-27:* late payment matters only once a payment method is live (Phase 3b for late transfers, PAYMOB activation for Paymob); still **pending Ibrahim**, no longer a Phase 0 go-live blocker | Ibrahim (**kept pending**) |
| MNT-01 – MNT-18 | Scheduled reservation maintenance in production (requirement confirmed 2026-10-27; mechanism TD-18, proposed every 10 min with schedule reconciliation; MNT-07 – MNT-18 are proposals under TD-18 / TD-23; worker supervision MNT-17 blocked by TQ-16 / TQ-28; throughput MNT-18 not measured) | Youssef |
| TQ-07 | Production backup / point-in-time recovery | Youssef |
| TQ-12 | Raw-SQL demo "paid" rows in production? | Youssef |
| TD-18 | Scheduled maintenance mechanism — proposed 2026-10-27: BullMQ scheduler + dedicated reservation-expiration worker every 10 min (`21` §8.1 – §8.7); **pending** | Youssef |
| TD-22 | Scoped TD-13 amendment permitting only that worker (C33); **pending** | Youssef |
| TD-23 | Worker architecture for the outbox drain (and later reconciliation runs); **pending** | Youssef |
| TQ-16, TQ-27, TQ-28, TQ-33 | Facts to verify: always-on host and worker supervision (`21` §8.8 — `render.yaml` declares only a free web service); Redis Cloud eviction / persistence / capacity (`21` §8.3 evidence list); host process supervision; alert evaluation and delivery tool (`21` §8.6) | Youssef |
| OD-01, OD-02, OD-07, OD-08 | Named owners: daily maintenance, outbox recovery, backup monitoring, incident response | Youssef (+ Ibrahim for OD-08) |

### 2.3 Decided for Phase 0
TD-01 (conditional), TD-02, TD-03, TD-13 (postponed, alternatives documented), TQ-00.

**Decided 2026-10-27 for later phases** (Ibrahim, as reported by Youssef — the approval source is Youssef's message of 2026-10-27; a written confirmation from Ibrahim should be attached to this register when available): BD-24, BD-25 (revised), BD-36, BD-37, BD-38, BD-39, BD-40, FD-02 (with the dynamic-markup condition), FD-21, FD-29. None of them unblocks Phase 0.

### 2.4 Production launch
Phase 0 go-live means deploying the hardened code; it does **not** mean taking real customer orders. Real commerce in production is allowed only when the production readiness gate PRG-01–PRG-14 passes (`10-acceptance-criteria.md` §6) — every phase 0–7 exited, every BLOCKING decision for those phases approved, every OD owner named. BD-33 records the business consequence for Ibrahim.

Everything else belongs to later phases (§3).

## 3. Summary

| ID | Decision | Status | Severity | Gates | Approver |
|---|---|---|---|---|---|
| **Business** ||||||
| BD-01 | Riven takes physical custody of marketplace stock, and from when | PENDING IBRAHIM | BLOCKING | Phase 2, 4 | Ibrahim |
| BD-02 | Riven fulfils all marketplace orders (vendors stop shipping), from what date | PENDING IBRAHIM | BLOCKING | Phase 4 | Ibrahim |
| BD-03 | Legal ownership of goods in Riven's warehouse (consignment?) | PENDING IBRAHIM | BLOCKING | Phase 2 | Ibrahim (+ legal) |
| BD-04 | Return and refund policy | PENDING IBRAHIM | BLOCKING | Phase 7, FD-03; production returns (RET-02) | Ibrahim (+ legal) |
| BD-05 | Refused-COD handling and refusal limit | PENDING IBRAHIM | IMPORTANT | Phase 4 | Ibrahim |
| BD-06 | Maximum transfer-proof attempts | PENDING IBRAHIM | IMPORTANT | Phase 3 | Ibrahim |
| BD-07 | Payment and reservation windows | PENDING IBRAHIM — *v7 Part Four: Youssef proposes **30 minutes** for InstaPay / wallet proof submission (earlier recommendation 2 h); resubmission window still to set* (`21` §3) | IMPORTANT | Phase 0 go-live, 3, 4 | Ibrahim |
| **BD-08** | Stock must be **physically received and verified** before it is sold | PENDING IBRAHIM *(proposed by Youssef 2026-10-24; design baseline)* | BLOCKING | Phase 1b, 2, 3 | Ibrahim |
| BD-09 | Multiple shipments per order group | PENDING IBRAHIM | IMPORTANT | Phase 4 | Ibrahim |
| BD-10 | Vendor settlement / statement dispute workflow | PENDING IBRAHIM | BLOCKING | Phase 6 | Ibrahim |
| BD-11 | Delivery address required for PAYMOB orders | PENDING IBRAHIM | IMPORTANT | Phase 3 | Ibrahim |
| BD-12 | Vendor types in scope | PENDING IBRAHIM | IMPORTANT | Phase 3, 4 | Ibrahim |
| BD-13 | COD confirmation call mandatory, and its window | PENDING IBRAHIM | IMPORTANT | Phase 4 | Ibrahim |
| BD-14 | COD for every vendor; maximum COD order value | PENDING IBRAHIM | IMPORTANT | Phase 4 | Ibrahim |
| **BD-15** | Roadmap order: transfers/COD go live **only after** custody + intake (strict 0 → 1 → 2 → 3) | PENDING IBRAHIM *(proposed by Youssef 2026-10-24; design baseline)* | BLOCKING | roadmap | Ibrahim |
| BD-16 | Partial delivery / partial acceptance | DEFERRED | — | — | Ibrahim |
| BD-17 | Late payment after cancellation: refund or revive; cancel allowed while paying | PENDING IBRAHIM (**kept pending** by Youssef 2026-10-24 and 2026-10-27) — the refund outcome in the design is a **recommendation only**, not an approved rule | IMPORTANT | Phase 3b (late transfers), PAYMOB activation (PMA-05) — *moved from "Phase 0 go-live" 2026-10-27: no payment method is live in production in Phase 0* | Ibrahim |
| BD-18 | Stock hold when a transfer proof waits past the cap | PENDING IBRAHIM — *v7 Part Four proposal: keep the reservation active while a timely proof awaits review (escalate, do not release); earlier recommendation was release at the 72 h cap and re-reserve on approval* (`21` §3.2) | IMPORTANT | Phase 3 | Ibrahim |
| BD-19 | Proof review SLA and escalation | PENDING IBRAHIM | IMPORTANT | Phase 3 | Ibrahim |
| BD-20 | What confirms delivery (ops, courier, shopper) | PENDING IBRAHIM | IMPORTANT | Phase 4 | Ibrahim |
| BD-21 | Multiple warehouses | DEFERRED | — | — | Ibrahim |
| BD-22 | Courier API integration | DEFERRED | — | — | Ibrahim |
| BD-23 | Notification channels | DEFERRED | — | — | Ibrahim |
| BD-24 | Is accepted intake stock sellable at Riven's verification, or only after the vendor acknowledges? | **APPROVED** 2026-10-27 (Ibrahim, reported by Youssef) — answered by BD-36 / BD-37: sellable once a single admin approves the line; the vendor's acknowledgment is not awaited; only a disputed accepted quantity is frozen | — | Phase 2 | Ibrahim |
| BD-25 | Vendor intake response window; silence = acknowledgment? | **APPROVED (revised)** 2026-10-27 (Ibrahim, reported by Youssef) — *changed from "the vendor responds to every intake within 7 days" to "**acknowledgment is required only when quantities differ**"* (`19` §10); the deadline and consequence of no acknowledgment moved to BD-41 | — | Phase 2 | Ibrahim |
| BD-26 | What vendors see: customer price, Riven margin, delivery fee per order | PENDING IBRAHIM | IMPORTANT | Phase 4, 6 | Ibrahim |
| BD-27 | Do vendors see orders before they are paid/confirmed? | PENDING IBRAHIM | IMPORTANT | Phase 4 | Ibrahim |
| BD-28 | Statement period (monthly), cut-off time zone, issue day | PENDING IBRAHIM | IMPORTANT | Phase 6 | Ibrahim |
| BD-29 | Vendor payout-receipt response window; silence = full receipt? | PENDING IBRAHIM | IMPORTANT | Phase 6 | Ibrahim |
| BD-30 | Delivery zones: granularity (governorate / city / district) and unserved areas | PENDING IBRAHIM | BLOCKING | Phase 3 | Ibrahim |
| BD-31 | Vendor commerce restriction levels separate from suspension (`commerceRestriction`: NONE / NO_NEW_LISTINGS / NO_NEW_SALES / PAYOUT_HOLD) — conflicts with the closed admin decision "reject = suspend" (C21) | PENDING IBRAHIM *(proposed in the 2026-10-25 gap-closure pass)* | IMPORTANT | Phase 4, 6 | Ibrahim |
| BD-32 | Restricted, suspended, deactivated or terminated vendors keep access to their financial history and payout confirmation | PENDING IBRAHIM *(proposed)* | BLOCKING | Phase 6 | Ibrahim |
| BD-33 | Production launch only after Phases 0–7 and the readiness gate (PRG) — business acceptance of the timeline (no real customer orders before then) | PENDING IBRAHIM *(gate required by Youssef's 2026-10-25 brief)* | BLOCKING | production launch | Ibrahim |
| BD-34 | Show or hide products whose verified stock is 0 (e.g. after cutover, before first intake) | PENDING IBRAHIM | IMPORTANT | Phase 1b | Ibrahim |
| BD-35 | MVP commerce notification channels and which notices are mandatory (in-app + staff queues; push / e-mail when a provider exists; no SMS / WhatsApp) — narrower than BD-23, which stays DEFERRED (C25) | PENDING IBRAHIM *(proposed v6)* | IMPORTANT | Phase 3b (in-app), production (e-mail for security notices) | Ibrahim |
| BD-36 | Intake **partial approval**: accepted quantities of a line are approved without waiting for missing / damaged / disputed quantities to be resolved | **APPROVED** 2026-10-27 (Ibrahim, reported by Youssef) | — | Phase 2 | Ibrahim |
| BD-37 | Vendor dispute **freeze applies only to the disputed accepted quantity**; undisputed accepted units stay sellable; damaged / missing / rejected / pending units never sellable; no automated financial hold | **APPROVED** 2026-10-27 (Ibrahim, reported by Youssef) | — | Phase 2 | Ibrahim |
| BD-38 | **Single authorized admin approval** for intake lines, intake disputes and inventory adjustments in the MVP; vendors never approve; dual approval and thresholds DEFERRED (C27) | **APPROVED** 2026-10-27 (Ibrahim, reported by Youssef) | — | Phase 2 | Ibrahim |
| BD-39 | Stock withdrawals need **4 days' prior notice** before Riven begins processing | **APPROVED** 2026-10-27 (Ibrahim, reported by Youssef as an existing rule; not previously documented) | — | Phase 2 | Ibrahim |
| BD-40 | Handover acknowledgment only when quantities differ, for **both** inbound intake and outbound withdrawal; acknowledgment ≠ liability ≠ resolution; no courier acknowledgment in vendor transfers | **APPROVED** 2026-10-27 (Ibrahim, reported by Youssef) | — | Phase 2 | Ibrahim |
| BD-41 | Deadlines: how long a vendor has to acknowledge a discrepancy and to dispute an intake line; what happens if they do not; how long Riven has to resolve; whether "4 days" are calendar or business days | PENDING IBRAHIM | IMPORTANT | Phase 2 | Ibrahim |
| BD-42 | Over-delivery: units received beyond the requested quantity (recommended: recorded on a linked supplementary intake) | PENDING IBRAHIM | IMPORTANT | Phase 2 | Ibrahim |
| BD-43 | When to activate PAYMOB in production (after PMA-01 – PMA-08 and BD-17) | PENDING IBRAHIM *(2026-10-27)* | IMPORTANT | PAYMOB activation | Ibrahim |
| **Financial** ||||||
| FD-01 | Money representation and currency precision | PENDING IBRAHIM + YOUSSEF | BLOCKING (Phase 0 start) | Phase 0, 3 | Ibrahim + Youssef |
| **FD-02** | Riven earns a **markup on the vendor rate** (currently 6 %), paid by the customer on top; no commission deducted from the vendor; no other per-item fee unless decided | **APPROVED** 2026-10-27 (Ibrahim, reported by Youssef) — *condition: the percentage is a variable that will become dynamic (FD-28); 6 % is only the current value* | — | Phase 3 (prices), 4 (postings) | Ibrahim |
| FD-03 | Vendor payout eligibility and cycle | PENDING IBRAHIM — *2026-10-31: new input "vendors are paid after 15 days"; Youssef's position: the 15 days start at **delivery** (never before COD cash is reconciled), recorded, not approved (`25` §5 D3)* | BLOCKING | Phase 6 | Ibrahim |
| FD-04 | Delivery fee pricing: **location-based zones** configured by authorized admins | PENDING IBRAHIM *(proposed by the 2026-10-25 brief; zones and amounts open)* — *v7: no longer blocks Phase 3 because the temporary flat fee FD-29 is approved; remains the target model* | IMPORTANT (was BLOCKING before FD-29) | Phase 3+ | Ibrahim |
| FD-05 | Transfer over/underpayment; COD short collection | PENDING IBRAHIM | BLOCKING | Phase 3 | Ibrahim |
| FD-06 | Partial courier remittances | PENDING IBRAHIM · BLOCKED UNTIL courier contract (TQ-04) | IMPORTANT | Phase 5 | Ibrahim |
| FD-07 | Liability for loss and damage | PENDING IBRAHIM | BLOCKING | Phase 2 | Ibrahim |
| FD-08 | Who pays delivery, return and failed-delivery costs | PENDING IBRAHIM | BLOCKING | Phase 4 | Ibrahim |
| FD-09 | Partial payouts | PENDING IBRAHIM | IMPORTANT | Phase 6 | Ibrahim |
| FD-10 | Courier remittance frequency and deductions | PENDING IBRAHIM · BLOCKED UNTIL courier contract (TQ-04) | IMPORTANT | Phase 5 | Ibrahim |
| FD-11 | Vendor negative balances (clawback, recovery, write-off) | PENDING IBRAHIM | BLOCKING — *severity raised from IMPORTANT in the 2026-10-25 documentation pass (returns after payout create negative balances, AT-FIN-07); the raise is a documentation proposal awaiting Ibrahim's confirmation together with the decision itself* | Phase 6, 7 | Ibrahim |
| FD-12 | Paymob refunds via API | DEFERRED · BLOCKED UNTIL TD-13 is revisited | — | — | Ibrahim |
| FD-13 | Automated vendor payouts | DEFERRED | — | — | Ibrahim |
| FD-14 | Cancellation after payment, before shipping | PENDING IBRAHIM | IMPORTANT | Phase 3 | Ibrahim |
| FD-15 | Multi-currency / FX | DEFERRED | — | — | Ibrahim |
| FD-16 | Opening balances if real money exists | PENDING IBRAHIM · BLOCKED UNTIL the production data check (TQ-12) | IMPORTANT | Phase 3 | Ibrahim |
| FD-17 | Existing `basePrice` / `priceOverride`: reinterpret as vendor rate (customer prices rise by the markup) or as today's customer price | PENDING IBRAHIM | BLOCKING | Phase 3 | Ibrahim |
| FD-18 | Delivery fee: Riven revenue (gross) or pass-through owed to the courier | PENDING IBRAHIM | BLOCKING | Phase 4 (postings) | Ibrahim |
| FD-19 | On refunds/returns, is Riven's markup refunded with the item? | PENDING IBRAHIM | BLOCKING | Phase 7; production returns (RET-02) | Ibrahim |
| FD-20 | Markup rounding rule and allowed precision of the percentage | PENDING IBRAHIM + YOUSSEF | IMPORTANT | Phase 3 | Ibrahim + Youssef |
| FD-21 | Price changes between cart and checkout: confirm-then-charge rule | **APPROVED** 2026-10-27 (Ibrahim, reported by Youssef) — immediate cart price update with per-item `UNCHANGED → CHANGED → REVIEWED` acknowledgment; checkout refuses unreviewed changes (`20`). *The brief named it "FD-17 Option C"; FD-17 itself stays open (C30)* | — | Phase 3 | Ibrahim |
| FD-22 | Payout discrepancies: who bears bank/transfer fees; resolution options | PENDING IBRAHIM | BLOCKING | Phase 6 | Ibrahim |
| FD-23 | Does a change of `RIVEN_PROFIT_PERCENTAGE` need business approval and an effective date? | PENDING IBRAHIM | IMPORTANT | Phase 3 | Ibrahim |
| FD-24 | Partial refunds: amount rules and the split between vendor payable and Riven margin (incl. after payout) | PENDING IBRAHIM *(proposed)* | BLOCKING | Phase 3b (exception refunds), 7 | Ibrahim |
| FD-25 | Goods lost or damaged in courier custody: who compensates the vendor, and recovery from the courier | PENDING IBRAHIM *(proposed)* | BLOCKING | Phase 4, 5 | Ibrahim |
| FD-26 | Customer refund destination policy: original instrument first; allowed destination types; third-party destinations; what happens to refunds that cannot be delivered (`15`) | PENDING IBRAHIM *(proposed v6)* | BLOCKING | Phase 3b | Ibrahim (+ legal, TQ-30) |
| FD-27 | Business authority and limits for holding outbound money: who may hold vendor payouts / customer refunds, maximum duration before escalation, communication to the affected party (`07` §14) | PENDING IBRAHIM *(proposed v6)* | IMPORTANT | Phase 3b, 6 | Ibrahim |
| FD-28 | What "dynamic markup" means: runtime admin setting? per category / vendor / product? effective dates and who approves a change? | PENDING IBRAHIM *(follows from FD-02's condition)* | IMPORTANT | Phase 3a design, later | Ibrahim |
| FD-29 | Temporary **flat delivery fee 80.00 EGP per order**, separate from the markup, never marked up; replaced later by zones (FD-04) | **APPROVED** 2026-10-27 (Ibrahim, reported by Youssef) | — | Phase 3 | Ibrahim |
| **Technical** (approver Youssef) ||||||
| TD-01 | Isolation per workflow: Read Committed + locks where proven safe; Serializable retained where necessary | **CONDITIONALLY APPROVED** 2026-10-24 | — | Phase 0 | Youssef |
| TD-02 | DB triggers and partial indexes | **APPROVED** 2026-10-24 | — | Phase 0 | Youssef |
| TD-03 | Mandatory audit inside the transaction for sensitive financial and inventory operations | **APPROVED** 2026-10-24 | — | Phase 0 | Youssef |
| TD-04 | Extend `AdminAuditLog` | PENDING YOUSSEF | BLOCKING (Phase 0 start) | Phase 0 | Youssef |
| TD-05 | BigInt amounts as strings in JSON | PENDING YOUSSEF | IMPORTANT | Phase 3 | Youssef |
| TD-06 | Transactional outbox with per-consumer deliveries, leases and the recovery paths of `01` §7 (inline processing is an optimisation only) | PENDING YOUSSEF — **implemented 2026-10-29 under the G-R0 "approve all" instruction** (`23` §12, `25` §9); formal APPROVED status for Youssef to confirm | BLOCKING (Phase 0 start) | Phase 0 | Youssef |
| TD-07 | Versioning + `Idempotency-Key` window | **APPROVED** 2026-10-31 (Youssef, `25` §5): `Idempotency-Key` **optional** on today's `POST /checkout` (honoured when sent; old clients keep working), required on `/v1` — **implemented 2026-10-31** (slice S4, `25` §9; `/v1` not built yet) | — | Phase 0 | Youssef |
| TD-08 | Vendor stock API delta / CAS | **APPROVED** 2026-10-31 (Youssef, `25` §5): **delta + reason** (`{ change, reason }`), refused below zero, every change an `InventoryMovement` (VENDOR_ADJUSTMENT); compare-and-set rejected — **implemented 2026-10-31** (slice S3, `25` §9: `POST …/stock-adjustments`, `inventory_movements` ledger) | — | Phase 0 | Youssef |
| TD-09 | Inventory cutover gate | PENDING YOUSSEF | IMPORTANT | Phase 1 | Youssef |
| TD-10 | Conditions to drop legacy Paymob columns | DEFERRED | — | — | Youssef |
| TD-11 | OpenAPI + shared contract package | PENDING YOUSSEF | IMPORTANT | multi-client | Youssef |
| TD-12 | Test-only race hooks | PENDING YOUSSEF | BLOCKING (Phase 0 start) | Phase 0 | Youssef |
| TD-13 | Background workers postponed; temporary alternatives in `01` §13 | **APPROVED** 2026-10-24 (implementation postponed) — *2026-10-27: TD-18's proposal would add one dedicated reservation-expiration worker; TD-13 stays as recorded; the scoped amendment is the separate decision TD-22 (pending, C33)* — *the approval is of the postponement only; it does **not** mean production can run without the recovery mechanisms: R-D1–R-D7, TD-18 (scheduled drain), OBX-05/06 and PRG-03 remain required, and PAYMOB stays disabled* | — | Phase 0 go-live | Youssef |
| TD-14 | Customer price: computed on read vs materialized on the variant; search re-index on percentage change | PENDING YOUSSEF | IMPORTANT | Phase 3 | Youssef |
| TD-15 | Record each effective `RIVEN_PROFIT_PERCENTAGE` in a pricing-config history table at boot | PENDING YOUSSEF | IMPORTANT | Phase 3 | Youssef |
| TD-16 | Vendor portal read model: direct SQL over source tables with polling (no materialized views / websockets in MVP) | PENDING YOUSSEF | IMPORTANT | Phase 1–6 | Youssef |
| TD-17 | Runtime database role without table ownership (cannot disable triggers or alter tables); migrations run under a separate owner role | PENDING YOUSSEF *(proposed)* | BLOCKING | production launch (PRG-10) | Youssef |
| TD-18 | Mechanism for scheduled maintenance runs — **proposed option: BullMQ + Redis scheduler (fixed id, with schedule reconciliation), dedicated reservation-expiration worker, PostgreSQL as source of truth, `MaintenanceRun` records, PostgreSQL-based alerts**, every **10 min** (changed from 5 min on 2026-10-27) (`21` §8.1 – §8.7) | PENDING YOUSSEF — **implemented 2026-10-29 under the G-R0 "approve all" instruction** (`23` §12, `25` §9); formal APPROVED status for Youssef to confirm — *requirement confirmed 2026-10-27 (MNT-01 – MNT-06); option **selected and proposed by Youssef 2026-10-27**; formal approval pending; the dedicated worker also needs TD-22 (C33)* | BLOCKING | Phase 0 go-live | Youssef |
| TD-19 | Financial holds: workflow-level and entity-level holds on outbound / irreversible money actions, L0 control rows, two-person lift; **no global freeze of facts** (`07` §14) | PENDING YOUSSEF *(proposed v6; replaces the v5 `FINANCE_FREEZE` idea)* | IMPORTANT | Phase 3b | Youssef |
| TD-20 | Notification delivery providers and integration: in-app first; Expo push (needs a mobile release); e-mail provider; effect rows (`notifications-module-spec2.md`) | PENDING YOUSSEF *(proposed v6)* | IMPORTANT | Phase 3b, production | Youssef |
| TD-21 | PAYMOB is **deferred, not rejected**: kept in the architecture, payment-method model and existing code; disabled in production; its new flows (attempt lifecycle, inbox processing, reconciliation, late-success recovery, legacy projection) move from Phase 0 to a later **PAYMOB activation milestone** gated by PMA-01 – PMA-08 (C31) | **APPROVED** 2026-10-27 (Youssef's written instruction) — scope / sequencing only; the business outcome of late payments stays BD-17 (pending) and the activation date BD-43 (pending) | — | Phase 0 scope; PAYMOB activation | Youssef |
| TD-22 | Scoped amendment to TD-13: permit **one** dedicated worker process type — the TD-18 reservation-expiration worker (expiry job + its schedule reconciler) — and nothing else (`21` §8.4) | PENDING YOUSSEF — **implemented 2026-10-29 under the G-R0 "approve all" instruction** (`23` §12, `25` §9); formal APPROVED status for Youssef to confirm *(proposed 2026-10-27; resolves C33 when decided; TD-13's record and history unchanged)* | IMPORTANT | Phase 0 go-live | Youssef |
| TD-23 | Worker architecture for outbox drain and reconciliation runs: separate queues per responsibility, independent concurrency / retry / monitoring, possibly sharing one process (`21` §8.5) | PENDING YOUSSEF — **implemented 2026-10-29 under the G-R0 "approve all" instruction** (`23` §12, `25` §9); formal APPROVED status for Youssef to confirm *(Youssef's stated preference 2026-10-27; not approved)* | IMPORTANT | Phase 0 go-live (outbox), Phase 3b+ (reconciliation) | Youssef |
| TD-24 | Retention period for `MaintenanceRun` rows (operational audit record in PostgreSQL, independent of BullMQ job cleanup; `21` §8.3.1) | PENDING YOUSSEF *(added 2026-10-27; proposal: at least 12 months, not approved; nothing deleted until decided)* | IMPORTANT | before any purge of `maintenance_runs` | Youssef |
| **Security** (approver Youssef; people assignments Ibrahim) ||||||
| SD-01 | Staff permissions, maker-checker list, who holds FINANCE_APPROVER | PENDING YOUSSEF (+ Ibrahim for people) | BLOCKING | Phase 3 | Youssef (+ Ibrahim for people) |
| SD-02 | Self-dealing rule for staff | PENDING YOUSSEF | IMPORTANT | Phase 3 | Youssef |
| SD-03 | Refresh-token sessions per device and reuse grace | PENDING YOUSSEF | IMPORTANT | multi-client | Youssef |
| SD-04 | Web token storage (httpOnly cookie + CSRF) | PENDING YOUSSEF | IMPORTANT | web launch | Youssef |
| SD-05 | Retention of proof images, payout receipts and snapshots | PENDING YOUSSEF + IBRAHIM | IMPORTANT | Phase 3 | Youssef + Ibrahim |
| SD-06 | Storage and protection of vendor payout destination details (bank account / InstaPay / wallet) | PENDING YOUSSEF | BLOCKING | Phase 6 | Youssef |
| SD-07 | Payout-account change controls: re-verification, notification of both old and new contact, cooling-off before first payout, re-authentication | PENDING YOUSSEF *(proposed)* | BLOCKING | Phase 6 | Youssef |
| SD-08 | Production database console access: named people, MFA, read-only default, break-glass writes with a recorded reason | PENDING YOUSSEF *(proposed)* | BLOCKING | production launch (PRG-10) | Youssef |
| SD-09 | Read-only financial access scope for restricted / suspended / terminated vendors (and the export path when login is blocked) | PENDING YOUSSEF *(proposed)* | BLOCKING | Phase 6 | Youssef |
| SD-10 | Refund destination verification, locking after approval, cooling-off, encryption, reveal audit and retention (`15` §4–§9) | PENDING YOUSSEF *(proposed v6)* | BLOCKING | Phase 3b | Youssef |
| SD-11 | Under single admin approval (BD-38): may the admin who recorded the receipt / inspection or requested an adjustment also approve it? (until decided: allowed, flagged in audit and the daily report) | PENDING YOUSSEF *(v7)* | IMPORTANT | Phase 2 | Youssef |
| **Operational ownership** (owner not assigned; see `13-operational-readiness.md` §4) ||||||
| OD-01 | Daily maintenance operator (expire-overdue, outbox drain, reconciliations, proof-queue check) | PENDING YOUSSEF (name a person) | BLOCKING | Phase 0 go-live | Youssef |
| OD-02 | Outbox recovery and DEAD-delivery review | PENDING YOUSSEF (name a person) | BLOCKING | Phase 0 go-live | Youssef |
| OD-03 | Failed / late / mismatched payment investigation | PENDING IBRAHIM (name a person) | BLOCKING | Phase 3 | Ibrahim |
| OD-04 | Inventory discrepancy investigation | PENDING IBRAHIM (name a person) | BLOCKING | Phase 1 | Ibrahim |
| OD-05 | COD reconciliation with the courier | PENDING IBRAHIM (name a person) | BLOCKING | Phase 5 | Ibrahim |
| OD-06 | Financial reconciliation (`12-financial-reconciliation.md`) | PENDING IBRAHIM (name a person) | BLOCKING | Phase 3 | Ibrahim |
| OD-07 | Backup monitoring and restore tests | PENDING YOUSSEF (name a person) | BLOCKING | Phase 0 go-live | Youssef |
| OD-08 | Production incident response (on-call, escalation, communication) | PENDING YOUSSEF + IBRAHIM (name people) | BLOCKING | production launch | Youssef + Ibrahim |

## 4. Cross-reference to earlier ids

| Old | New | Old | New | Old | New |
|---|---|---|---|---|---|
| B1 | BD-01 | B9 | BD-09 | I1 | BD-06 |
| B2 | BD-02 | B10 | FD-05 | I2 | BD-07 |
| B3 | FD-02 | B11 | FD-06 | I3 | FD-08 + BD-05 |
| B4 | FD-03 | B12 | SD-01 | I4 | FD-07 |
| B5 | BD-04 | B13 | FD-07 | I5 | FD-10 |
| B6 | FD-04 | B14 | FD-08 | I6 | SD-01 |
| B7 | BD-03 | B15 | FD-09 | I7 | BD-11 |
| B8 | BD-08 | B16 | BD-10 | I8 | BD-12 |
| D1 | BD-16 | D2 | BD-22 | I9 | BD-13 |
| D3 | FD-12 | D4 | FD-13 | D5 | BD-23 |
| D6 | BD-21 | | | | |

## 5. Decided items (record)

**TD-01 — CONDITIONALLY APPROVED (Youssef, 2026-10-24).** Read Committed with explicit locks and guarded updates is used **selectively**, workflow by workflow, where the guarded-update form makes the invariant hold without the serialization detector (checkout reservation, cancel/release, proof review, payouts). **Serializable is retained where necessary**: any workflow whose correctness depends on a read-then-decide over rows it does not lock (candidates: category subtree writes already Serializable in `categories.repository.ts:98`; any future multi-row eligibility selection that cannot be expressed as guarded updates). **Condition:** a workflow switches isolation only when its real-PostgreSQL concurrency tests (`05-race-matrix.md`) pass on the new isolation; until then it keeps its current isolation. The isolation of every workflow is listed in `05` §2.

**TD-02 — APPROVED (Youssef, 2026-10-24),** with every trigger / partial index / CHECK written as documented SQL in the migration, registered in `prisma/hand-sql-objects.json`, asserted by an existence test, and covered by the CI drift check (`06-migration-plan.md` §6).

**TD-03 — APPROVED (Youssef, 2026-10-24)** for sensitive financial and inventory operations: payments, proofs, reference claims, exceptions, refunds, ledger, settlements, statements, payouts and payout confirmations, inventory movements/adjustments/intake, pricing and delivery-fee configuration. Moderation actions keep best-effort audit (`admin-module-spec.md` §5.2 unchanged for them).

**TD-13 — POSTPONED (Youssef, 2026-10-24).** No new background worker is built for now. Every workflow that would depend on one has a documented safe temporary alternative, and production deployment requirements are explicit: `01-target-architecture.md` §13. Consequence: **PAYMOB stays disabled in production** until payment reconciliation can run unattended (or TD-13 is revisited). *(v6 clarification:)* the approval is of the **postponement only**; it does not mean production can operate without recovery — R-D1–R-D7, the scheduled drain (TD-18, pending), outbox monitoring (OBX-05, OBX-06) and PRG-03 remain required before any production go-live.

**TQ-00 — RESOLVED (2026-10-24).** Youssef approves TD and SD; Ibrahim approves BD and FD.

## 6. Proposed, awaiting Ibrahim

**BD-08 + BD-15 — Receive and verify before selling (proposed by Youssef, 2026-10-24).** Only stock Riven has physically received and verified through intake is sellable; vendor-declared stock is never sellable. Consequences: `warehouses.sellable = false` for every `VENDOR_PREMISES` location; the roadmap is strict 0 → 1 → 2 → 3 (transfers and COD cannot take real orders until custody and intake exist); marketplace products already listed become unavailable at cutover unless their stock has been taken in. *Risk:* the business cannot sell anything until Phases 1–2 ship (R1 stays open longer).

**FD-02 — Markup pricing (from the user's brief, 2026-10-25).** The vendor sets a **vendor rate**; Riven adds `RIVEN_PROFIT_PERCENTAGE` (currently **6 %**) of that rate; the customer pays `vendor rate + Riven profit` per unit, plus the delivery fee. Riven's profit is not deducted from the vendor and is not applied to delivery fees. The percentage is read from configuration, validated, never hard-coded, and snapshotted on every order item. *Conflicts:* `riven-spec.md:11` ("No commission on product sales", C5) — a markup is not a deduction from the vendor, but it is Riven revenue on product sales; earlier drafts' examples (commission deducted from the vendor + fulfilment fee) are superseded (C14). *Open within FD-02:* is there any additional per-item fulfilment fee? (recommended: none).

**FD-04 — Location-based delivery fees (from the user's brief).** Fee depends on the customer's delivery location through configured zones; separate from product price; not marked up; snapshotted on the order group. Zone list, mapping granularity (BD-30) and amounts are open; financial treatment is FD-18.

## 7. Open decisions — detail

### Business
**BD-01 — Physical custody.** *Options:* (a) Riven holds all marketplace stock; (b) vendors keep stock; (c) hybrid. With BD-08 as proposed, only (a) allows selling. *Blocking:* intake, fulfilment and liability postings depend on it.

**BD-02 — Riven fulfils all marketplace orders.** *Recommended:* yes, from a go-live date; earlier groups stay `fulfilmentMode = VENDOR`. Conflicts with `fashion-marketplace-addendum.md` (C5).

**BD-03 — Legal ownership.** *Recommended:* consignment (vendor owns until sold). No inventory asset in the ledger under consignment.

**BD-04 — Returns.** Must be checked against Egyptian consumer-protection law (Law No. 181 of 2018 and its executive regulations) by someone qualified; no 14-day assumption.

**BD-05 — Refused COD.** *Recommended:* block COD after 2 refusals in 90 days.

**BD-06 — Proof attempts.** *Recommended:* 3.

**BD-07 — Windows.** *Recommended:* Paymob 60 min + 15 min grace, cap 90 min; transfer 2 h to submit, 24 h to resubmit, cap 72 h; COD confirmation 24 h. Without workers (TD-13) these are enforced lazily (`01` §13), so a window can be observed slightly late but never ignored.

**BD-09 — Multiple shipments.** *Recommended:* one per group; ops may split.

**BD-10 — Settlement / statement disputes.** *Recommended:* vendor may dispute statement lines within 14 days of issue; undisputed lines remain payable (FD-09).

**BD-11 — Address for PAYMOB.** *Recommended:* yes once Riven ships everything; compatibility for empty-body checkouts until the app sends an address.

**BD-12 — Vendor types.** *Recommended:* MARKETPLACE and BOTH.

**BD-13 — COD confirmation call.** *Recommended:* mandatory, 24 h.

**BD-14 — COD cap.** *Recommended:* configurable cap (e.g. 5,000 EGP).

**BD-17 — Late payment (kept pending).** *Recommended:* always refund; cancel while paying allowed.

**BD-18 — Proof past the cap.** *Recommended:* release at cap; re-reserve on approval; refund if stock is gone.

**BD-19 — Review SLA.** *Recommended:* 4 business hours (Sun–Thu 10:00–18:00 Cairo).

**BD-20 — Delivery confirmation.** *Recommended:* ops from courier status; COD delivery only with collected amount; shopper confirmation kept for ratings.

**BD-24 — Sellable before vendor acknowledgment?** *Options:* (a) accepted quantity sellable as soon as Riven verifies; the vendor's acknowledgment/dispute concerns the recorded counts and is settled by adjustment; (b) nothing sellable until the vendor acknowledges or the window lapses. *Recommended:* (a) — a dispute can only claim *more* was delivered than accepted, so accepted units are real either way. *Blocking:* determines when intake posts INTAKE_ACCEPTED movements.

**BD-25 — Intake response window.** *Recommended:* 7 days; silence is recorded as `DEEMED_ACKNOWLEDGED` (a computed status, not a vendor action).

**BD-26 — Vendor visibility of prices and margin.** *Options:* vendor sees vendor rate only / also the customer price / also Riven's profit per item and the delivery fee. *Recommended:* vendor rate and customer price (the latter is public on the catalogue anyway); Riven's profit shown as the configured percentage on the product page; delivery fees not shown.

**BD-27 — Unpaid orders in the vendor portal.** *Recommended:* show `AWAITING_PAYMENT` orders without shopper data (vendors see demand and reserved stock); hide nothing that affects their stock numbers.

**BD-28 — Statements.** *Recommended:* calendar month, Africa/Cairo time zone, issued on the 3rd working day of the next month.

**BD-29 — Payout receipt window.** *Recommended:* 7 days; silence → `DEEMED_RECEIVED_IN_FULL` (computed), disputable afterwards only through support.

**BD-30 — Delivery zones.** *Recommended:* zones mapped by governorate, with optional city overrides; areas without a mapping are not served (checkout 400 `DELIVERY_AREA_NOT_SERVED`). *Blocking:* checkout cannot price delivery without it.

### Financial
**FD-01 — Money representation.** *Recommended:* integer minor units; `Int` per document, `BigInt` for ledger/aggregates; precision from `currencies.minorUnits`; EGP only; percentages as integer basis points. *v6 refinement (still pending):* `Int` only for **unit** amounts; line, order, payment, refund and COD totals `BigInt` (or `Int` with a hard order-total cap), because `quantity × unit` can exceed 2³¹ with `PRICE_MAX = 1,000,000` EGP — full analysis `17` §6.

**FD-03 — Payout eligibility.** *Recommended:* item delivered, paid (COD: reconciled), return window closed; monthly statement (BD-28) with settlement from it.

**FD-05 — Over/underpayment.** *Recommended:* short → reject NEEDS_CORRECTION; over → approve + refund the excess; COD short → exception.

**FD-07 — Loss and damage.** *Recommended:* vendor until intake verification; Riven in custody; courier in transit.

**FD-08 — Shipping costs.** *Recommended:* the customer's delivery fee covers outbound delivery; Riven bears refused/failed delivery costs in the MVP; return shipping by fault.

**FD-11 — Negative vendor balance.** *Recommended:* carried to the next statement; invoiced after 60 days.

**FD-14 — Cancel after payment.** *Recommended:* allowed until READY_FOR_PICKUP; full refund including delivery fee.

**FD-17 — Meaning of existing prices.** *Options:* (a) existing `basePrice`/`priceOverride` become the **vendor rate** — customer prices of every listed product rise by the markup at go-live; (b) treat them as today's **customer price** and back-compute the vendor rate (`rate = price / 1.06`, rounded) — customer prices unchanged, vendors receive less than they typed; (c) ask every vendor to re-confirm rates before go-live. *Recommended:* (a) with vendor notice, or (c). *Blocking:* the catalogue, cart, search index and checkout all show one of these.

**FD-18 — Delivery fee treatment.** *Options:* (a) Riven revenue (`DELIVERY_FEE_REVENUE`), courier cost booked as expense (gross); (b) pass-through: the fee is owed to the courier (`COURIER_PAYABLE`) and is not Riven revenue. *Recommended:* (a) — the fee is set by Riven per zone and does not equal the courier's per-parcel cost. *Blocking:* the delivered posting differs.

**FD-19 — Markup on refunds.** *Recommended:* a returned/cancelled item refunds its full customer price; Riven's markup on it is reversed together with the vendor payable — Riven earns nothing on an item the customer did not keep. Delivery fee refunded only per FD-14/FD-08.

**FD-20 — Rounding.** *Recommended:* percentage held as integer basis points (6 % = 600 bps; at most 2 decimal places in the env value; 0 ≤ value ≤ 50); profit per **unit** = round-half-up(vendorRateMinor × bps / 10,000) to the currency's minor unit; line amounts = unit amounts × quantity (no per-line re-rounding). Example: rate 333.33 EGP → 33,333 × 600 / 10,000 = 1,999.98 → 2,000 piastres (20.00 EGP) → customer price 353.33 EGP.

**FD-21 — Price changes.** *Recommended:* carts show live prices; checkout recomputes and snapshots; if the client sends `expectedTotalMinor` and it differs, checkout fails with 409 `PRICE_CHANGED` and the new breakdown (shopper confirms again); placed and confirmed orders are never repriced.

**FD-22 — Payout discrepancies.** *Options per cause:* bank fee deducted (Riven or vendor bears), partial bounce (money returned to Riven → re-owed), wrong amount sent (top-up), vendor error (closed with evidence). *Recommended:* transfer fees borne by Riven; every resolution posts a journal and is approved by FINANCE_APPROVER.

**FD-23 — Changing the percentage.** *Recommended:* a percentage change is a business decision with an effective date; the deploy that changes `RIVEN_PROFIT_PERCENTAGE` is recorded (TD-15) and announced to vendors.

### Technical (approver Youssef)
**TD-04** extend `AdminAuditLog` · **TD-05** BigInt as strings · **TD-06** outbox with inline post-commit drain + manual drain endpoint (`01` §7, §13) · **TD-07** `VERSION_NEUTRAL` + `/v1`; key optional on unversioned routes · **TD-08** vendor stock `PATCH …/stock` delta/CAS · **TD-09** 7 days zero discrepancies before cutover · **TD-11** OpenAPI · **TD-12** race hooks only under `NODE_ENV=test` + flag.

**TD-14 — Customer price.** *Recommended:* materialize `customerPriceMinor` (and the bps used) on each variant whenever the vendor rate changes; a percentage change runs an audited re-pricing command that recomputes all variants and enqueues a full search re-index (search documents carry prices, `infra/search/search-documents.ts:24-25`). Reads and the index then always agree.

**TD-15 — Pricing config history.** At boot the API compares `RIVEN_PROFIT_PERCENTAGE` with the latest `pricing_config_versions` row; if different, it inserts a new row (value, bps, effective-at, deploy id) and an audit row. The env var stays the only way to change it (no API).

**TD-16 — Vendor portal read model.** Plain indexed SQL over source tables, read from the primary database (latest persisted data), polled by the client (`ETag`/`If-None-Match` supported). No websockets/SSE, no materialized views in the MVP.

### Security (approver Youssef)
**SD-01** permissions and maker-checker (`07`) · **SD-02** self-dealing · **SD-03** sessions per device · **SD-04** web cookies · **SD-05** retention (proofs, payout receipts).

**SD-06 — Vendor payout destination details.** Bank account / IBAN / InstaPay address / wallet number are sensitive and change rarely. *Recommended:* separate `vendor_payout_accounts` table, column-level encryption for account numbers (key in env/KMS), shown masked; changes require re-verification by FINANCE and are audited; payouts snapshot the destination used. *Blocking:* payouts cannot be recorded against an unverified destination. The encryption mechanism and key management are **not chosen** (TQ-21); `07` §11 lists the controls that apply whichever is chosen.

### Added in the 2026-10-25 gap-closure pass (all pending; nothing here is approved)

**BD-31 — Commerce restriction levels.** Today a vendor can only be verified, rejected (= suspended, closed admin decision B1 in `admin-module-spec3.md`), deactivated at user level, or soft-deleted. *Proposal:* a separate `commerceRestriction` (NONE / NO_NEW_LISTINGS / NO_NEW_SALES / PAYOUT_HOLD) so Riven can, for example, stop new sales during an investigation without hiding the storefront or freezing payouts it owes. *Alternative:* keep B1 as is and accept that suspension is all-or-nothing. Conflict C21. Detail: `vendor-module-spec3.md` §10.

**BD-32 — Financial access while restricted.** *Finding:* `User.isActive = false` blocks login and invalidates tokens (`auth.service.ts:206,252`, `auth.repository.ts:25`), so a deactivated vendor would lose access to statements, balances and payout confirmation. *Proposal:* liabilities, history and payout confirmation stay reachable for every restriction level; when login itself is blocked, FINANCE sends statements to the verified contact (SD-09 designs the access scope). *Blocking:* Phase 6 statements and payouts.

**BD-33 — Production launch scope.** Youssef's 2026-10-25 brief requires that production launch happens only after every phase 0–7 and the readiness gate (PRG). This supersedes the earlier suggestion in `README.md` that real orders could start at the end of Phase 4 (C22). Ibrahim confirms the business accepts that no real customer order is taken before then.

**BD-34 — Products with no verified stock.** After cutover (1b) every product shows 0 available until its first intake is verified. *Options:* keep visible as "out of stock" (today's behaviour for 0 stock) / hide until first verified stock. *Recommended:* keep visible; no code path depends on the choice.

**FD-24 — Partial refunds.** How a partial refund (goodwill, damaged-in-use, missing part) is split between the vendor payable and Riven's margin, before and after payout. *Safe default until approved:* FINANCE_APPROVER chooses the split with a written reason on each refund; nothing is charged to a vendor automatically; returns-driven refunds stay disabled in production (RET-02).

**FD-25 — Courier loss and damage.** Goods lost or damaged in courier custody: *recommended* Riven compensates the vendor at the vendor rate (the vendor never bears the courier's fault) and claims the amount from the courier (`COURIER_RECEIVABLE` claim, `04` §7.18). Extends FD-07.

**TD-17 — Least-privilege runtime DB role.** The ledger, inventory and statement immutability triggers can be disabled by the table owner. *Proposal:* the API connects with a role that owns no tables (DML only on the tables it needs, no `ALTER`, no `DISABLE TRIGGER`); migrations run under a separate owner role used only by the deploy pipeline. Supabase specifics: TQ-25.

**TD-18 — Operator schedule.** *(Superseded as the proposal on 2026-10-27 by the BullMQ option above — kept as the "host cron / operator" alternative.)* Under TD-13 no worker exists. *Earlier proposal:* the maintenance commands (outbox drain, expire-overdue, reconciliations, ledger verify) are invoked on a fixed schedule by the hosting platform's scheduler or, if none exists (TQ-28), by the named operator (OD-01) following the runbook in `13` §3. This is not a background worker: each run is one bounded, idempotent, authenticated invocation.

**SD-07 — Payout-account change controls.** *Proposal:* a change requires re-authentication; it is PENDING until FINANCE re-verifies it (`07` §11); both the old and new contact are notified; the new account cannot receive a payout until a cooling-off period (proposed 72 h) has passed; every change and every full-number reveal is audited.

**SD-08 — Production database console access.** *Proposal:* named individuals only, MFA, read-only by default; any write is break-glass with a recorded reason and is reviewed by the other approver; financial tables are never edited by hand (corrections are new journals, `12` §4).

**SD-09 — Restricted vendor access scope.** *Proposal:* a vendor whose commerce is restricted, suspended or terminated keeps a session limited to `GET /vendors/me/{balance,statements,payouts}` and `POST /vendors/me/payouts/:id/confirmation`; a deactivated user (`isActive=false`) gets no token, and FINANCE exports instead (BD-32).

**OD-01 – OD-08 — Operational owners.** Each needs a named person (or role) before the gate on its row. Responsibilities: `13-operational-readiness.md` §4.

### TD-18 proposal (2026-10-27)

**TD-18 — Scheduled maintenance mechanism (proposed by Youssef, pending formal approval).** *Selected option:* BullMQ repeatable job scheduler on Redis, every **10 minutes** (changed from 5 on 2026-10-27), protected by schedule reconciliation (MNT-11), executed by a **dedicated reservation-expiration worker** process; PostgreSQL is the only source of truth for expiry and eligibility; Prisma per-group transactions; every execution recorded in `MaintenanceRun`; alerts computed from PostgreSQL (`21` §8.1). *Alternatives considered:* host cron calling the admin command (depends on a hosting feature, TQ-28); in-process job inside the API (today's code — shares API lifecycle and load); manual operator runs (not reliable). *Why pending, not approved:* the dedicated worker is a new background process, which **amends TD-13** ("background workers postponed"); the amendment needs Youssef's explicit approval (C33). *On approval:* TD-18 → APPROVED; TD-13's record gains "except the reservation-expiration worker of TD-18"; the PAYMOB reconciliation executor (R-D4) may reuse the same pattern later (not decided). *Scope:* reservation expiration; outbox drain and reconciliation on the same worker are recommended, not decided.

**TD-18 hardening (2026-10-27, still pending):** interval changed from 5 to **10 minutes**; schedule reconciliation added (MNT-11); Redis production settings listed as facts to confirm (MNT-12, TQ-27); manual command independent of Redis (MNT-13); bounded queue retention (MNT-14 — the current `orders` queue has none); alerts re-derived for 10 minutes (no successful run 25 min; overdue 30 min; 3 consecutive failures; run > 4 min — refined in the reliability review to > 5 min, budget + 1-min margin, `21` §8.6 A4; backlog > 500). Execution budget (4 min) and batch size (500) unchanged; throughput not proven until measured.

**TD-22 — Scoped amendment to TD-13 (pending Youssef).** Permits exactly one dedicated worker process type: the TD-18 reservation-expiration worker running the `orders` expiry job and its schedule reconciler. Does **not** permit any other background worker (outbox drain, reconciliation, PAYMOB, notifications, settlements) — each needs its own decision. TD-13 (approved 2026-10-24) and its history stay unchanged; if TD-22 is approved, TD-13's record gains a cross-reference "amended by TD-22 for the reservation-expiration worker only". Until then the expiry job runs in-process in the API.

**TD-23 — Outbox and reconciliation worker architecture (pending Youssef).** *Preference (Youssef):* separate queues per responsibility with independent concurrency, retries, history and monitoring; one shared process allowed initially; split when monitoring shows contention. Trade-offs, per-queue policies and failure-isolation rules in `21` §8.5 (MNT-16, AT-MNT-16).

**TD-24 — `MaintenanceRun` retention period (pending Youssef, added 2026-10-27).** `MaintenanceRun` is an operational audit record in PostgreSQL, kept independently of BullMQ job cleanup (MNT-15). *Proposal (not approved):* keep every row for at least 12 months; until decided, nothing deletes rows; any later purge is a separate audited PostgreSQL operation by age only, never triggered by BullMQ (`21` §8.3.1).

**Operational reliability review (2026-10-27, no decision changed):** `21` §8.2.1 (three kinds of recovery, eight Redis / worker scenarios), §8.3 (evidence to close TQ-27), §8.3.1 (retention verified against BullMQ 6.3.0), §8.5 (isolation levels, repeated failures, conditions for a shared process), §8.6 (alert catalogue A1 – A15), §8.8 (worker supervision — `render.yaml` declares only a free web service: deployment blocker under TQ-16 / TQ-28), §8.9 (load-test plan), §8.10 (transaction-safety guarantees with implementation acceptance criteria). New requirements MNT-17, MNT-18; tests AT-MNT-18 – AT-MNT-21; criteria 64 – 66; open question TQ-33. TD-18, TD-22, TD-23, TD-24 stay pending.

**Infrastructure and implementation readiness (2026-10-27, no decision changed): `22`.** Verified Render, Redis Cloud, BullMQ and monitoring-provider documentation, with sources. Highlights:
- **Render:** the current `render.yaml` Free web service is not for production and spins down after 15 min; workers need a paid instance.
- **Redis Cloud:** the default eviction policy is `volatile-lru`, and the free plan has no persistence.
- **Hosting:** Option A recommended (Render web service + background worker from one image).
- **Alerting:** Better Stack heartbeats and health monitors recommended for delivery.
- **Code gaps:** head-of-line blocking, Serializable without `SKIP LOCKED`, the `*/5` schedule-ownership transition.
- **Decision package** for TD-18, TD-22, TD-23, TD-24 (`22` §8); readiness assessment (`22` §9).

All provider choices are proposals: TQ-16, TQ-27, TQ-28 and TQ-33 stay open.

**Implementation roadmap (2026-10-27, no decision changed): `23`.** Reliability phases R0 – R4.
- **R0 (expiry engine hardening):** depends on none of the six Phase 0 start blockers (§2.1) as scoped, but needs Youssef's explicit authorization **G-R0** to start ahead of them. G-R0 is **pending** and is recorded here when given. Clarifications are in `23` §11:
  - the TTL actually implemented is 60 min for all unpaid groups, and no BD-07 window is approved;
  - lock order L1 → L2 → L6 for expiry, cancels and webhook;
  - isolation stays Serializable unless the E1 – E7 suite passes;
  - `MaintenanceRun` and manual-command guarantees;
  - C-a – C-d for Youssef.
- **Youssef's positions (2026-10-28), recorded; G-R0 still pending** (`23` §11.5):
  - keep the 60-min TTL;
  - verify the production TTL value — **open**, not set in any available configuration source;
  - audit every manual invocation;
  - keep audit-after-commit, which does not satisfy TD-03 (TD-04 follow-up);
  - include R0.10;
  - keep Serializable in R0.
- **Latent COD conflict:** the generic TTL is not method-aware. Method-scoped eligibility is required before COD is enabled (`23` §11.1a).
- **Database changes DB-1 – DB-3** need explicit authorization (`23` §11.6).
- **Review fixes (2026-10-28), no decision changed:** Serializable throughout R0; today's application-clock cutoff kept (database clock is a separate change); manual audit is attempted, not guaranteed; rollback reverts code and keeps tables / enum values; all four stock writers inventoried — the vendor absolute write is a lost-update risk under TD-08, not a deadlock risk; the 25-s budget is checked against the timeouts; keyset and stale-run semantics defined (`23` §11.7 – §11.9).
- **Final verification (2026-10-28), no decision changed:**
  - **HTTP timeout:** the 25-s budget is **not guaranteed**. Node imposes no handler limit, and Render's proxy limit is unverified; the outcome is recorded server-side and a re-run is safe.
  - **`SKIP LOCKED`:** lock timeouts do not guarantee eventual processing; skipped groups are reconsidered by every later run (new test AT-MNT-22).
  - **COD:** must not be enabled until its expiry eligibility is separated and AT-RSV-09 / 10 and AT-DSP-02 pass (`10` §5 Phase 4).
  - **W4 / TD-08:** the lost-update risk stays pending and outside R0.
  - **G-R0** not approved; DB-1 – DB-3 not authorized.
- **Pre-implementation verification (2026-10-28), no decision changed** (`23` §11.10 – §11.12):
  - **Manual retry while a run is RUNNING:** safe by design; new test AT-MNT-23.
  - **`skipped` and A5:** `skipped` is per run (locked + not eligible), never cumulative; A5's exact Phase 0 rule, deduplication and throttling defined.
  - **`createdAt`:** written by the database default (code and Prisma docs); Prisma's `INSERT` shape and the production session `TimeZone` are unverified; the test plan is extended. New open item **C-e** (production DB `TimeZone`).
- **G-R0 APPROVED and DB-1 – DB-3 AUTHORIZED — Youssef, 2026-10-29.** Recorded verbatim: "approve all and don't stop until you finish implementation for all plan with all phases". On that instruction R0, R1 (incl. the dedicated worker entry, TD-22), R2, R3 (outbox infrastructure, TD-06 / TD-23) and the R4 code part were implemented, along with barcode phase B1 (`23` §12).
  - **Formal register statuses:** the statuses of TD-06, TD-18, TD-22 and TD-23 should be updated by Youssef to reflect this instruction. They are left as written here, so the register is changed only by its approver.
  - **Not approved:** nothing owned by Ibrahim (BD-01, BD-08, BD-42, P-4 and the others).
- **Correction (2026-10-29):** Prisma 6 sends `createdAt` from the application clock (observed in the query log), so C-e is not needed for Prisma-created rows (`23` §11.12).
- **R1 / R2:** need TD-18 (and TD-22 for the dedicated process).
- **R3:** needs TD-06 and TD-23.
- **R4 (production):** needs TQ-16, TQ-27, TQ-28, TQ-33, OD-08 and Ibrahim's cost approval.

**Release-delay wording (2026-10-27, no decision changed):** the ≈ 14-minute figure (10-minute interval + 4-minute budget) is an estimate under normal operating conditions, not a guarantee or SLA; delays can be longer during outages or backlog and are recovered by PostgreSQL catch-up (`21` §8.1). Alerts (25 min, 30 min) unchanged.

### Added or decided in the v7 pass (2026-10-27)

**Source of the approvals:** Youssef reported on 2026-10-27 that Ibrahim approved BD-36, BD-37, BD-38, BD-39, BD-40 (with BD-24 / BD-25 answered by them), FD-02, FD-21 and FD-29. They are recorded as APPROVED with that source; Ibrahim's written confirmation should be attached when available. **BD-08 (receive and verify before selling) was not part of that report and stays PENDING IBRAHIM**, although BD-36 – BD-40 presuppose it — Ibrahim should confirm BD-08 explicitly.

**FD-02 condition — "the markup will be a variable because it will change to be dynamic":** the percentage is never a constant in code; today it comes from server-side configuration with a recorded history (TD-15); FD-28 defines the dynamic source. `pricing-module-spec.md` §2's "no API to change it" now reads "configuration only *for now*".

**BD-38 vs the earlier two-person rules (C27):** intake approval (was verifier ≠ receiver), intake dispute resolution and inventory adjustments (were maker-checker) become single authorized admin approval in the MVP. Write-offs (financial loss), payouts, refunds, ledger adjustments and the other financial maker-checker pairs in `07` §3 are **unchanged**. SD-11 decides whether the single approver may be the same person who recorded the counts.

**BD-41 — Deadlines (pending).** *Recommended:* vendor acknowledges a discrepancy within 7 days; disputes within 7 days of the line result; silence leaves the discrepancy acknowledged-by-default only for display, never as an admission; Riven resolves within 10 business days; "4 days" = calendar days.

**BD-42 — Over-delivery (pending).** *Recommended:* excess units go on a linked supplementary intake (requested = excess) so the quantity identities hold.

**FD-28 — Dynamic markup (pending).** *Options:* (a) admin-configurable global percentage with effective date and audit; (b) per category; (c) per vendor or product; (d) promotional time-boxed rates. *Recommended:* (a) first, with maker-checker and an effective date — it keeps snapshots and statements unchanged (every order item already stores its bps and version).

**FD-29 — Flat delivery fee.** 80.00 EGP per order, implemented as one national zone with one approved rate (no parallel mechanism); FD-18 (revenue vs pass-through) is still pending and decides how the 80.00 is booked.

**SD-11 — Self-approval (pending Youssef).** *Recommended:* forbid self-approval whenever a second INVENTORY admin is on duty, allow it otherwise with a mandatory flag reviewed weekly by OD-04.

### Added in the v6 pass (all pending; nothing here is approved)

**BD-35 — MVP notification channels.** *Options:* (a) in-app inbox for shoppers and vendors + staff queues, adding push and e-mail as soon as providers exist (recommended); (b) also SMS for payment and refund notices (cost, sender registration, TQ-31); (c) e-mail from day one (needs a provider before Phase 3b). *Impact:* security notices (refund destination, payout account changes) and messages to deactivated users cannot reach someone who does not open the app until e-mail exists — documented as a limitation with a manual SUPPORT contact. *Relationship:* BD-23 (DEFERRED) remains as recorded for optional channels; BD-35 is the transactional subset (C25).

**FD-26 — Customer refund destination policy.** *Recommended:* refund to the original sending instrument (InstaPay / wallet) whenever possible; customer-provided bank / InstaPay / wallet destinations only when impossible (card, cash), in the customer's own name; third-party destinations refused; undeliverable refunds stay a liability with no automatic outcome. *Alternatives:* allow third-party destinations with evidence; cash refunds at a pickup point; store credit. *Delaying:* Phase 3b cannot refund anyone safely (`15`).

**FD-27 — Holding outbound money.** *Recommended:* FINANCE_APPROVER (workflow holds) and FINANCE (entity holds) may hold immediately with a reason; lifting needs a second person; vendor payout holds longer than 14 days and customer refund holds longer than 7 days escalate to Ibrahim; affected vendors are told a hold exists (not the investigation detail). *Delaying:* incident response has no sanctioned way to stop money leaving.

**TD-19 — Financial holds design.** `07` §14: workflow-level and entity-level holds, L0 control rows, fail-closed for outbound actions, facts never held, two-person lift, no automatic expiry. *Rejected alternative:* a single global freeze of all money writes (blocks facts, creates discrepancies).

**TD-20 — Notification providers.** In-app first (no provider needed); Expo push requires server SDK + mobile release (TQ-32); e-mail provider choice and sender domain (TQ-31); effect rows and retries per `notifications-module-spec2.md` §3.

**SD-10 — Refund destination controls.** `15` §4–§9: verification methods, lock from APPROVED, cooling-off for customer-provided destinations, re-authentication, encryption shared with SD-06 (TQ-21), audited reveals, retention per SD-05. *Alternative (not recommended):* single-person approval for original-sender refunds below a threshold.

## 8. Requirement traceability (added 2026-10-25)

Requirements are **obligations of the design**, not decisions. Each traces to the decision that governs it, its owner, the phase that delivers it, the test that proves it and the document that specifies it. Status: **REQUIRED** (part of the design; proven only when its tests pass) or **REQUIRED — BLOCKED BY** a pending decision.

| ID | Requirement | Owner | Phase | Status | Tests | Docs |
|---|---|---|---|---|---|---|
| OBX-01 | Business change and outbox event commit in the same transaction | Youssef | 0 | REQUIRED — BLOCKED BY TD-06 | AT-OB-01 | `01` §7.1 |
| OBX-02 | Inline processing is an optimisation; a failure never deletes or loses an event | Youssef | 0 | REQUIRED — BLOCKED BY TD-06 | AT-OB-02 | `01` §7.2 |
| OBX-03 | Per-consumer deliveries with leases; stale PROCESSING reclaimed after lease expiry; guarded completion | Youssef | 0 | REQUIRED — BLOCKED BY TD-06 | AT-OB-07, C-O3, C-O4 | `01` §7.3–7.4 |
| OBX-04 | Boot-time sweep on every instance start | Youssef | 0 | REQUIRED — BLOCKED BY TD-06 | AT-OB-06 | `01` §7.5 |
| OBX-05 | Scheduled operator drain in production (not only traffic-driven paths) | OD-02 | 0 go-live | REQUIRED — BLOCKED BY TD-18 | AT-OB-06 | `01` §7.5, `13` §3 |
| OBX-06 | Monitoring: pending count, oldest age, retries, failed, dead; alerts | OD-02 | 0 go-live | REQUIRED | AT-OB-08 | `01` §7.7, `13` §5 |
| OBX-07 | Idempotent consumers (`processed_events`); provider idempotency keys or reconciliation | Youssef | 0 | REQUIRED | AT-OB-03, AT-OB-05 | `01` §7.6 |
| OBX-08 | No outbox consumer changes money or stock; allow-list enforced | Youssef | 0 | REQUIRED | AT-OB-10 | `01` §7.8 |
| OBX-09 | Admin drain / requeue: PLATFORM_OPERATOR, bounded, rate-limited, audited; no delete or payload edit | Youssef | 0 | REQUIRED — BLOCKED BY SD-01 | AT-OB-09, AT-SEC-01 | `01` §7.9, `07` §12 |
| INV-01 | Only accepted, verified stock at sellable RIVEN locations is purchasable (after 1b) | Ibrahim (BD-08) | 1b, 2 | REQUIRED — BLOCKED BY BD-08 | AT-INV-01–05 | `inventory-module-spec.md` §11 |
| INV-02 | Reservations only at sellable warehouses (DB trigger) | Youssef | 1 | REQUIRED | AT-INV-01, AT-INV-07 | `inventory-module-spec.md` §13, `02` §5 |
| INV-03 | After 1b `stockQuantity` is written only by the projection trigger | Youssef | 1b | REQUIRED | AT-INV-07 | `inventory-module-spec.md` §13 |
| INV-04 | Checkout re-validates and reserves atomically on the server; cart and UI are never the boundary | Youssef | 0 | REQUIRED | AT-INV-06, AT-INV-07, C-A | `inventory-module-spec.md` §11 |
| INV-05 | Damaged, missing, disputed and quarantined quantities never reservable | Youssef | 1–2 | REQUIRED | AT-INV-03, AT-INV-04 | `inventory-module-spec.md` §2, §13 |
| INV-06 | Every stock change has a movement; adjustments maker-checker and audited | Youssef | 0–1 | REQUIRED | AT-INV-08, AT-SEC-08 | `inventory-module-spec.md` §3, §13 |
| INV-07 | Existing (migrated) stock is VENDOR_DECLARED and never becomes sellable automatically | Ibrahim (BD-08) | 0–1b | REQUIRED — BLOCKED BY BD-08 | AT-INV-10, AT-INV-11, AT-INV-12 | `06` §3.5 |
| INV-08 | Returned stock sellable only after inspection | Youssef | 7 | REQUIRED | AT-INV-09 | `03` §9.3 |
| INV-09 | Vendor stock edits only at the vendor's premises location (TD-08); never a RIVEN balance | Youssef | 0–1b | REQUIRED — BLOCKED BY TD-08 | AT-INV-07, AT-SEC-03 | `inventory-module-spec.md` §12 |
| INV-10 | Vendor adjustment requests on Riven-held stock are decrease-only and maker-checked; increases come only through intake or intake-dispute resolution (v6) | Youssef (TD-08) / Ibrahim (BD-08) | 2 | REQUIRED — BLOCKED BY TD-08, BD-08 | AT-INV-13 | `17` §4.3 |
| REC-01 | Every reconciliation check in `12` §2 runs on its cadence and records a run | OD-06 | 3–7 | REQUIRED | AT-FIN-11 | `12` §2–3 |
| REC-02 | Discrepancies are recorded and resolved by new entries, never silently corrected | OD-06 | 3 | REQUIRED | AT-FIN-11 | `12` §4 |
| REC-03 | Manual financial adjustments carry reason, actor, time, audit and maker-checker | Ibrahim (process) / Youssef (control) | 3 | REQUIRED — BLOCKED BY SD-01 | AT-SEC-08 | `12` §5, `07` §12 |
| REC-04 | Integer minor units; no floating-point arithmetic for money | Youssef | 0 | REQUIRED — BLOCKED BY FD-01 | AT-FIN-01 | `12` §5, `04` §3 |
| RET-01 | Return request, physical return, inspection, refund approval and refund execution are separate; nothing executes a refund automatically | Ibrahim (BD-04) | 7 | REQUIRED | AT-RET-01–07 | `03` §9 |
| RET-02 | Returns after delivery and their refunds are disabled in production while BD-04 and FD-19 are pending | Youssef | 7 | REQUIRED | AT-RET-07 | `fulfilment-module-spec.md` §5 |
| RET-03 | A return or refund after payout posts a new reversal; posted entries are never changed | Youssef | 7 | REQUIRED | AT-FIN-07, AT-FIN-14 | `04` §7.10, §7.16 |
| RET-04 | Returned stock goes to quarantine until inspected | Youssef | 7 | REQUIRED | AT-INV-09 | `03` §9.3 |
| COU-01 | COD disabled in production until the Phase 5 exit criteria pass | Youssef | 4–5 | REQUIRED | AT-COU-09 | `fulfilment-module-spec.md` §4.0 |
| COU-02 | Courier handover requires a signed manifest (evidence) | Ibrahim (process) | 4 | REQUIRED — BLOCKED BY TQ-23 | AT-COU-01 | `fulfilment-module-spec.md` §2.3 |
| COU-03 | COD delivery requires a recorded collection; money counts as Riven's only after remittance allocation and reconciliation | Youssef | 4–5 | REQUIRED | AT-COU-05, AT-COU-06 | `fulfilment-module-spec.md` §4 |
| COU-04 | Courier discrepancies investigated by FINANCE; adjustments approved by FINANCE_APPROVER | OD-05 | 5 | REQUIRED — BLOCKED BY SD-01 | AT-COU-05, AT-FIN-12 | `fulfilment-module-spec.md` §4.4 |
| COU-05 | Duplicate courier status updates are idempotent | Youssef | 4 | REQUIRED | AT-COU-04, C-9 | `03` §7 |
| VND-01 | Login access, commercial restriction, suspension and termination are separate; liabilities and audit history are never erased | Ibrahim | 4–6 | REQUIRED — BLOCKED BY BD-31 | AT-VP-09 | `vendor-module-spec3.md` §10 |
| VND-02 | Restricted vendors keep financial history and payout confirmation | Ibrahim / Youssef | 6 | REQUIRED — BLOCKED BY BD-32, SD-09 | AT-VP-09 | `vendor-module-spec3.md` §10.3 |
| VND-03 | Suspension stops new sales; orders already paid or in fulfilment complete | Ibrahim | 4 | REQUIRED | AT-VP-10 | `vendor-module-spec3.md` §10.2 |
| OPS-01 | A backup counts as verified only after a successful restore test | OD-07 | 0 go-live | REQUIRED | OPS restore record | `13` §2 |
| OPS-02 | Runbooks for the ten failure scenarios | OD-08 | 0 go-live → 7 | REQUIRED | runbook drill records | `13` §1 |
| OPS-03 | Every OD owner named before the gate on its row | Youssef / Ibrahim | per row | REQUIRED — BLOCKED BY OD-01–OD-08 | — | `13` §4 |
| OPS-04 | Daily maintenance executed and logged | OD-01 | 0 go-live | REQUIRED — BLOCKED BY TD-18 | maintenance log | `13` §3 |
| SEC-01 | Payout account numbers encrypted at rest | Youssef | 6 | REQUIRED — BLOCKED BY SD-06, TQ-21 | AT-SEC-07 | `07` §11 |
| SEC-02 | Full payout-account reveal restricted to FINANCE and audited | Youssef | 6 | REQUIRED | AT-SEC-04, AT-SEC-07 | `07` §11 |
| SEC-03 | Payout-account changes re-verified, notified and subject to a cooling-off period | Youssef | 6 | REQUIRED — BLOCKED BY SD-07 | AT-SEC-04 | `07` §11 |
| SEC-04 | Runtime DB role cannot alter tables or disable triggers | Youssef | production | REQUIRED — BLOCKED BY TD-17 | AT-SEC-08 | `07` §13 |
| SEC-05 | Production console access policy | Youssef | production | REQUIRED — BLOCKED BY SD-08 | access review record | `07` §13 |
| SEC-06 | Separation of duties for every sensitive operation in `07` §12 | Youssef | 0–7 | REQUIRED — BLOCKED BY SD-01 | AT-SEC-01, AT-SEC-03 | `07` §12 |
| RFD-01 | Refunds go to the original sending instrument whenever possible | Ibrahim (FD-26) | 3b | REQUIRED — BLOCKED BY FD-26 | AT-RFD-01 | `15` §2 |
| RFD-02 | Every refund destination verified as the customer's own before approval; evidence stored | Youssef (SD-10) | 3b | REQUIRED — BLOCKED BY SD-10 | AT-RFD-02 | `15` §4 |
| RFD-03 | Approval covers amount + destination; destination locked from APPROVED; change = re-verification + new approval; none while PROCESSING | Youssef (SD-10) | 3b | REQUIRED — BLOCKED BY SD-10 | AT-RFD-03, AT-RFD-04 | `15` §5 |
| RFD-04 | Re-authentication, notifications and cooling-off against account substitution | Youssef (SD-10) | 3b | REQUIRED — BLOCKED BY SD-10 | AT-RFD-05 | `15` §6 |
| RFD-05 | Execution evidence recorded and frozen after COMPLETED | Youssef | 3b | REQUIRED | AT-RFD-01 | `15` §7 |
| RFD-06 | Failed / returned transfers never re-send automatically; returned money re-recognized by a new journal | Youssef | 3b | REQUIRED | AT-RFD-06 | `15` §8 |
| RFD-07 | Refund destinations encrypted, masked, reveal audited, deleted after retention | Youssef (SD-10, SD-05) | 3b | REQUIRED — BLOCKED BY SD-10, TQ-21 | AT-RFD-08 | `15` §9 |
| RFD-08 | Undeliverable refunds stay a liability; no automatic absorption | Ibrahim (FD-26) | 3b | REQUIRED — BLOCKED BY FD-26 | AT-RFD-07 | `15` §11 |
| NTF-01 | Notifications only from committed outbox events; never read as state | Youssef | 3b | REQUIRED | AT-NTF-02 | `notifications-module-spec2.md` §1 |
| NTF-02 | In-app notices idempotent per event, recipient and type | Youssef | 3b | REQUIRED | AT-NTF-01 | `notifications-module-spec2.md` §3 |
| NTF-03 | Channel effects via effect rows; failures never block business flows | Youssef (TD-20) | 3b | REQUIRED — BLOCKED BY TD-20 (push / e-mail parts) | AT-NTF-02, AT-NTF-03 | `notifications-module-spec2.md` §3 |
| NTF-04 | Privacy rules for notification content | Youssef | 3b | REQUIRED | AT-NTF-04 | `notifications-module-spec2.md` §5 |
| NTF-05 | Transactional notices cannot be disabled | Ibrahim (BD-35) | 3b | REQUIRED — BLOCKED BY BD-35 | AT-NTF-05 | `notifications-module-spec2.md` §1 |
| NTF-06 | Security notices reach every registered contact; manual contact recorded where no channel reaches the user | Ibrahim (BD-35) / Youssef (TD-20) | production | REQUIRED — BLOCKED BY BD-35, TD-20 | AT-NTF-06 | `notifications-module-spec2.md` §5, §7 |
| HLD-01 | Workflow-level holds on outbound / irreversible money actions | Youssef (TD-19) | 3b | REQUIRED — BLOCKED BY TD-19 | AT-HLD-01 | `07` §14.2 |
| HLD-02 | Entity-level holds (vendor, order group, customer, account, settlement, courier) | Youssef (TD-19) / Ibrahim (FD-27) | 3b, 6 | REQUIRED — BLOCKED BY TD-19, FD-27 | AT-HLD-04 | `07` §14.2 |
| HLD-03 | Facts (incoming payments, collections, deliveries, receipts) are never held | Youssef | 3b | REQUIRED | AT-HLD-02 | `07` §14.2 |
| HLD-04 | Holds take effect for every transaction after activation; committed actions are not undone (L0 locks) | Youssef | 3b | REQUIRED — BLOCKED BY TD-19 | AT-HLD-03 | `07` §14.4 |
| HLD-05 | Two-person lift, audit of activation / lift / blocked attempts, no automatic expiry | Youssef / Ibrahim | 3b | REQUIRED — BLOCKED BY TD-19, FD-27 | AT-HLD-05 | `07` §14.3, §14.5 |
| INT-01 | Creating, receiving and inspecting an intake never increase sellable stock | Ibrahim (BD-36) | 2 | REQUIRED | AT-INV-14, AT-INV-17 | `19` §1, §4 |
| INT-02 | Separate intake / inspection / approval / dispute / acknowledgment statuses | Youssef | 2 | REQUIRED | AT-INV-14, AT-INV-17 | `19` §2 |
| INT-03 | Quantity identities, mutually exclusive categories, non-negative integers | Youssef | 2 | REQUIRED | AT-INV-16 | `19` §3 |
| INT-04 | Lines approved independently; a line needs completed inspection | Ibrahim (BD-36) | 2 | REQUIRED | AT-INV-15, AT-INV-17 | `19` §4 |
| INT-05 | Single authorized admin approval; vendor never approves; guarded transition; loser 409 | Ibrahim (BD-38) / Youssef (SD-11) | 2 | REQUIRED — SD-11 pending for self-approval | AT-INV-21, C-IN4 | `19` §5 |
| INT-06 | Accepted quantity posted exactly once per line, in one transaction with balance, movement, audit, outbox | Youssef | 2 | REQUIRED | AT-INV-22, AT-INV-32 | `19` §5 |
| INT-07 | Movements immutable; post-approval corrections only by approved adjustments with full references | Youssef | 2 | REQUIRED | AT-INV-23, AT-INV-33 | `19` §6 |
| INT-08 | Adjustments never negative, never below reserved + held, never cancel orders silently | Youssef | 2 | REQUIRED | AT-INV-24 | `19` §6 |
| INT-09 | Evidence rules per category; rejection reason mandatory; evidence and notes append-only | Youssef | 2 | REQUIRED | AT-INV-18, AT-INV-16 | `19` §8 |
| INT-10 | Internal notes and evidence never visible to vendors | Youssef | 2 | REQUIRED | AT-INV-31 | `19` §8–9 |
| INT-11 | Disputes per line, category and quantity; opening one changes no counted quantity | Ibrahim (BD-37) | 2 | REQUIRED — deadlines BLOCKED BY BD-41 | AT-INV-25, AT-INV-26 | `19` §7 |
| INT-12 | Only the disputed accepted quantity is frozen; undisputed accepted units stay sellable | Ibrahim (BD-37) | 2 | REQUIRED | AT-INV-28, AT-INV-29 | `19` §7 |
| INT-13 | Dispute resolutions that change stock go through adjustments; no automatic payable change | Ibrahim (BD-37) | 2 | REQUIRED | AT-INV-27 | `19` §7 |
| INT-14 | Intake submission idempotent (key + DB unique); new key = new intake | Youssef | 2 | REQUIRED | AT-INV-19, AT-INV-20 | `19` §11 |
| HND-01 | Acknowledgment required only when quantities differ | Ibrahim (BD-40, BD-25) | 2 | REQUIRED — deadline BLOCKED BY BD-41 | AT-HND-01, AT-HND-02 | `19` §10.1–10.2 |
| HND-02 | Both parties' quantities preserved; neither overwrites the other | Youssef | 2 | REQUIRED | AT-HND-02, AT-HND-06 | `19` §10 |
| HND-03 | Acknowledgment ≠ liability ≠ resolution; only an admin resolves, with a reason | Ibrahim (BD-40) | 2 | REQUIRED | AT-HND-03 | `19` §10.1 |
| HND-04 | Withdrawals: 4 days' notice, authorization ≤ available, dispatch posted once, hold until dispatch | Ibrahim (BD-39) | 2 | REQUIRED | AT-HND-04, AT-HND-05, C-HND1 | `19` §10.3 |
| HND-05 | Withdrawal discrepancies recorded with direction, visible to admin; customer returns separate | Youssef | 2 | REQUIRED | AT-HND-06, AT-HND-07, AT-HND-09 | `19` §10.3–10.4, §10.3.1 |
| HND-06 | No courier acknowledgment or inspection in vendor transfers; no financial consequence in the MVP | Ibrahim (BD-40) | 2 | REQUIRED | AT-HND-08 | `19` §10.1 |
| CPR-01 | Cart prices always current and computed on the server; never locked | Ibrahim (FD-21) | 3a | REQUIRED | AT-CPR-01, AT-CPR-02 | `20` §2 |
| CPR-02 | Per-item UNCHANGED / CHANGED / REVIEWED state with last-acknowledged baseline | Ibrahim (FD-21) | 3a | REQUIRED | AT-CPR-02, AT-CPR-03, AT-CPR-06, AT-CPR-07, AT-CPR-15 | `20` §3 |
| CPR-03 | Viewing is never acknowledgment; acknowledgment bound to a price version | Ibrahim (FD-21) | 3a | REQUIRED | AT-CPR-04, AT-CPR-05 | `20` §3.2–3.3 |
| CPR-04 | Checkout blocks unreviewed changes (409 `PRICE_CHANGED`); nothing created or charged | Ibrahim (FD-21) | 3a | REQUIRED | AT-CPR-08 | `20` §4 |
| CPR-05 | Final validation and snapshot atomic with order creation | Youssef | 3a | REQUIRED | AT-CPR-09, C-PR3 | `20` §4 |
| CPR-06 | Immutable per-item and per-order snapshot at order commit | Youssef | 3a | REQUIRED | AT-CPR-10, AT-CPR-11 | `20` §4.1 |
| CPR-07 | Payments and retries use the snapshot total | Youssef | 3a | REQUIRED | AT-CPR-12 | `20` §2, §5 |
| CPR-08 | Client-provided prices never trusted | Youssef | 3a | REQUIRED | AT-CPR-13 | `20` §2, §5 |
| CPR-09 | Delivery fee 80.00 EGP separate from the markup, never marked up | Ibrahim (FD-29) | 3a | REQUIRED | AT-CPR-14 | `20` §1 |
| CPR-10 | Markup is a configured, versioned input, never hard-coded, ready for a dynamic source | Ibrahim (FD-02, FD-28) / Youssef (TD-15) | 3a | REQUIRED — dynamic source BLOCKED BY FD-28 | AT-CPR-10, C-PR2 | `20` §1 |
| RSV-01 | Add-to-cart and cart edits never reserve stock | Youssef | 0 | REQUIRED | AT-RSV-01 | `21` §1 |
| RSV-02 | Reservation only in the checkout transaction, atomically with the snapshot; all lines or none | Youssef | 0 | REQUIRED | AT-RSV-02, AT-RSV-03, C-A | `21` §2 |
| RSV-03 | Per-method reservation lifetimes; deadlines are stored DB timestamps | Ibrahim (BD-07) | 0, 3, 4 | REQUIRED — values BLOCKED BY BD-07 | AT-RSV-03 | `21` §3 |
| RSV-04 | A proof counts only if submitted by its deadline, judged under the group lock | Youssef | 3 | REQUIRED | AT-RSV-04, AT-RSV-05, C-RSV1 | `21` §3.1 |
| RSV-05 | A timely proof keeps the reservation active until reviewed | Ibrahim (BD-18) | 3 | REQUIRED — BLOCKED BY BD-18 | AT-RSV-04, AT-RSV-06 | `21` §3.2 |
| RSV-06 | COD has no prepaid deadline; only the confirmation window can release it before confirmation | Ibrahim (BD-13) | 4 | REQUIRED — window BLOCKED BY BD-13 | AT-RSV-09, AT-RSV-10 | `21` §3 |
| RSV-07 | Release once, with the cancellation, never for paid / under-review / live-payment groups | Youssef | 0 | REQUIRED | AT-RSV-07, AT-RSV-08, AT-RSV-10, C-10 | `21` §4 |
| RSV-08 | Late Paymob success never lost, never fulfils a cancelled order | Ibrahim (BD-17) | 0 (deferred while PAYMOB is off) | REQUIRED — outcome BLOCKED BY BD-17 | AT-RSV-11, C-F2 | `21` §5 |
| RSV-09 | Missed maintenance never releases wrongly or extends deadlines; sweep-before-reserve | Youssef (TD-18) | 0 | REQUIRED | AT-RSV-05, AT-RSV-12, C-RSV2 | `21` §8 |
| RSV-10 | Snapshot never changed by reservation events; re-reservation at snapshot price | Youssef | 3 | REQUIRED | AT-RSV-13, AT-RSV-14 | `21` §9 |
| DSP-01 | Units handed to the courier leave `on_hand` / `reserved` in the handover transaction and are never available in courier custody | Youssef | 4 | REQUIRED | AT-DSP-01, AT-DSP-02, C-21 | `21` §3.3 |
| DSP-02 | Dispatched units return to available only via physical receipt into quarantine and an authorized ACCEPTED_RESTOCK inspection | Youssef | 4, 7 | REQUIRED | AT-DSP-03, AT-COU-03 | `21` §3.3, `03` §9.3 |
| DSP-03 | Courier role = transportation and custody only; no courier inspection or condition approval | Ibrahim (BD-40 scope) | 4 | REQUIRED | AT-DSP-03, AT-HND-08 | `21` §3.3 |
| MNT-01 | Scheduled expire-overdue run in production (proposed every 10 min; was 5 min until 2026-10-27); on-access expiry is only an extra safety net | Youssef (requirement confirmed 2026-10-27; mechanism TD-18) | 0 go-live | REQUIRED — mechanism BLOCKED BY TD-18 | AT-MNT-01 | `21` §8 |
| MNT-02 | Candidates selected only from stored database state, with the release guards | Youssef | 0 | REQUIRED | AT-MNT-01, AT-MNT-05 | `21` §8 |
| MNT-03 | Per-group transactions, `SKIP LOCKED`, guarded idempotent release | Youssef | 0 | REQUIRED | AT-MNT-03, AT-MNT-22, C-MNT1 | `21` §8 |
| MNT-04 | Missed / delayed runs catch up everything overdue in bounded batches; deadlines never extended | Youssef | 0 | REQUIRED | AT-MNT-02, AT-MNT-03 | `21` §8 |
| MNT-05 | Every run recorded (`MaintenanceRun`) with counts and errors | Youssef | 0 | REQUIRED | AT-MNT-01 | `21` §8, `02` |
| MNT-06 | Health metrics and alerts for failed or delayed maintenance: the alert catalogue A1 – A15 of `21` §8.6 with detection source, trigger, severity, operator action, recovery, auto-clear and deduplication; causes (worker, Redis, PostgreSQL, schedule, backlog, processing, release integrity) distinguishable; evaluated outside the worker and outside Redis, and **delivered by an external service** (heartbeat + health-endpoint monitors, `22` §4) so that alerts still reach an operator when PostgreSQL, Redis, the worker or the API is down | OD-01 | 0 go-live | REQUIRED — thresholds TBD with OD-01; alert tool TQ-33 | AT-MNT-04 | `21` §8, §8.6, `13` §5 |
| MNT-07 | One upserted BullMQ job scheduler with a fixed id for reservation expiry, every 10 min, empty payload, reusing the existing `orders` queue job | Youssef (TD-18) | 0 | REQUIRED — BLOCKED BY TD-18 | AT-MNT-06, AT-MNT-09 | `21` §8.1 |
| MNT-08 | Worker crash / Redis restart recovery: stalled-job re-delivery, scheduler re-registered on worker boot, catch-up from the database | Youssef (TD-18) | 0 | REQUIRED — BLOCKED BY TD-18 | AT-MNT-06, AT-MNT-07 | `21` §8.1 |
| MNT-09 | Concurrency: queue concurrency 1, single scheduler, per-group `SKIP LOCKED` and guarded release even if two workers run | Youssef (TD-18) | 0 | REQUIRED | AT-MNT-08, C-MNT1, C-MNT2 | `21` §8.1 |
| MNT-10 | Monitoring and alerting read PostgreSQL (`MaintenanceRun`, reservations), so they work when Redis or the worker is down | Youssef / OD-01 | 0 go-live | REQUIRED | AT-MNT-04, AT-MNT-07, AT-MNT-11 | `21` §8.1, §8.6, `13` §5 |
| MNT-11 | Schedule reconciliation: every 60 s and at boot, each worker / API instance verifies the fixed-id scheduler and recreates it idempotently if missing; works after Redis outage, data loss or FLUSHALL without manual intervention | Youssef (TD-18) | 0 | REQUIRED — BLOCKED BY TD-18 | AT-MNT-06, AT-MNT-11, AT-MNT-12, AT-MNT-13, C-MNT3 | `21` §8.2 |
| MNT-12 | Redis production settings: `noeviction`, persistence (AOF or RDB), restart behaviour, connection handling and monitoring confirmed on the real deployment | Youssef | 0 go-live | REQUIRED — BLOCKED BY TQ-27 | AT-MNT-11 | `21` §8.3 |
| MNT-13 | The manual `expire-overdue` command runs the service method directly, without Redis or BullMQ | Youssef | 0 | REQUIRED | AT-MNT-11, AT-MNT-23 | `21` §8.1 |
| MNT-14 | Bounded BullMQ job retention: completed jobs `removeOnComplete` (count 100, age 24 h) and finally failed jobs `removeOnFail` (count 1,000, age 7 days), proposed values; retries kept until their final attempt; history lives in `MaintenanceRun` | Youssef (TD-18) | 0 | REQUIRED — BLOCKED BY TD-18 | AT-MNT-10, AT-MNT-17 | `21` §8.3, §8.3.1 |
| MNT-15 | `MaintenanceRun` retention independent of BullMQ: removing or losing a BullMQ job never deletes or changes its `MaintenanceRun` row; no row deleted until the retention period (TD-24) is decided | Youssef | 0 | REQUIRED — period BLOCKED BY TD-24 | AT-MNT-17 | `21` §8.3.1, `02` |
| MNT-16 | Queue failure isolation when queues share one process: own worker, concurrency limit, retry / backoff and monitoring per queue; single-flight, non-blocking reconciler; a failing, retrying or backlogged reconciler / reconciliation never starves the outbox drain or reservation expiry; documented repeated-failure behaviour; shared process acceptable only under the conditions of `21` §8.5 | Youssef (TD-23) | 0 go-live (outbox), 3b+ (reconciliation) | REQUIRED if TD-23 selects a shared process — BLOCKED BY TD-23 | AT-MNT-16 | `21` §8.5 |
| MNT-17 | Worker lifecycle and supervision: starts on deploy, restarted automatically after a crash, health independent of the API, crash-loop alert, graceful shutdown that stops between groups within the host's grace period, Redis and PostgreSQL reconnection without crashing, non-blocking startup reconciliation, one schedule owner during deploys | Youssef (TD-18, TD-22) | 0 go-live | REQUIRED — BLOCKED BY TQ-16, TQ-28, TD-22 | AT-MNT-06, AT-MNT-11, AT-MNT-18, AT-MNT-19, AT-MNT-20 | `21` §8.8 |
| MNT-18 | Throughput, batch size, budget and backlog recovery measured before go-live on the rehearsal snapshot (500 – 10,000 overdue groups, concurrent API traffic, shared-process load); values confirmed or revised through TD-18 | Youssef | 0 go-live | REQUIRED — not measured | AT-MNT-21 | `21` §8.9 |
| PMA-01 | PAYMOB attempt lifecycle (attempt before provider call; one open attempt; cap never moved) | Youssef (TD-21) | PAYMOB activation | DEFERRED (not rejected) | `03` §3.1 tests | `21` §5.1 |
| PMA-02 | PAYMOB payment expiration with stored deadlines; release once | Youssef | PAYMOB activation | DEFERRED | C-X1, AT-RSV-11 | `21` §5.1 |
| PMA-03 | Webhook idempotency, amount and currency checks | Youssef | PAYMOB activation | DEFERRED | C-B, AT-FIN-02, AT-FIN-03 | `21` §5.1 |
| PMA-04 | Delayed success callbacks recorded, never fulfil a cancelled order | Youssef | PAYMOB activation | DEFERRED | C-F2, C-H1, C-H2, AT-FIN-04 | `21` §5.1 |
| PMA-05 | Approved late-payment behaviour implemented as decided | Ibrahim (BD-17) | PAYMOB activation | DEFERRED — BLOCKED BY BD-17 | AT-RSV-11 | `21` §5.1–5.2 |
| PMA-06 | Reconciliation when the webhook never arrives, by a scheduled executor | Youssef (R-D4, TD-18) | PAYMOB activation | DEFERRED — BLOCKED BY TQ-01, TD-18 | C-X1 | `21` §5.1 |
| PMA-07 | Refund path and Paymob settlement reconciliation | Youssef / Ibrahim (FD-12 deferred) | PAYMOB activation | DEFERRED | AT-RFD-01, REC-CHK-02 | `21` §5.1 |
| PMA-08 | Legacy `paymob*` projection in the same transaction; existing Paymob tests green | Youssef | PAYMOB activation | DEFERRED | C-P1, AT-PMA-01 | `21` §5.1, `06` §4 |
| PRG-01 – PRG-14 | Production readiness gate | Youssef + Ibrahim | production | REQUIRED (Youssef brief 2026-10-25) | `10` §6 | `10` §6 |
