INSERT INTO "permissions" ("permission_key", "module", "description")
VALUES ('audit:read', 'audit', 'View the hospital''s audit log and activity history')
ON CONFLICT ("permission_key") DO UPDATE SET
  "module" = excluded."module",
  "description" = excluded."description";--> statement-breakpoint
INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id"
FROM "roles" r
JOIN "permissions" p ON p."permission_key" = 'audit:read'
WHERE r."is_system" = true
  AND r."scope" = 'HOSPITAL'
  AND r."slug" IN ('hospital_admin', 'branch_admin')
ON CONFLICT ("role_id", "permission_id") DO NOTHING;--> statement-breakpoint
CREATE INDEX "audit_logs_tenant_resource_id_idx" ON "audit_logs" ("tenant_id", "resource_id", "created_at");--> statement-breakpoint
CREATE INDEX "audit_logs_tenant_action_idx" ON "audit_logs" ("tenant_id", "action", "created_at");
