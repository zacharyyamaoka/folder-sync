-- A measurement that stopped once it saw the person over their quota is a lower bound, not a total (PEP 0003 §3.7,
-- review r4 #5): deletion credits on it never make the person "under quota"; a complete measurement must.
ALTER TABLE "usage" ADD COLUMN "partial" INTEGER NOT NULL DEFAULT 0;
