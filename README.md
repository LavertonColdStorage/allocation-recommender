# Allocation Recommender

Oldest-first, full-pallet stock allocation for sales orders in dotWMS.

## Live App

**URL:** `https://lavertoncoldstorage.github.io/allocation-recommender/`

## What it does

Staff creating sales orders in dotWMS weren't allocating stock the way the
warehouse actually wants — not consistently oldest-production-date-first,
not full-pallet-only, not consolidating picks by location. This tool takes
an order (tenant, item, warehouse, quantity) and recommends which ULDs
(pallets) to allocate, following the warehouse's real rules:

- Oldest production date first, but by whole location (not a single pallet)
- Full ULDs only — never break a pallet open
- Locations with mixed SKUs are skipped for full-pallet picking
- Work-in-progress spots (Pending Putaway, Staging, SMC, robot locations)
  are picked one ULD at a time, never swept as a whole location
- Damaged, Quarantined, and Mixed-type pallets are excluded — and if an
  excluded pallet would otherwise have been a valid pick, it's flagged so
  someone can check it before allocating
- Produces the `ULD Number` CSV dotWMS's bulk allocation upload expects

No API, no login, no data leaves your browser — you export a Stock On Hand
report from dotWMS as CSV and load it directly on this page.

## How to Use

1. Open the page
2. Run the **Stock On Hand – ULD** report in dotWMS (there's a direct link
   on the page), export it, and save it as **CSV UTF-8** (dotWMS exports as
   .xlsx by default — re-save it, plain "CSV" can mangle special characters)
3. Load that file on the page
4. Pick the tenant and warehouse, add a line per item and required quantity
5. Check fulfilment, download the bulk allocation CSV, upload it in dotWMS

## Files

- `index.html` — the order builder / UI
- `checks.js` — shared CSV parsing (also used by the stock-checks dashboard)
- `allocation.js` — the recommendation logic
- `Chilled-LavertonCS-1.png` — Laverton Cold Storage logo

## Questions / changes

Contact Matt Rowe.
