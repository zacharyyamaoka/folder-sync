-- A measurement's claim has an identity (PEP 0003 §3.7, review r3 #7): only the claim's own measurement may write its
-- result, so one that outlives its claim cannot overwrite a newer one.
ALTER TABLE "usage" ADD COLUMN "claim_token" TEXT NOT NULL DEFAULT '';
