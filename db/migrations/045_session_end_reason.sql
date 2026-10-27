-- Why a session ended, for the sign-in history in Settings: signed out by the
-- user, ended after the book's idle limit, or revoked by an admin or a
-- password change. NULL while it is live, or when it simply expired.
ALTER TABLE sessions
  ADD COLUMN end_reason VARCHAR(20) NULL AFTER revoked_at,
  ADD KEY idx_sessions_org_created (org_id, created_at);
