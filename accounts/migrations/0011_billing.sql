-- Payments (PEP 0003 §3.11, docs/PAYMENTS.md): the tables @better-auth/stripe 1.7.11 reads and writes, kept by hand from its
-- schema (src/schema.ts of the plugin: the `subscription` model and the user's `stripeCustomerId`), as 0001 keeps the core
-- tables. Additive: an app with payments off never touches either, and every existing row stays as it is.
-- "referenceId" is the person (their user id): a subscription is a person's, and goes when the person goes (ON DELETE CASCADE).
-- "plan" is the plan's name in lower case, which accounts/src/plans.ts reads back as the quota's source.
ALTER TABLE "user" ADD COLUMN "stripeCustomerId" TEXT;

CREATE TABLE "subscription" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "plan" TEXT NOT NULL,
  "referenceId" TEXT NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  "stripeCustomerId" TEXT,
  "stripeSubscriptionId" TEXT,
  "status" TEXT,
  "periodStart" DATE,
  "periodEnd" DATE,
  "trialStart" DATE,
  "trialEnd" DATE,
  "cancelAtPeriodEnd" INTEGER,
  "cancelAt" DATE,
  "canceledAt" DATE,
  "endedAt" DATE,
  "seats" INTEGER,
  "billingInterval" TEXT,
  "stripeScheduleId" TEXT
);

CREATE INDEX "subscription_reference" ON "subscription" ("referenceId");
CREATE INDEX "subscription_stripe" ON "subscription" ("stripeSubscriptionId");
