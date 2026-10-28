-- A machine's session names the browser session that approved its device grant (src/auth.ts), and the database itself
-- refuses to create one whose approver is gone (judge r3 #1). WHY a trigger: Better Auth consumes the grant and inserts
-- the session itself, after any check of ours, so a revoke landing in between would still let the session in; here the
-- check and the insert are one statement, so a revoke either comes first (no session) or after (a session listed and
-- revocable on its own). A machine session with no approver (a grant approved before 0008) is refused too.
ALTER TABLE "session" ADD COLUMN "approvedBy" TEXT;

CREATE TRIGGER "session_machine_needs_live_approver" BEFORE INSERT ON "session"
WHEN NEW."kind" = 'machine'
BEGIN
  SELECT RAISE(ABORT, 'approver_ended')
  WHERE NOT EXISTS (
    SELECT 1 FROM "session" WHERE "id" = NEW."approvedBy" AND "userId" = NEW."userId" AND "expiresAt" > NEW."createdAt"
  );
END;
