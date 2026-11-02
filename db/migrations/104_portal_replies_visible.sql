-- The business's earlier replies on the portal (before 103 marked them), found
-- by the audit entry each one left, stay in the portal conversation. Staff
-- notes on the same documents left no such entry and stay inside.
UPDATE comments c
  JOIN audit_log a
    ON a.org_id = c.org_id
   AND a.target_type = c.target_type
   AND a.target_id = CAST(c.target_id AS CHAR)
   AND a.actor_user_id = c.user_id
   AND a.detail = CONCAT('Replied on the portal: ', LEFT(c.body, 200))
   SET c.portal_visible = 1
 WHERE c.user_id IS NOT NULL AND c.portal_visible = 0;
