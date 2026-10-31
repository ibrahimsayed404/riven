# 18 — Business Decision Package (for Ibrahim)

> Status: **for decision** · 2026-10-25 (v6). Written so Ibrahim can decide without reading the technical documents. **Nothing in this package is approved.** Each item gives the question, the recommendation, the alternatives, the impact and what happens if the decision waits. Technical background is linked for anyone who wants it. Approver for every BD / FD item: **Ibrahim** (FD-01 and FD-20 jointly with Youssef).

## Decided on 2026-10-27 (reported by Youssef — please confirm in writing)
BD-24 and BD-25 (revised: acknowledgment only when quantities differ), BD-36 partial intake approval, BD-37 dispute freeze limited to the disputed accepted quantity, BD-38 single admin approval for intake / disputes / adjustments, BD-39 four days' notice for withdrawals, BD-40 handover acknowledgment only on discrepancy, **FD-02 markup approved** (the percentage stays a variable and will become dynamic), FD-21 cart price-change acknowledgment, **FD-29 flat delivery fee 80.00 EGP per order** (temporary). The sections below that still present these as open are kept for history.

**PAYMOB (2026-10-27):** PAYMOB is **deferred, not cancelled** — it stays in Riven, disabled in production, and will be built and switched on later. Ibrahim decides **BD-43** (when to activate it) and **BD-17** (what happens when a payment arrives after the order expired: refund, as recommended, or revive the order). Neither is decided; the refund behaviour in the documents is only a recommendation. BD-17 is no longer needed for Phase 0 go-live (no payment method is live then); it is needed before transfers go live (Phase 3b) and before PAYMOB activation.

**Still needed from Ibrahim because of these decisions:** BD-08 (receive and verify before selling — presupposed by BD-36 – BD-40 but not yet confirmed explicitly), BD-41 (deadlines for acknowledgment, disputes and resolution; calendar vs business days for the 4-day notice), BD-42 (over-delivery), FD-28 (what "dynamic markup" means), FD-17 (what existing vendor prices mean at go-live — not settled by FD-21).

## How to answer
For each decision write one of: **Approve as recommended** · **Approve option …** · **Reject / change: …** · **Need more information: …** — with the date. Youssef records it in `08-decision-register.md`.

## 0. Context in five lines
1. Riven will hold vendors' stock, ship it, collect money (bank / InstaPay / wallet transfers checked by staff, and later cash on delivery), and pay vendors monthly.
2. The design adds a 6 % markup on the vendor's price and a delivery fee that depends on where the customer lives.
3. Nothing is sold to real customers until the whole system (Phases 0–7) is finished and checked (BD-33).
4. Paymob stays switched off in production for now; cash on delivery stays off until courier cash reconciliation exists; returns stay off until the return policy is approved.
5. The decisions below change prices, money flows, legal positions or timelines — that is why they are Ibrahim's.

---

## 1. Decide first

### 1.1 BD-08 + BD-15 — Riven physically receives and verifies stock before it can be sold
**Question:** Do we sell only stock that Riven has physically received, counted and checked in its own warehouse?
**Recommendation (proposed by Youssef):** **Yes.** Vendors deliver stock to Riven; Riven counts and inspects it; only accepted units appear as available to customers. The build order is therefore strict: inventory → intake → payments (Phases 0 → 1 → 2 → 3).

What it means in practice:
| Topic | Proposed rule | Related decision |
|---|---|---|
| Ownership | goods stay the vendor's until sold (consignment); Riven is the custodian | BD-03 |
| Receiving | vendor declares quantities; Riven records what physically arrived, then splits it into **accepted**, **damaged**, **rejected**; **missing** = declared − received | BD-01 |
| Vendor check | the vendor sees Riven's count and has 7 days to accept it or dispute it; silence counts as acceptance | BD-24, BD-25 |
| Disputes | Riven's original count is never edited; a dispute ends in a recorded correction approved by two staff | BD-24 |
| Storage | Riven's warehouse; Riven is responsible for goods in its custody | FD-07 |
| Liability | vendor until Riven verifies; Riven while in its warehouse; the courier while in transit (Riven compensates the vendor and claims the courier) | FD-07, FD-25 |
| Discrepancies | daily automatic checks report differences; corrections only with a reason and two people | — |

**Alternatives:** (a) also sell stock still at the vendor's premises (vendor ships) — faster to launch, but Riven cannot guarantee availability or quality and must run two fulfilment models; (b) hybrid by vendor type.
**Impact:** nothing can be sold until Phases 1–2 are built and a warehouse with staff exists; when the new stock system switches on, every product shows 0 available until its stock is delivered and checked.
**If delayed:** Phase 1b cannot set which stock is sellable, and Phase 2 (intake) cannot start.

### 1.2 FD-02 — 6 % Riven markup on the vendor's rate
**Question:** Does Riven earn its income by adding a percentage on top of the vendor's price?
**Recommendation:** **Yes, 6 %, configurable.** Example: the vendor's rate is **500 EGP**; Riven adds **6 % = 30 EGP**; the customer pays **530 EGP** for the product, **plus a separate delivery fee**. The vendor receives the full 500 EGP. The markup is never applied to the delivery fee.

| | Markup (recommended) | Commission (alternative) |
|---|---|---|
| Vendor's price | 500 | 500 |
| Customer pays for the product | **530** | **500** |
| Vendor receives | **500** | **470** (6 % deducted) |
| Riven earns | 30 | 30 |

**Conflict to resolve explicitly:** the original Riven specification says *"No commission on product sales. No shopper-facing fees."* A markup is not a commission (nothing is deducted from the vendor), but it **is** a price increase the shopper pays — Ibrahim's approval of FD-02 also overrides that sentence (conflicts C5, C13).
**Other alternatives:** commission (above); a fixed fee per order; 0 % for now.
**Impact:** customer prices are 6 % above vendor rates; vendors must be told; the percentage can only be changed by a deliberate configuration change with a date (FD-23).
**If delayed:** no prices can be calculated for checkout (Phase 3a).

### 1.3 FD-04 (+ BD-30, FD-18, FD-08) — Delivery zones and fees
**Question:** How is the delivery fee set, who keeps it, and what happens when delivery fails?
**Recommendation:**
| Topic | Recommendation | Decision |
|---|---|---|
| Zones | by governorate, with optional city exceptions; staff configure zones and fees (two people approve each fee) | FD-04, BD-30 |
| Unserved / remote areas | areas without a zone cannot order (clear message at checkout); a remote area can be its own higher-fee zone | BD-30 |
| Customer charge | the zone fee in force when the order is placed; shown separately at checkout; later fee changes never change existing orders | FD-04 |
| Who keeps the fee | **Riven** (it is Riven's price; the courier's actual cost is Riven's expense) | FD-18 (a) |
| Courier payable | the courier's per-parcel cost, deducted from cash it remits or paid separately, per the courier contract | FD-10, TQ-04 |
| Failed / refused delivery | Riven bears the courier's return cost in the MVP; repeat refusers lose cash-on-delivery after 2 refusals in 90 days | FD-08, BD-05 |
**Alternatives:** flat national fee; fee owed straight to the courier (Riven does not count it as income — FD-18 b); free delivery above an order value.
**Needed from the business:** the list of zones and fees, and the courier's price list (TQ-17, TQ-04).
**If delayed:** checkout cannot charge delivery; transfers / COD cannot start (Phase 3a).

### 1.4 FD-17 — Prices vendors already entered
**Question:** Today's product prices were typed by vendors as the price customers pay. Under the markup model, what do they become?
**Options:**
- **(a)** they become the vendor rate → customer prices rise by 6 % when the new pricing starts;
- **(b)** they stay the customer price → the system works back to a vendor rate (500 → 471.70), so vendors receive less than they typed;
- **(c)** every vendor re-confirms each price before launch; unconfirmed products cannot be bought.
**Recommendation:** **(a) with advance notice to vendors**, or **(c)** if vendor trust matters more than speed. Never (b) without the vendor's explicit agreement.
**Process (any option):** vendors are told in writing what will happen and when; they can change their rate in the portal before the switch; carts always show current prices and checkout re-checks the price (the customer confirms again if it changed); orders already placed are never repriced; disputes go through support and are recorded. **No price is changed silently.**
**If delayed:** the pricing switch (Phase 3a) cannot be planned or announced.

### 1.5 BD-33 — What "launch" means
**Question:** Does the business accept that **no real customer order** is taken until every phase (0–7) is finished and the readiness gate (PRG-01 – PRG-14) is passed?
**Recommendation:** **Yes** (required by Youssef's 2026-10-25 brief). Inside that launch: Paymob off until its reconciliation can run unattended; cash on delivery off until courier cash reconciliation is complete (Phase 5); returns after delivery off until the return policy (BD-04) and the markup-on-returns rule (FD-19) are approved.
**Clarification:** "Phase 0 go-live" means deploying safer code, **not** opening the shop. A smaller launch (for example transfers only, no COD) would need an explicit, written exception approved by both Ibrahim and Youssef — none exists and none is recommended.
**If delayed:** no launch date can be planned.

### 1.6 FD-01 — How money is stored (joint with Youssef)
**Question (business part):** EGP only for now? Prices shown to two decimals? Markup rounded per item (e.g. 333.33 → markup 20.00 → 353.33)?
**Recommendation:** yes to all three (FD-01, FD-20). Technical detail: `17` §6.
**If delayed:** Phase 0 cannot start.

---

## 2. All other pending business and financial decisions

Grouped by the phase they block. "Rec." = recommendation; "If delayed" = what cannot proceed.

### Needed for Phase 0 go-live
| ID | Question | Rec. | Alternatives | If delayed |
|---|---|---|---|---|
| BD-07 | How long may an unpaid order hold stock? | Paymob 60 + 15 min, cap 90 min; transfer 2 h to submit, 24 h to resubmit, cap 72 h; COD confirmation 24 h | shorter / longer windows | defaults run unapproved |
| BD-17 | A payment arrives after the order was cancelled: refund or revive? (kept pending by Youssef) | always refund; customers may cancel while paying | revive if stock still available | late-payment handling stays a default |

### Phase 1–2 (inventory, intake)
| ID | Question | Rec. | Alternatives | If delayed |
|---|---|---|---|---|
| BD-01 | Does Riven take custody of all marketplace stock, from when? | yes, from the intake go-live | vendors keep stock; hybrid | intake cannot start |
| BD-03 | Who legally owns goods in Riven's warehouse? | consignment: vendor owns until sold (legal check) | Riven buys stock | accounting model unclear |
| BD-24 | Is accepted stock sellable when Riven verifies it, or only after the vendor accepts the count? | when Riven verifies | after vendor acceptance | intake rules unclear |
| BD-25 | How long does the vendor have to accept / dispute a count? | 7 days; silence = accepted | 3 / 14 days | defaults run unapproved |
| BD-34 | Show products with no verified stock? | show as out of stock | hide until first stock | default visible |
| FD-07 | Who bears loss or damage? | vendor until verification; Riven in custody; courier in transit | Riven insures everything | loss postings undefined |

### Phase 3 (pricing, payments, ledger)
| ID | Question | Rec. | Alternatives | If delayed |
|---|---|---|---|---|
| BD-06 | Max payment-proof attempts | 3 | 2 / 5 | default |
| BD-11 | Address required for card (Paymob) orders? | yes once Riven ships everything | optional | default |
| BD-12 | Which vendor types sell on the marketplace? | MARKETPLACE and BOTH | all | default |
| BD-18 | Stock when a payment proof waits past the hold limit | release; re-reserve on approval; refund if gone | keep holding | default |
| BD-19 | Proof review time promise | 4 business hours (Sun–Thu 10–18 Cairo) | 24 h | default |
| BD-35 | Notification channels at launch | in-app + staff queues; e-mail as soon as a provider exists; no SMS / WhatsApp | add SMS; e-mail from day one | security notices may not reach users who don't open the app |
| FD-05 | Customer sends too little / too much | too little: ask to correct; too much: approve and refund the excess; COD short: exception | accept small differences | proof review rules unclear |
| FD-14 | Cancel after paying, before shipping | allowed until handed to courier; full refund incl. delivery fee | no cancellation after payment | default |
| FD-16 | Opening balances if real money already exists | none unless the production check finds real payments | — | blocked until the data check (TQ-12) |
| FD-20 | Markup rounding (joint with Youssef) | per item, round half up, max 2 decimals in the percentage | per order | default |
| FD-21 | Price changed between cart and checkout | checkout re-checks; customer confirms the new total | honour cart price | default |
| FD-23 | Changing the 6 % later | a business decision with an effective date, announced to vendors | free change | — |
| FD-24 | Partial refunds: who pays (vendor or Riven)? | decided case by case by a finance approver with a written reason; never charged to the vendor automatically | fixed rules per reason | partial refunds blocked |
| FD-26 | Where refunds are sent | back to the original sending account (InstaPay / wallet) when possible; otherwise an account in the customer's own name, verified; no third-party accounts; undeliverable refunds stay owed (legal check TQ-30) | allow third parties; store credit | **Phase 3b cannot refund anyone** |
| FD-27 | Who may hold outgoing money (payouts / refunds) and for how long | finance approver for whole workflows, finance for one vendor / order; escalate to Ibrahim after 14 days (vendors) / 7 days (customers); tell the affected party a hold exists | no holds | no sanctioned way to stop money leaving during an incident |

### Phase 4–5 (fulfilment, COD)
| ID | Question | Rec. | Alternatives | If delayed |
|---|---|---|---|---|
| BD-02 | Riven fulfils all marketplace orders, from when? | yes, from a set date; older orders stay with vendors | vendors keep shipping | fulfilment cannot start |
| BD-05 | Repeated COD refusals | block COD after 2 refusals in 90 days | no limit | default |
| BD-09 | Several parcels per order | one parcel per order; staff may split | always per vendor | default |
| BD-13 | Phone confirmation before COD shipping | mandatory, within 24 h | optional | default |
| BD-14 | COD for every vendor; maximum COD order | yes; cap e.g. 5,000 EGP | no cap | default |
| BD-20 | What proves delivery | staff from courier status; COD only with the collected amount | customer confirmation | default |
| BD-26 | What vendors see about prices | vendor rate and customer price; not Riven's margin per order or delivery fees | show everything | default |
| BD-27 | Vendors see unpaid orders? | yes, without customer details | only paid | default |
| BD-31 | Restrict a vendor's selling without hiding the shop (new restriction levels) — reopens the earlier decision "suspend = reject" | yes (needed for investigations) | keep all-or-nothing suspension | only full suspension available |
| FD-06 | Courier pays part of what it owes | accept partial remittances and track the rest | refuse partials | blocked until the courier contract (TQ-04) |
| FD-08 | Who pays delivery / return / failed-delivery costs | customer fee covers delivery; Riven bears failed deliveries in the MVP; return shipping by fault | customer pays failed delivery | delivery postings undefined |
| FD-10 | Courier remittance frequency and deductions | per the courier contract | — | blocked until the contract (TQ-04) |
| FD-18 | Delivery fee: Riven income or courier's money? | Riven income; courier cost is Riven's expense | pass-through | delivery postings undefined |
| FD-25 | Goods lost / damaged by the courier | Riven compensates the vendor at the vendor rate and claims the courier | vendor waits for the courier | loss handling undefined |

### Phase 6 (statements, payouts)
| ID | Question | Rec. | Alternatives | If delayed |
|---|---|---|---|---|
| BD-10 | Vendor disputes a statement | within 14 days; undisputed lines still paid | no disputes | statements cannot be issued |
| BD-28 | Statement period | calendar month (Cairo), issued 3rd working day | fortnightly | default |
| BD-29 | Vendor confirms a payout arrived | within 7 days; silence = received | no confirmation | default |
| BD-32 | Vendors who are restricted / blocked keep access to their financial history | yes (read-only, or statements sent by finance if login is blocked) | no access | vendors could lose access to what they are owed |
| FD-03 | When is a sale payable to the vendor? | delivered, paid (COD: cash reconciled), return window closed; paid monthly from the statement | weekly; on delivery | payouts cannot start |
| FD-09 | Partial payouts | pay a settlement fully or not at all; leave disputed lines out | pay in parts | default |
| FD-11 | Vendor owes Riven after a return (negative balance) | carried to next statement; invoiced after 60 days; write-off only by two people | immediate invoice | **raised to blocking** (documentation proposal): returns after payout create these balances |
| FD-22 | Vendor says less money arrived than Riven sent | investigate; transfer fees borne by Riven; every outcome approved by a finance approver | vendor bears fees | payout disputes cannot be closed |

### Phase 7 (returns)
| ID | Question | Rec. | Alternatives | If delayed |
|---|---|---|---|---|
| BD-04 | Return and refund policy (must be checked against Egyptian consumer-protection law) | legal review first | — | returns stay off |
| FD-19 | On a return, does the customer get Riven's markup back? | yes — full price refunded; Riven earns nothing on returned items | no — refund only the vendor rate (legal risk) | returns stay off |

### Operational owners Ibrahim must name
OD-03 (payment problems), OD-04 (stock discrepancies), OD-05 (courier cash), OD-06 (financial reconciliation), OD-08 (incident communication, with Youssef) — `13` §4.1. None is named yet.

### Shared with Youssef
SD-01 — which people hold the finance-approver role (two different people are needed for every approval pair; recommended fallback: Ibrahim as standing approver). SD-05 — how long payment proofs, payout receipts and refund details are kept (legal retention period).

### Deferred (no decision needed now)
BD-16, BD-21, BD-22, BD-23, FD-12, FD-13, FD-15.
