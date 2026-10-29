-- The share of each person's measured storage that is history (PEP 0007 §3.5): _history/, _changes/, _requests/ and
-- legacy _trash/, so GET /fs/v1/usage and a folder's status can say "history uses 600 MB · Free up space". Kept as
-- the totals are: the measurement's figure plus what web writes charged to history since its claim (charged_history_*).
ALTER TABLE "usage" ADD COLUMN "history_bytes" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "usage" ADD COLUMN "history_objects" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "usage" ADD COLUMN "charged_history_bytes" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "usage" ADD COLUMN "charged_history_objects" INTEGER NOT NULL DEFAULT 0;
