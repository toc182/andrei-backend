-- 078_audit_log_user_id_not_null.sql
-- C7 schema audit: enforce that every audit log entry records who did the action.
-- registrarAudit() requires userId: number in TypeScript and all callers pass
-- req.user!.id (post-authenticateToken). This closes the gap at the schema level.

ALTER TABLE audit_log ALTER COLUMN user_id SET NOT NULL;
