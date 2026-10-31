# 04 — Ledger, Accounting Rules and Posting Examples

> **v7 note (2026-10-27):** FD-02 (markup on top of the vendor rate) is now **approved** by Ibrahim as reported by Youssef, with the percentage a variable that will become dynamic (FD-28); the approved temporary delivery fee is a **flat 80.00 EGP per order** (FD-29). The running example below still uses 60.00 as an illustrative fee — replace it by 80.00 when reading it as the current rule (total 1,034.00 instead of 1,014.00); the postings are otherwise identical. FD-18 (how the fee is booked) is still pending.

> Status: **DRAFT for review** · updated 2026-10-25 for the markup pricing model (FD-02, proposed) and location-based delivery fees (FD-04, proposed). The markup percentage (6 %), delivery fees and courier fees in the examples are **illustrative**: the percentage is `RIVEN_PROFIT_PERCENTAGE` (awaiting Ibrahim), fees depend on FD-04 / FD-10, and the delivery-fee treatment on FD-18.
>
> Superseded: earlier drafts deducted a commission and a fulfilment fee from the vendor (C14). Under the proposed model the vendor is owed exactly the **vendor rate × quantity**; Riven's income is the markup the customer pays on top.

## 1. Why double-entry, and how little of it

Riven will hold money that belongs to three other parties at different times: the **customer** (paid, not yet delivered), the **courier** (collected cash, not yet remitted), and the **vendor** (delivered, not yet settled). A double-entry ledger proves by construction where every pound is and whose it is.

The simplest reliable form for Riven: three tables (`ledger_accounts`, `ledger_journals`, `ledger_entries`) + `currencies`; a small fixed chart with per-vendor and per-courier sub-accounts; system postings written in the same transaction as the business event; balances computed by query, never stored.

## 2. Chart of accounts

Normal balance: assets and expenses increase with a **debit**; liabilities, equity and revenue increase with a **credit**.

| Code | Type | Normal | What it holds |
|---|---|---|---|
| `BANK:{receivingAccount}` | ASSET | Dr | money in each Riven InstaPay / wallet / bank account |
| `PAYMOB_CLEARING` | ASSET | Dr | Paymob captures not yet settled to the bank |
| `COURIER_RECEIVABLE:{courier}` | ASSET | Dr | COD cash collected by the courier, owed to Riven |
| `PAYOUTS_IN_TRANSIT` | ASSET | Dr | vendor payouts sent, not yet confirmed by Riven's bank |
| `PAYMENT_DISPUTES` | ASSET | Dr | money pulled back pending a dispute |
| `CUSTOMER_DEPOSITS` | LIABILITY | Cr | customer money for orders not yet delivered |
| `CUSTOMER_REFUND_PAYABLE` | LIABILITY | Cr | refunds approved, not yet paid |
| `VENDOR_PAYABLE:{vendor}` | LIABILITY | Cr | vendor rate × quantity for delivered items, less vendor-borne amounts (debit balance = vendor owes Riven) |
| `COURIER_PAYABLE:{courier}` | LIABILITY | Cr | courier charges owed by Riven; under FD-18 (b) also the pass-through delivery fee |
| `UNALLOCATED_COURIER_CASH:{courier}` | LIABILITY | Cr | remitted cash not yet matched |
| `RIVEN_PRODUCT_MARGIN` | REVENUE | Cr | Riven's markup on delivered items (`RIVEN_PROFIT_PERCENTAGE` of the vendor rate) |
| `DELIVERY_FEE_REVENUE` | REVENUE | Cr | delivery fees charged to customers — **only if FD-18 (a)** |
| `DELIVERY_EXPENSE` | EXPENSE | Dr | courier delivery cost — under FD-18 (a) |
| `RETURN_SHIPPING_EXPENSE` | EXPENSE | Dr | reverse logistics borne by Riven (FD-08) |
| `FAILED_DELIVERY_EXPENSE` | EXPENSE | Dr | refused / failed delivery costs borne by Riven (FD-08) |
| `COD_COLLECTION_FEES` | EXPENSE | Dr | courier COD handling fees (FD-10) |
| `PAYMENT_PROVIDER_FEES` | EXPENSE | Dr | Paymob fees |
| `PAYOUT_TRANSFER_FEES` | EXPENSE | Dr | bank/transfer fees on vendor payouts borne by Riven (FD-22) |
| `COURIER_LOSS_EXPENSE` | EXPENSE | Dr | written-off courier shortfalls |
| `INVENTORY_LOSS_EXPENSE` | EXPENSE | Dr | compensation for goods lost/damaged in Riven custody (FD-07) or courier custody before recovery from the courier (FD-25) |
| `VENDOR_BALANCE_WRITE_OFF` | EXPENSE | Dr | a negative vendor balance Riven decides not to recover (FD-11, maker-checker) |
| `CUSTOMER_GOODWILL_EXPENSE` | EXPENSE | Dr | the Riven-borne part of a partial refund beyond its margin (FD-24) |
| `OPENING_BALANCE_EQUITY` | EQUITY | Cr | opening entries only |

Under consignment (BD-03) Riven never owns the goods: no inventory asset, no cost of goods sold. Revenue is recognized **net** (only the markup), because the vendor rate is never Riven's money.

## 3. Currency, minor units and the markup

- `currencies(code, minor_units)`; seeded `EGP, 2`. Precision always comes from this table.
- Ledger amounts are `BIGINT` minor units, strictly positive (direction carries the sign); each account has one currency; each journal balances per currency; EGP only in the MVP (FD-15 deferred).
- **Markup arithmetic (FD-20, recommended):** the percentage is held as integer basis points (`RIVEN_PROFIT_PERCENTAGE=6` → 600 bps). Per **unit**:
  `rivenProfitMinor = round_half_up(vendorRateMinor × bps / 10 000)` · `customerUnitPriceMinor = vendorRateMinor + rivenProfitMinor`.
  Line amounts are unit amounts × quantity. All three unit values and the bps are **snapshotted on the order item** at checkout (`02` §3.2); the ledger uses the snapshot, never the current configuration.
- Worked check — vendor rate 500.00 EGP, 6 %: 50 000 × 600 / 10 000 = 3 000 piastres = **30.00 EGP** profit → **530.00 EGP** customer price.
- The delivery fee is a separate amount (zone rate snapshot) and is **never marked up** (FD-02).

## 4. How PostgreSQL guarantees balance and immutability

A row-level `CHECK` cannot validate a sum across entries; enforcement is by triggers (hand SQL, TD-02 approved). Column names below are illustrative.

```sql
-- 4.1 Balance per journal per currency, checked at COMMIT (deferred constraint trigger)
CREATE FUNCTION ledger_assert_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE j uuid := COALESCE(NEW.journal_id, OLD.journal_id);
BEGIN
  IF (SELECT count(*) FROM ledger_entries WHERE journal_id = j) < 2
     OR EXISTS (
       SELECT 1 FROM ledger_entries WHERE journal_id = j GROUP BY currency
       HAVING sum(CASE direction WHEN 'DEBIT' THEN amount_minor ELSE 0 END)
           <> sum(CASE direction WHEN 'CREDIT' THEN amount_minor ELSE 0 END))
  THEN
    RAISE EXCEPTION 'ledger journal % is unbalanced', j USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER ledger_entries_balance
  AFTER INSERT OR UPDATE OR DELETE ON ledger_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ledger_assert_balanced();

-- 4.2 Posted entries immutable; entries may be added to a POSTED journal only in the
--     transaction that posted it (now() = transaction start, constant within the tx).
CREATE FUNCTION ledger_entries_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s text; p timestamptz;
BEGIN
  SELECT status, posted_at INTO s, p FROM ledger_journals
   WHERE id = COALESCE(NEW.journal_id, OLD.journal_id) FOR SHARE;
  IF TG_OP IN ('UPDATE','DELETE') AND s = 'POSTED' THEN
    RAISE EXCEPTION 'posted ledger entries are immutable' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' AND s = 'POSTED' AND p <> now() THEN
    RAISE EXCEPTION 'cannot add entries to a journal posted in another transaction' USING ERRCODE = '23514';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;
CREATE TRIGGER ledger_entries_guard BEFORE INSERT OR UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION ledger_entries_guard();

-- 4.3 POSTED journals frozen except setting reversed_by_journal_id once.
-- 4.4 Entry currency must equal account currency (BEFORE INSERT).
```

Because the balance check is deferred to COMMIT, a business transaction that posts an unbalanced journal fails as a whole — the state change rolls back with it. A verification command (`POST /admin/ledger/verify`, run daily while workers are postponed, TD-13) re-checks every journal and the trial balance to detect a dropped trigger.

## 5. Journal lifecycle

| Kind | Lifecycle | Who |
|---|---|---|
| System posting | inserted as `POSTED` inside the business transaction | the workflow (`process` = route / command) |
| Manual adjustment | `DRAFT` → `PENDING_APPROVAL` → `POSTED` / `DISCARDED` | FINANCE creates; FINANCE_APPROVER (≠ creator, CHECK) posts |
| Reversal | new `POSTED` journal with mirrored entries; `reversesJournalId` unique | same permission as the original kind |

Nothing is edited or deleted; corrections are reversal + replacement.

## 6. Idempotent posting

`ledger_journals @@unique([sourceType, sourceId, postingKind])`. `postInTx` inserts with `ON CONFLICT DO NOTHING`; a conflict returns the existing journal if the payload hash matches, else raises `LEDGER_SOURCE_CONFLICT`. Two concurrent postings of one source → one journal.

## 7. Posting rules with EGP examples

**Running example.** Shopper buys from Vendor A one item at vendor rate **500.00** and from Vendor B one item at vendor rate **400.00**; markup 6 %; delivery zone fee **60.00** (illustrative).

| | Vendor rate | Riven profit (6 %) | Customer price |
|---|---:|---:|---:|
| Vendor A item | 500.00 | 30.00 | 530.00 |
| Vendor B item | 400.00 | 24.00 | 424.00 |
| Items | 900.00 | 54.00 | 954.00 |
| Delivery fee (zone) | — | — | 60.00 |
| **Customer pays** | | | **1,014.00** |

### 7.1 Order placed — no posting
A promise, not money. Nothing is recognized until money is received or collected.

### 7.2 Manual transfer approved (`PAYMENT_RECEIVED`)
| Account | Dr | Cr |
|---|---:|---:|
| BANK:instapay-main | 1,014.00 | |
| CUSTOMER_DEPOSITS | | 1,014.00 |

Overpayment (customer sent 1,050.00, FD-05 recommended): Dr BANK 1,050.00 / Cr CUSTOMER_DEPOSITS 1,014.00 / Cr CUSTOMER_REFUND_PAYABLE 36.00.

### 7.3 Paymob payment (`PAYMENT_RECEIVED`) and provider settlement (`PROVIDER_SETTLEMENT`)
Dr PAYMOB_CLEARING 1,014.00 / Cr CUSTOMER_DEPOSITS 1,014.00. Settlement (30.00 fee): Dr BANK 984.00 / Dr PAYMENT_PROVIDER_FEES 30.00 / Cr PAYMOB_CLEARING 1,014.00.

### 7.4 COD collected by courier (`COD_COLLECTED`)
Dr COURIER_RECEIVABLE:courier-1 1,014.00 / Cr CUSTOMER_DEPOSITS 1,014.00. Delivery alone never posts to Riven's bank.

### 7.5 Delivery confirmed — vendor payables, margin, delivery fee (`DELIVERED`, one journal per shipment)
**FD-18 (a) — delivery fee is Riven revenue (recommended):**
| Account | Dr | Cr |
|---|---:|---:|
| CUSTOMER_DEPOSITS | 1,014.00 | |
| VENDOR_PAYABLE:A (1 × 500.00) | | 500.00 |
| VENDOR_PAYABLE:B (1 × 400.00) | | 400.00 |
| RIVEN_PRODUCT_MARGIN (30.00 + 24.00) | | 54.00 |
| DELIVERY_FEE_REVENUE | | 60.00 |

**FD-18 (b) — pass-through:** the last line becomes Cr COURIER_PAYABLE:courier-1 60.00 and §7.6 posts nothing.

One `VENDOR_PAYABLE` credit entry **per order item** (amount = vendor rate × quantity from the snapshot), so statements and settlements work at item level. The posting key is `('SHIPMENT', shipmentId, 'DELIVERED')`; a repeat is idempotent, so a payable can never be created twice.

### 7.6 Courier delivery cost, FD-18 (a) (`DELIVERY_COST`)
Dr DELIVERY_EXPENSE 45.00 / Cr COURIER_PAYABLE:courier-1 45.00. (Riven's delivery margin in this example: 60.00 − 45.00 = 15.00.)

### 7.7 Courier remittance with deductions (`REMITTANCE`)
Statement: collected 1,014.00 − delivery cost 45.00 − COD fee 1 % (10.14) → remits **958.86**.
| Account | Dr | Cr |
|---|---:|---:|
| BANK:main | 958.86 | |
| COURIER_PAYABLE:courier-1 | 45.00 | |
| COD_COLLECTION_FEES | 10.14 | |
| COURIER_RECEIVABLE:courier-1 | | 1,014.00 |

**Short payment** (remits 900.00): allocate 900.00 + deductions 55.14; `COURIER_RECEIVABLE` keeps **58.86** owed; write-off only with FINANCE_APPROVER.
**Excess** (remits 1,000.00): Dr BANK 1,000.00 / Dr COURIER_PAYABLE 45.00 / Dr COD_COLLECTION_FEES 10.14 / Cr COURIER_RECEIVABLE 1,014.00 / Cr UNALLOCATED_COURIER_CASH 41.14.

### 7.8 Vendor payout, confirmation and discrepancy
Sent (`PAYOUT_SENT`): Dr VENDOR_PAYABLE:V / Cr PAYOUTS_IN_TRANSIT. Riven's bank confirms (`PAYOUT_CONFIRMED`): Dr PAYOUTS_IN_TRANSIT / Cr BANK. Failed: reversal of the sent journal.

**The vendor's receipt confirmation posts nothing** — it is a statement by the vendor, recorded separately. A discrepancy is resolved by a journal that matches its cause. Example from the brief: Riven sent **30,000.00**, vendor confirms **28,000.00** → discrepancy **2,000.00** (OPEN; Riven's 30,000.00 record unchanged).

| Resolution (FD-22) | Journal |
|---|---|
| Bank fee, borne by Riven | Dr PAYOUT_TRANSFER_FEES 2,000.00 / Cr VENDOR_PAYABLE:V 2,000.00 (Riven still owes it; paid by a top-up payout) |
| Bank fee, borne by the vendor (if agreed) | none; resolution recorded with evidence |
| 2,000.00 bounced back to Riven's account | Dr BANK 2,000.00 / Cr VENDOR_PAYABLE:V 2,000.00 (re-owed) |
| Riven's bank actually sent only 28,000.00 | Dr BANK 2,000.00 / Cr VENDOR_PAYABLE:V 2,000.00 (the payout record stays 30,000.00; the correction explains the difference) |
| Vendor error (evidence shows 30,000.00 arrived) | none |
| Top-up sent | a new payout (own settlement line from the re-owed amount) |

### 7.9 Refund before delivery (cancellation after payment, FD-14)
Approved: Dr CUSTOMER_DEPOSITS 1,014.00 / Cr CUSTOMER_REFUND_PAYABLE 1,014.00. Paid: Dr CUSTOMER_REFUND_PAYABLE / Cr BANK (or PAYMOB_CLEARING). **No vendor payable or margin was ever recognized**, so nothing else is reversed.

### 7.10 Return after delivery (Vendor B's item returned) — FD-19 **pending**, both options shown
Neither option is assumed. While FD-19 and BD-04 are pending, returns after delivery are disabled in production (RET-02); the posting is chosen by configuration only after Ibrahim's decision.

**Option (a) — markup refunded with the item** (recommended in `08`; customer gets the full 424.00, delivery fee kept per FD-14/FD-08):
| Account | Dr | Cr |
|---|---:|---:|
| VENDOR_PAYABLE:B | 400.00 | |
| RIVEN_PRODUCT_MARGIN | 24.00 | |
| CUSTOMER_REFUND_PAYABLE | | 424.00 |

**Option (b) — markup not refundable** (customer gets 400.00; needs a legal check under BD-04 because the customer paid 424.00):
| Account | Dr | Cr |
|---|---:|---:|
| VENDOR_PAYABLE:B | 400.00 | |
| CUSTOMER_REFUND_PAYABLE | | 400.00 |

Either way the entries posted at delivery (§7.5) are untouched; this is a new journal with posting key `('REFUND', refundId, 'RETURN_REVERSAL')`. If Vendor B was already paid, `VENDOR_PAYABLE:B` now shows a 400.00 **debit** balance (owed by the vendor), carried to the next statement (§7.16, FD-11).

### 7.11 Return shipping cost (FD-08)
Riven: Dr RETURN_SHIPPING_EXPENSE / Cr COURIER_PAYABLE. Vendor (wrong/damaged item): Dr VENDOR_PAYABLE:B / Cr COURIER_PAYABLE (shown on the statement as a DEDUCTION line with its explanation). Customer: deducted from the refund, credited to DELIVERY_FEE_REVENUE (FD-18 a).

### 7.12 Refused / failed COD delivery
Nothing collected, nothing to deposits. Courier return fee: Dr FAILED_DELIVERY_EXPENSE 45.00 / Cr COURIER_PAYABLE 45.00.

### 7.13 Late Paymob payment (exception)
Dr PAYMOB_CLEARING 1,014.00 / Cr CUSTOMER_REFUND_PAYABLE 1,014.00.

### 7.14 Disputed payment (pulled back by bank/provider)
Dr PAYMENT_DISPUTES / Cr BANK; resolved by reversal (won) or by the loss treatment per FD-07 (lost).

### 7.15 Goods lost in Riven custody (FD-07)
Compensation at the vendor rate: Dr INVENTORY_LOSS_EXPENSE 500.00 / Cr VENDOR_PAYABLE:A 500.00. No margin is recognized on a lost item.

### 7.16 Negative vendor balance after payout, and its recovery (FD-11 pending)
Vendor V was paid **15,000.00** for 30 items (statement and payout confirmed). Two items (500.00 vendor rate each, 530.00 customer price) are then returned and refunded in full under FD-19 (a):

| Step | Journal (new; nothing posted earlier is changed) | V's balance |
|---|---|---:|
| after the payout | — | 0.00 |
| return reversal | Dr VENDOR_PAYABLE:V 1,000.00 · Dr RIVEN_PRODUCT_MARGIN 60.00 · Cr CUSTOMER_REFUND_PAYABLE 1,060.00 | **−1,000.00** (V owes Riven) |
| refund paid | Dr CUSTOMER_REFUND_PAYABLE 1,060.00 · Cr BANK 1,060.00 | −1,000.00 |
| next month: 6 items delivered | Cr VENDOR_PAYABLE:V 3,000.00 (part of the §7.5 journal) | 2,000.00 |
| next settlement | nets −1,000.00 with +3,000.00 → pays **2,000.00** (Dr VENDOR_PAYABLE:V / Cr PAYOUTS_IN_TRANSIT) | 0.00 |

If no new sales arrive, the settlement net is not positive and nothing is paid (409 `SETTLEMENT_NET_NOT_POSITIVE`); the negative balance is the opening balance of every following statement. Recovery options (FD-11, pending; each is a new journal + audit, maker FINANCE, checker FINANCE_APPROVER):
- **Vendor repays:** Dr BANK 1,000.00 / Cr VENDOR_PAYABLE:V 1,000.00 (evidence: transfer reference).
- **Write-off:** Dr VENDOR_BALANCE_WRITE_OFF 1,000.00 / Cr VENDOR_PAYABLE:V 1,000.00 (reason required).
- Recommended trigger: invoice after 60 days without enough sales to net it (`08` FD-11).

### 7.17 Partial refund (FD-24 pending)
Customer keeps a 530.00 item but receives a 100.00 partial refund (e.g. a minor defect). The split is not automatic: FINANCE_APPROVER states it, with a reason, on the refund (`refunds.vendorShareMinor` / `rivenShareMinor`, CHECK: they sum to the amount).
- Vendor fault, split 100.00 to the vendor: Dr VENDOR_PAYABLE:V 100.00 / Cr CUSTOMER_REFUND_PAYABLE 100.00.
- Riven goodwill: Dr RIVEN_PRODUCT_MARGIN 30.00 (at most the item's margin) · Dr CUSTOMER_GOODWILL_EXPENSE 70.00 / Cr CUSTOMER_REFUND_PAYABLE 100.00.
After payout the vendor part creates a debit balance exactly as §7.16. Before delivery nothing was recognized, so a partial refund comes from `CUSTOMER_DEPOSITS` only (§7.9).

### 7.18 Goods lost or damaged in courier custody (FD-25 pending)
Recommended (FD-25): Riven compensates the vendor at the vendor rate and claims the courier.
- Compensation: Dr INVENTORY_LOSS_EXPENSE 500.00 / Cr VENDOR_PAYABLE:A 500.00.
- Claim recognized when the courier accepts liability (evidence: courier acknowledgment): Dr COURIER_RECEIVABLE:courier-1 500.00 / Cr INVENTORY_LOSS_EXPENSE 500.00; settled through a remittance deduction or payment like any courier balance (§7.7).
- Customer: a prepaid order is refunded (§7.9) or re-shipped; a COD order collected nothing.

## 8. No double counting — the rules

1. Customer money is a **liability** (`CUSTOMER_DEPOSITS` or `COURIER_RECEIVABLE` counterpart) until delivery.
2. Vendor payable and Riven margin are recognized **once, at delivery**, per shipment, from the order-item snapshot; the posting key makes a second posting impossible.
3. A cancellation **before** delivery refunds from deposits; it never touches vendor payable or margin.
4. A return **after** delivery reverses exactly the lines recognized for that item — its vendor payable, plus its margin only under FD-19 option (a) (pending, §7.10) — never more, and always as a new journal.
5. The delivery fee is booked once, per FD-18, and is never part of the vendor payable or of the margin.
6. Statements and settlements **read** ledger entries; they never create vendor liabilities. Only payouts and resolutions post.

## 9. Vendor statements reconcile with the ledger

For vendor V and period P (`vendor-settlement-spec.md` §3):
- `openingBalance` = Σ `VENDOR_PAYABLE:V` entries before P.
- Every ledger entry on `VENDOR_PAYABLE:V` inside P becomes exactly one statement line (`@@unique([statementId, ledgerEntryId])`), with its explanation built from the order-item snapshot.
- `closingBalance` = opening + Σ lines = Σ `VENDOR_PAYABLE:V` entries before the end of P (asserted when the statement is issued; mismatch → issue refused).
- `payableNow` = Σ eligible lines (FD-03) carried forward from this and earlier statements, net of debits.

Example from the brief — 30 items at a 500.00 vendor rate, delivered and eligible in the period:

| Description | Amount (EGP) |
|---|---:|
| Opening balance | 0.00 |
| 30 sold items × 500.00 vendor rate | 15,000.00 |
| Returns / adjustments | 0.00 |
| Agreed deductions | 0.00 |
| Payouts in period | 0.00 |
| **Net payable** | **15,000.00** |

Each SALE line explains itself, e.g. "1 × 500.00 EGP vendor rate · order RV-8F3A21 · delivered 2026-10-04", and links to its order reference.

## 10. Derived balances and reports

| Report | Query |
|---|---|
| Vendor balance | Σ credits − Σ debits on `VENDOR_PAYABLE:{vendor}` |
| Riven product margin | balance of `RIVEN_PRODUCT_MARGIN` per period |
| Delivery result | `DELIVERY_FEE_REVENUE` − `DELIVERY_EXPENSE` − `FAILED_DELIVERY_EXPENSE` − `RETURN_SHIPPING_EXPENSE` |
| Courier owes | balance of `COURIER_RECEIVABLE:{courier}` |
| Money held for customers | balance of `CUSTOMER_DEPOSITS` |
| Refunds owed | balance of `CUSTOMER_REFUND_PAYABLE` |
| Open payout discrepancies | Σ OPEN `payout_discrepancies` (not a ledger balance until resolved) |
| Trial balance | must net to 0 per currency |

## 11. Permissions on the ledger

| Action | Permission |
|---|---|
| Read own statement / balance | the vendor (own sub-account only) |
| Read any account, trial balance | FINANCE, FINANCE_APPROVER |
| Manual adjustment (DRAFT) | FINANCE |
| Post adjustment / reversal / discrepancy resolution | FINANCE_APPROVER, ≠ creator (CHECK) |
| System postings | workflows only — no endpoint can post a system kind |
