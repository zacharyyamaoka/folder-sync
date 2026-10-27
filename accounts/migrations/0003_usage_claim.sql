-- One quota measurement per person at a time (PEP 0003 §3.7, review r2 #8): until when (ms) one request holds the
-- right to measure, so a burst of refreshes costs one listing and a failed one is not retried sooner.
ALTER TABLE "usage" ADD COLUMN "claimed_until" INTEGER NOT NULL DEFAULT 0;
