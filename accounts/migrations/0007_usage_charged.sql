-- What web writes have charged since the person's current measurement claimed (PEP 0003 §3.7, review r6 #2). A claim
-- zeroes it; a write's charge adds to it as well as to the figure; the measurement stores its listing plus it. WHY: a
-- listing taken before a write landed, stored as it was, erased that write's charge and could renew write access.
ALTER TABLE "usage" ADD COLUMN "charged_bytes" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "usage" ADD COLUMN "charged_objects" INTEGER NOT NULL DEFAULT 0;
