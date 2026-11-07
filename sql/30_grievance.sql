-- grievance: complaint lifecycle + portal RBAC data, shared by the WhatsApp
-- svc_complaint service and the admin portal (portal/). Idempotent.
--
-- One schema, one source of truth: a status change made in the portal must be
-- visible on the citizen's very next WhatsApp message, with no sync job.
-- WhatsApp-only plumbing (ID generation, read snapshots) lives in svc_complaint
-- (sql/31_svc_complaint.sql), which is applied after this file.

CREATE SCHEMA IF NOT EXISTS grievance;

CREATE TABLE IF NOT EXISTS grievance.departments (
    department_id  serial PRIMARY KEY,
    dept_key       text NOT NULL UNIQUE,
    name_en        text NOT NULL,
    name_hi        text,
    enabled        boolean NOT NULL DEFAULT true
);

-- Kept separate from departments (even though today it's ~1:1) so re-mapping a
-- category to a different department later is a data edit, not a migration.
CREATE TABLE IF NOT EXISTS grievance.complaint_categories (
    category_key   text PRIMARY KEY,
    label_en       text NOT NULL,
    label_hi       text,
    department_id  int NOT NULL REFERENCES grievance.departments (department_id),
    sla_days       int NOT NULL DEFAULT 3,
    sort           int NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS grievance.portal_users (
    user_id             bigserial PRIMARY KEY,
    username            text NOT NULL UNIQUE,
    password_hash       text NOT NULL,          -- bcrypt
    full_name           text NOT NULL,
    role                text NOT NULL CHECK (role IN ('district_admin', 'dept_head', 'field_officer')),
    department_id       int REFERENCES grievance.departments (department_id),
    created_by_user_id  bigint REFERENCES grievance.portal_users (user_id),
    enabled             boolean NOT NULL DEFAULT true,
    created_at          timestamptz NOT NULL DEFAULT now(),
    last_login_at       timestamptz,
    CONSTRAINT portal_users_department_shape CHECK (
        (role = 'district_admin' AND department_id IS NULL) OR
        (role IN ('dept_head', 'field_officer') AND department_id IS NOT NULL)
    )
);

-- Defense in depth (the portal app enforces this too): a department head may
-- only create field_officer accounts in their own department.
CREATE OR REPLACE FUNCTION grievance.check_user_hierarchy() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE creator grievance.portal_users;
BEGIN
    IF NEW.created_by_user_id IS NOT NULL THEN
        SELECT * INTO creator FROM grievance.portal_users WHERE user_id = NEW.created_by_user_id;
        IF creator.role = 'dept_head' AND
           (NEW.role <> 'field_officer' OR NEW.department_id IS DISTINCT FROM creator.department_id) THEN
            RAISE EXCEPTION 'a department head may only create field_officer accounts in their own department';
        END IF;
    END IF;
    RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS portal_users_hierarchy ON grievance.portal_users;
CREATE TRIGGER portal_users_hierarchy BEFORE INSERT OR UPDATE ON grievance.portal_users
FOR EACH ROW EXECUTE FUNCTION grievance.check_user_hierarchy();

CREATE TABLE IF NOT EXISTS grievance.complaints (
    complaint_id             text PRIMARY KEY,          -- human-readable, e.g. SCB-2026-000123 (svc_complaint.next_complaint_id)
    citizen_wa_hash          text NOT NULL,              -- = core.hash_phone output; no second place deriving/storing phone numbers
    category_key             text NOT NULL REFERENCES grievance.complaint_categories (category_key),
    department_id            int NOT NULL REFERENCES grievance.departments (department_id),   -- copied at creation so a later re-map doesn't rewrite history
    description              text NOT NULL,
    lang                     text NOT NULL DEFAULT 'hi' CHECK (lang IN ('hi', 'en')),
    lat                      double precision NOT NULL,  -- from the citizen's WhatsApp location share (never from photo EXIF)
    lon                      double precision NOT NULL,
    status                   text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'assigned', 'in_progress', 'resolved', 'closed')),
    assigned_officer_user_id bigint REFERENCES grievance.portal_users (user_id),
    due_at                   timestamptz,                -- created_at + category.sla_days
    created_at               timestamptz NOT NULL DEFAULT now(),
    updated_at               timestamptz NOT NULL DEFAULT now(),
    closed_at                timestamptz
    -- 'closed' is final: there is no reopen transition anywhere in this system.
);
CREATE INDEX IF NOT EXISTS complaints_department_status_idx ON grievance.complaints (department_id, status);
CREATE INDEX IF NOT EXISTS complaints_citizen_idx ON grievance.complaints (citizen_wa_hash);
CREATE INDEX IF NOT EXISTS complaints_officer_idx ON grievance.complaints (assigned_officer_user_id) WHERE assigned_officer_user_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS grievance.complaint_status_history (
    id                  bigserial PRIMARY KEY,
    complaint_id        text NOT NULL REFERENCES grievance.complaints (complaint_id) ON DELETE CASCADE,
    from_status         text,
    to_status           text NOT NULL,
    changed_by_user_id  bigint REFERENCES grievance.portal_users (user_id),   -- NULL = citizen/system action (e.g. intake)
    remark              text,
    ts                  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS complaint_status_history_complaint_idx ON grievance.complaint_status_history (complaint_id, ts);

CREATE TABLE IF NOT EXISTS grievance.complaint_evidence (
    id                   bigserial PRIMARY KEY,
    complaint_id         text NOT NULL REFERENCES grievance.complaints (complaint_id) ON DELETE CASCADE,
    uploaded_by          text NOT NULL CHECK (uploaded_by IN ('citizen', 'officer')),
    uploaded_by_user_id  bigint REFERENCES grievance.portal_users (user_id),
    wa_hash              text,
    file_path            text NOT NULL,     -- relative path on the shared complaint_media volume
    mime_type            text NOT NULL,
    kind                 text NOT NULL CHECK (kind IN ('photo', 'pdf')),
    sha256               text,
    ts                   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS complaint_evidence_complaint_idx ON grievance.complaint_evidence (complaint_id);

CREATE TABLE IF NOT EXISTS grievance.notification_outbox (
    id            bigserial PRIMARY KEY,
    complaint_id  text NOT NULL REFERENCES grievance.complaints (complaint_id) ON DELETE CASCADE,
    wa_hash       text NOT NULL,
    template_key  text NOT NULL,
    payload       jsonb NOT NULL DEFAULT '{}',
    status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'sent', 'failed')),
    attempts      int NOT NULL DEFAULT 0,
    last_error    text,
    created_at    timestamptz NOT NULL DEFAULT now(),
    sent_at       timestamptz
);
CREATE INDEX IF NOT EXISTS notification_outbox_pending_idx ON grievance.notification_outbox (created_at) WHERE status = 'pending';

-- Portal session store (express-session + connect-pg-simple creates/manages
-- this table's rows; the shape below is that library's own, declared here so
-- a fresh migrate has it ready).
CREATE TABLE IF NOT EXISTS grievance.portal_sessions (
    sid     text PRIMARY KEY,
    sess    json NOT NULL,
    expire  timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS portal_sessions_expire_idx ON grievance.portal_sessions (expire);

-- District-admin-configurable settings (not core.settings: portal_rw has no
-- access to the core schema at all, and must still be able to edit this).
CREATE TABLE IF NOT EXISTS grievance.settings (
    key    text PRIMARY KEY,
    value  jsonb NOT NULL
);
INSERT INTO grievance.settings (key, value) VALUES
    ('geofence_enabled', 'false'),
    ('geofence_center_lat', 'null'),
    ('geofence_center_lon', 'null'),
    ('geofence_radius_m', '500')
ON CONFLICT (key) DO NOTHING;

CREATE OR REPLACE FUNCTION grievance.haversine_m(lat1 double precision, lon1 double precision, lat2 double precision, lon2 double precision) RETURNS double precision
LANGUAGE sql IMMUTABLE AS $$
    SELECT 2 * 6371000 * asin(sqrt(
        sin(radians(lat2 - lat1) / 2) ^ 2 +
        cos(radians(lat1)) * cos(radians(lat2)) * sin(radians(lon2 - lon1) / 2) ^ 2
    ))
$$;

-- Mandatory evidence before closure (defense in depth; the portal's close
-- route is the primary enforcement, see portal/routes/complaints.js). The
-- portal must insert the status_history row (with its remark) for the new
-- status BEFORE updating complaints.status, in the same transaction.
CREATE OR REPLACE FUNCTION grievance.check_closure_evidence() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE remark_ok boolean;
BEGIN
    IF NEW.status IN ('resolved', 'closed') AND NEW.status IS DISTINCT FROM OLD.status THEN
        SELECT (remark IS NOT NULL AND btrim(remark) <> '') INTO remark_ok
        FROM grievance.complaint_status_history
        WHERE complaint_id = NEW.complaint_id AND to_status = NEW.status
        ORDER BY ts DESC LIMIT 1;
        IF NOT coalesce(remark_ok, false) THEN
            RAISE EXCEPTION 'closing complaint % requires a remark recorded in complaint_status_history first', NEW.complaint_id;
        END IF;
        -- an OFFICER's photo: every complaint already arrives with the citizen's
        -- intake photo, which proves the problem, not the fix
        IF NOT EXISTS (SELECT 1 FROM grievance.complaint_evidence
                       WHERE complaint_id = NEW.complaint_id AND kind = 'photo' AND uploaded_by = 'officer') THEN
            RAISE EXCEPTION 'closing complaint % requires at least one photo uploaded by an officer', NEW.complaint_id;
        END IF;
    END IF;
    RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS complaints_closure_evidence ON grievance.complaints;
CREATE TRIGGER complaints_closure_evidence BEFORE UPDATE ON grievance.complaints
FOR EACH ROW EXECUTE FUNCTION grievance.check_closure_evidence();

-- ---------------------------------------------------------------------------
-- Seed data: departments and complaint categories (district sign-off pending -
-- edit freely; re-running this file never overwrites an existing row).
-- ---------------------------------------------------------------------------
INSERT INTO grievance.departments (dept_key, name_en, name_hi) VALUES
    ('phed', 'PHED (Water Supply)', 'जन स्वास्थ्य अभियंत्रण (पीएचईडी)'),
    ('electricity', 'Electricity Board', 'विद्युत विभाग'),
    ('sanitation', 'Municipal Sanitation', 'नगर स्वच्छता विभाग'),
    ('pwd', 'PWD (Roads)', 'लोक निर्माण विभाग'),
    ('police', 'Police', 'पुलिस विभाग'),
    ('health', 'Health Department', 'स्वास्थ्य विभाग'),
    ('food_safety', 'Food Safety / Mela Admin', 'खाद्य सुरक्षा / मेला प्रशासन'),
    ('lost_found_dept', 'Mela Control Room / Police', 'मेला कंट्रोल रूम / पुलिस'),
    ('traffic_police', 'Traffic Police', 'यातायात पुलिस'),
    ('veterinary', 'Veterinary / Animal Husbandry', 'पशु चिकित्सा विभाग'),
    ('collectorate', 'District Admin (Collectorate)', 'जिला प्रशासन (कलेक्ट्रेट)')
ON CONFLICT (dept_key) DO NOTHING;

INSERT INTO grievance.complaint_categories (category_key, label_en, label_hi, department_id, sla_days, sort)
SELECT v.category_key, v.label_en, v.label_hi, d.department_id, v.sla_days, v.sort
FROM (VALUES
    ('water_supply',       'Water supply',                     'पानी की समस्या',                  'phed',            3, 10),
    ('electricity',        'Electricity',                      'बिजली की समस्या',                 'electricity',     2, 20),
    ('sanitation',         'Sanitation & cleanliness',         'सफ़ाई व्यवस्था',                   'sanitation',      2, 30),
    ('toilet_cleaning',    'Toilet cleaning',                  'शौचालय की सफ़ाई',                 'sanitation',      1, 35),
    ('roads',              'Roads & infrastructure',           'सड़क व अवसंरचना',                  'pwd',             5, 40),
    ('police_security',    'Police / security',                'पुलिस / सुरक्षा',                  'police',          1, 50),
    ('medical_health',     'Medical / health',                 'स्वास्थ्य / चिकित्सा',             'health',          1, 60),
    ('mela_food_water',    'Mela food & water quality',        'मेला भोजन व पानी की गुणवत्ता',    'food_safety',     1, 70),
    ('lost_found',         'Lost & found (formal report)',     'खोया-पाया (औपचारिक शिकायत)',      'lost_found_dept', 2, 80),
    ('traffic_parking',    'Traffic & parking',                'यातायात व पार्किंग',               'traffic_police',  2, 90),
    ('veterinary_animal',  'Veterinary / animal & bird care',  'पशु व पक्षी चिकित्सा',             'veterinary',     2, 100),
    ('other',              'Other / general grievance',        'अन्य / सामान्य शिकायत',            'collectorate',    5, 110)
) AS v (category_key, label_en, label_hi, dept_key, sla_days, sort)
JOIN grievance.departments d ON d.dept_key = v.dept_key
ON CONFLICT (category_key) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Read-write role for the portal app. The login user (portal_rw) is created
-- by scripts/db_migrate.sh when PORTAL_DB_PASSWORD is set - same split as
-- analytics_ro/metabase_ro in sql/20_analytics.sql.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'grievance_app') THEN
        CREATE ROLE grievance_app NOLOGIN;
    END IF;
END $$;
REVOKE ALL ON SCHEMA core FROM grievance_app;
REVOKE ALL ON SCHEMA svc_mela FROM grievance_app;
GRANT USAGE ON SCHEMA grievance TO grievance_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA grievance TO grievance_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA grievance TO grievance_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA grievance TO grievance_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA grievance GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO grievance_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA grievance GRANT USAGE, SELECT ON SEQUENCES TO grievance_app;
