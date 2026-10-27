-- A deletion no longer subtracts from the person's measured usage: it marks it stale and counts a mutation (PEP 0003
-- §3.7, review r5 #2). A measurement records the count when it claims; one that a mutation crossed is stored stale, so
-- the next request measures again. WHY: a credit that lands after a complete measurement counted it twice.
ALTER TABLE "usage" ADD COLUMN "stale" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "usage" ADD COLUMN "mutations" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "usage" ADD COLUMN "claim_mutations" INTEGER NOT NULL DEFAULT 0;
