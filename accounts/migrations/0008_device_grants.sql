-- Device grants a stolen laptop cannot extend (PEP 0003 §3.3, review of lane/devices r2 #1).
-- "kind": what made a session, recorded by the server when it creates it (auth.ts's session hook): "machine" for the
-- device grant's /device/token, "browser" for a sign-in. Only a browser session approves a device code; a session made
-- before this migration has none, and approves nothing until it signs in again.
-- "approvedSessionId": the browser session that approved a device code; the code redeems only while that session lives,
-- so revoking it (or the laptop it was stolen with) also stops the sign-ins it approved and nobody has used yet.
ALTER TABLE "session" ADD COLUMN "kind" TEXT;
ALTER TABLE "deviceCode" ADD COLUMN "approvedSessionId" TEXT;
