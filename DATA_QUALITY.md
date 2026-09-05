# Data quality review — `data/Demo Broking Data (RAW).xlsx`

One sheet, `Policies`: 961 data rows, 18 columns, covering inceptions from January 2024
to June 2026. Raw totals are £17,904,594 GWP and £2,707,605 revenue. 382 rows (40%)
carry at least one defect; row-level detail is in [dq_exceptions.csv](data/dq_exceptions.csv).

Reviewed as at 5 September 2026.

## What's wrong, and what to do about it

**Duplicate policy IDs (9 rows, £403,516 GWP).** Nine policy IDs appear twice. Six pairs are
byte-identical and can be dropped outright. In the other three — BTD-2024-00007,
BTD-2024-00041 and BTD-2025-00443 — the two copies disagree on GWP, and in each case one
copy reconciles to Premium ÷ FX and the other doesn't. Dedupe on Policy ID keeping the row
that reconciles, rather than keeping the first occurrence. Longer term, Policy ID should
carry a unique constraint at the point of load.

**Negative GWP (4 rows, £116,129 swing).** BTD-2024-00043, BTD-2025-00372, BTD-2025-00456
and BTD-2025-00453 all have positive local premium but negative GWP and revenue, so these
are sign errors on conversion rather than genuine cancellations or return premiums. Take
the absolute value, but confirm with the account owner first — if the business does book
return premiums, a blanket abs() would mask them, and the load should instead reject
negative GWP where premium is positive.

**GWP that doesn't reconcile to premium and FX (3 rows, £7,972 overstated).** The three
EUR policies noted above were converted at roughly 1.017 rather than the 1.17 in their own
FX column. Recalculate GWP as Premium ÷ FX and revenue as GWP × brokerage, then assert the
identity on every row at load time. Elsewhere the arithmetic is sound: FX is internally
consistent (one rate per currency) and all 961 revenue figures tie to GWP × brokerage.

**Numbers stored as text (14 rows, both money columns).** Fourteen rows hold GWP and
revenue as strings with thousands separators — `"56,880.00"` rather than 56880. In Excel
these are silently excluded from SUM, so any total taken straight off the sheet understates
GWP by about £340k. Strip separators and coerce to numeric on load, and reject anything
that won't parse rather than treating it as zero.

**Mixed date formats (40 rows).** Inception dates are ISO (`2024-10-13`) except for 40 rows
in UK day-first text (`23/06/2025`), 12 of which are ambiguous — `01/02/2026` parses as
either 1 February or 2 January depending on locale. Every other field in these rows is
British, so parse day-first and store ISO. This one matters most: a default US-locale parse
silently moves twelve policies into the wrong month and quarter, with no error raised.
Expiry dates are already uniformly ISO.

**Impossible dates (5 rows).** Two policies have inception years of 2042 and 2205; in both
cases the Policy ID prefix gives the correct year (BTD-2024-00135 → 2024-05-01,
BTD-2025-00434 → 2025-03-01), so these can be corrected mechanically and the ID-prefix
check made permanent. Three more — BTD-2026-00743, BTD-2025-00537 and BTD-2026-00786 — expire
before they incept, by 65 to 117 days. The pattern looks like a year typo in the expiry, but
there isn't enough in the row to be sure, so send these three back for manual correction.
Policy terms are otherwise clean: 6, 12 or 24 months with no other outliers.

**Stale status (95 rows, £1,553,412 GWP).** Ninety-five policies are marked Live but expired
before today, a median of 49 days ago and one as long as 364 days. Nothing is marked Expired
with a future expiry, so the status field is only ever stale in one direction — it looks like
status is set at bind and never swept. Two fixes: derive a `Status (Derived)` column from the
expiry date for reporting, and separately ask why the source system isn't ageing them off,
because 10% of the book showing as in-force when it isn't will distort any renewal pipeline
view.

**Inconsistent categories (four columns).** Product Line has 16 distinct values that should
be 12 — Kidnap & Ransom appears as itself, "Kidnap and Ransom" and "K&R"; Professional
Indemnity as itself, "Prof Indemnity" and "PI". Country has UK/United Kingdom, USA/US/United
States. Account Owner has "Eleanor Voss", "Eleanor  Voss" (double space) and "E Voss", plus
"marcus ridley" lower-cased. Currency has trailing spaces, a lower-case "usd" and three rows
of "US$". Distribution has trailing spaces and a lower-case "retail". None of this is hard
to fix — trim, normalise case, apply an alias map — but until it is, any group-by splits the
same broker or product across two or three lines. The right home for the alias maps is a
`Lookups` sheet or reference table, validated on load, rather than logic buried in the
dashboard.

## What's actually fine

Worth stating, because it narrows where to spend effort. No missing values anywhere except
Retail Broker, and that is structural — it is populated for all 492 wholesale rows and blank
for all 469 retail ones, which is correct. Country-to-region mapping is consistent for every
country including the alias spellings. Brokerage sits in a plausible 6.3%–27.0% band with no
outliers. Region, Business Type and Status have no spelling variants. Policy IDs all match
`BTD-YYYY-NNNNN`.

## Two things to watch that aren't errors

`Brokerage %` is a decimal fraction (0.2146), not a percentage, despite the column name.
Anything that multiplies by 100 on display will be right; anything that reads the header
literally will be out by two orders of magnitude. Rename it `Brokerage Rate` or store true
percentages.

Twelve rows share client, product line and inception date with a different policy but have a
distinct Policy ID, different premium and often a different account owner or currency. These
read as genuine separate placements — layers or sections — rather than duplicates, so they
are flagged Low in the register for eyeball only. Don't let a dedupe rule collapse them.

## Suggested order

Fix the money and dates first — dedupe, sign errors, FX recalculation, text-to-number, day-first
parsing, the two ID-derived year corrections. Those change reported numbers. Then normalise
the categories, which changes how the numbers group. Send the three impossible expiry dates
and the 95 stale statuses back to the source rather than patching them here, since both are
symptoms of the upstream system rather than of this extract.
