-- Admin portal (portal/): visibility rules, audit trail, forced password
-- change. Idempotent; runs after 30_grievance.sql and 31_svc_complaint.sql.

ALTER TABLE grievance.portal_users ADD COLUMN IF NOT EXISTS must_change_password boolean NOT NULL DEFAULT false;

-- Who did what in the portal. Complaint status changes are already in
-- complaint_status_history; this covers everything else (users, assignment,
-- transfers, settings).
CREATE TABLE IF NOT EXISTS grievance.portal_audit (
    id       bigserial PRIMARY KEY,
    user_id  bigint REFERENCES grievance.portal_users (user_id),
    action   text NOT NULL,
    target   text,
    detail   jsonb NOT NULL DEFAULT '{}',
    ts       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS portal_audit_ts_idx ON grievance.portal_audit (ts);

-- The one place visibility is decided. Every portal read AND write goes
-- through this, so a bug in a route can't leak or change another
-- department's complaint. A disabled or unknown user sees nothing.
CREATE OR REPLACE FUNCTION grievance.complaints_visible_to(p_user_id bigint) RETURNS SETOF grievance.complaints
LANGUAGE sql STABLE AS $$
    SELECT c.*
    FROM grievance.complaints c
    JOIN grievance.portal_users u ON u.user_id = p_user_id AND u.enabled
    WHERE u.role = 'district_admin'
       OR (u.role = 'dept_head' AND c.department_id = u.department_id)
       OR (u.role = 'field_officer' AND c.assigned_officer_user_id = u.user_id)
$$;

-- Defense in depth for assignment (the portal checks this too): a complaint
-- can only be assigned to an enabled field officer of its own department.
-- Checked only when the assignee changes, so disabling an officer later never
-- blocks unrelated updates to complaints they were already holding.
CREATE OR REPLACE FUNCTION grievance.check_assignee() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.assigned_officer_user_id IS NOT NULL
       AND (TG_OP = 'INSERT' OR NEW.assigned_officer_user_id IS DISTINCT FROM OLD.assigned_officer_user_id)
       AND NOT EXISTS (
           SELECT 1 FROM grievance.portal_users u
           WHERE u.user_id = NEW.assigned_officer_user_id AND u.enabled
             AND u.role = 'field_officer' AND u.department_id = NEW.department_id) THEN
        RAISE EXCEPTION 'complaint % can only be assigned to an enabled field officer of its own department', NEW.complaint_id;
    END IF;
    RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS complaints_assignee ON grievance.complaints;
CREATE TRIGGER complaints_assignee BEFORE INSERT OR UPDATE ON grievance.complaints
FOR EACH ROW EXECUTE FUNCTION grievance.check_assignee();

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA grievance TO grievance_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA grievance TO grievance_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA grievance TO grievance_app;
