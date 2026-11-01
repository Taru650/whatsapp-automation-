-- svc_complaint: WhatsApp-only plumbing for the complaint-registration service.
-- All complaint lifecycle/RBAC data lives in grievance.* (sql/30_grievance.sql,
-- applied before this file); this schema only generates IDs and preloads/applies
-- what n8n/src/services/complaint.js needs for one turn. Idempotent.

CREATE SCHEMA IF NOT EXISTS svc_complaint;

CREATE TABLE IF NOT EXISTS svc_complaint.id_counters (
    year      int PRIMARY KEY,
    next_seq  int NOT NULL DEFAULT 1
);

-- Atomic per-year sequence (INSERT ... ON CONFLICT DO UPDATE is a single,
-- row-locking statement - same race-avoidance spirit as core.end_turn's
-- optimistic version check), formatted as SCB-<year>-<6 digits>.
CREATE OR REPLACE FUNCTION svc_complaint.next_complaint_id() RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
    y   int := extract(year FROM now() AT TIME ZONE 'Asia/Kolkata');
    seq int;
BEGIN
    INSERT INTO svc_complaint.id_counters (year, next_seq) VALUES (y, 2)
    ON CONFLICT (year) DO UPDATE SET next_seq = svc_complaint.id_counters.next_seq + 1
    RETURNING next_seq - 1 INTO seq;
    RETURN format('SCB-%s-%s', y, lpad(seq::text, 6, '0'));
END $$;

-- Apply service side effects (one create_complaint effect per turn).
-- p = {wa_hash, effects: [{type:'create_complaint', category_key, description,
--      lang, lat, lon, evidence: [{path, mime, kind, sha256}]}]}
-- Returns {complaint_id}. Direct parallel of svc_mela.apply_effects.
CREATE OR REPLACE FUNCTION svc_complaint.apply_effects(p jsonb) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
    e      jsonb;
    ev     jsonb;
    v_id   text;
    v_dept int;
BEGIN
    FOR e IN SELECT * FROM jsonb_array_elements(coalesce(p->'effects', '[]')) LOOP
        CONTINUE WHEN e->>'type' <> 'create_complaint';
        SELECT department_id INTO v_dept FROM grievance.complaint_categories WHERE category_key = e->>'category_key';
        CONTINUE WHEN v_dept IS NULL;   -- unknown category: never silently misfile

        v_id := svc_complaint.next_complaint_id();
        INSERT INTO grievance.complaints (complaint_id, citizen_wa_hash, category_key, department_id,
                description, lang, lat, lon, status, due_at)
        VALUES (v_id, p->>'wa_hash', e->>'category_key', v_dept,
                e->>'description', coalesce(e->>'lang', 'hi'), (e->>'lat')::float8, (e->>'lon')::float8, 'open',
                now() + make_interval(days => (SELECT sla_days FROM grievance.complaint_categories WHERE category_key = e->>'category_key')));

        FOR ev IN SELECT * FROM jsonb_array_elements(coalesce(e->'evidence', '[]')) LOOP
            INSERT INTO grievance.complaint_evidence (complaint_id, uploaded_by, wa_hash, file_path, mime_type, kind, sha256)
            VALUES (v_id, 'citizen', p->>'wa_hash', ev->>'path', ev->>'mime', ev->>'kind', ev->>'sha256');
        END LOOP;

        INSERT INTO grievance.complaint_status_history (complaint_id, from_status, to_status, remark)
        VALUES (v_id, NULL, 'open', 'registered via WhatsApp');
    END LOOP;
    RETURN jsonb_build_object('complaint_id', v_id);
END $$;

-- Everything one WhatsApp turn needs, as JSON (categories for the menu, the
-- citizen's own complaints for status-check, and the geofence setting).
CREATE OR REPLACE FUNCTION svc_complaint.snapshot(p_wa_hash text) RETURNS jsonb
LANGUAGE sql STABLE AS $$
    SELECT jsonb_build_object(
        'categories', coalesce((SELECT jsonb_agg(jsonb_build_object(
                'category_key', c.category_key, 'label_en', c.label_en, 'label_hi', c.label_hi)
                ORDER BY c.sort, c.category_key)
            FROM grievance.complaint_categories c
            JOIN grievance.departments d ON d.department_id = c.department_id AND d.enabled), '[]'),
        'my_complaints', coalesce((SELECT jsonb_agg(jsonb_build_object(
                'complaint_id', x.complaint_id, 'category_key', x.category_key, 'status', x.status,
                'created_at', to_char(x.created_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD HH24:MI'),
                'updated_at', to_char(x.updated_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD HH24:MI'))
                ORDER BY x.created_at DESC)
            FROM (SELECT * FROM grievance.complaints WHERE citizen_wa_hash = p_wa_hash ORDER BY created_at DESC LIMIT 20) x), '[]'),
        'geofence', jsonb_build_object(
            'enabled', coalesce((SELECT value FROM grievance.settings WHERE key = 'geofence_enabled'), 'false'::jsonb),
            'center_lat', (SELECT value FROM grievance.settings WHERE key = 'geofence_center_lat'),
            'center_lon', (SELECT value FROM grievance.settings WHERE key = 'geofence_center_lon'),
            'radius_m', coalesce((SELECT value FROM grievance.settings WHERE key = 'geofence_radius_m'), '500'::jsonb))
    )
$$;

-- One line for the 08:00 daily report (analytics.daily_report calls
-- svc_<key>.digest() for every enabled service that defines one).
CREATE OR REPLACE FUNCTION svc_complaint.digest() RETURNS text
LANGUAGE sql STABLE AS $$
    SELECT format('Complaints: %s open/in-progress, %s resolved today, %s closed today',
                  (SELECT count(*) FROM grievance.complaints WHERE status IN ('open', 'assigned', 'in_progress')),
                  (SELECT count(*) FROM grievance.complaints WHERE status = 'resolved' AND (updated_at AT TIME ZONE 'Asia/Kolkata')::date = (now() AT TIME ZONE 'Asia/Kolkata')::date),
                  (SELECT count(*) FROM grievance.complaints WHERE status = 'closed' AND (closed_at AT TIME ZONE 'Asia/Kolkata')::date = (now() AT TIME ZONE 'Asia/Kolkata')::date))
$$;

-- One-time, idempotent data correction (never touches mela.js or
-- sql/10_svc_mela.sql): "complaint"/"शिकायत" used to route to Mela's
-- control-room/helpline screen; svc_complaint (lower menu_order below) now
-- owns tracked-complaint intent. Mela keeps control/helpline/emergency/112/108.
UPDATE core.services SET keywords = array_remove(array_remove(keywords, 'complaint'), 'शिकायत') WHERE service_key = 'mela';

-- Registry row. Disabled by default, same convention as every new service
-- (docs/adding-a-service.md): enable once M5 is deployed and tested on staging.
INSERT INTO core.services (service_key, id_prefix, title_hi, title_en, description_hi, description_en,
                           menu_order, enabled, workflow_id, intent_hint_en, intent_hint_hi, subtypes, keywords, accepts_location)
VALUES ('complaint', 'cmp', 'शिकायत दर्ज करें', 'File a Complaint',
        'नागरिक समस्या दर्ज करें और स्थिति देखें', 'Report a civic issue and track its status',
        -- Higher than mela's menu_order (10) on purpose: both services set
        -- accepts_location, and route.js falls back to the FIRST enabled
        -- service with that flag for an unsolicited (no pending state)
        -- location share. Mela must stay that default so "near me" keeps
        -- working exactly as before; svc_complaint only ever receives a
        -- location via its own pending state (cmp.location), which routes
        -- correctly regardless of menu_order (route.js's stateOwner check
        -- comes first). Keyword routing is unaffected either way: it is
        -- decided by which service's own keyword list matches, not by order.
        20, false, 'SvcComplaint0001',
        'Filing a tracked complaint/grievance about water supply, electricity, sanitation, roads, police, health, Mela food/water quality, lost & found, traffic/parking, veterinary/animal care, or any other civic issue; checking the status of an existing complaint.',
        'पानी, बिजली, सफ़ाई, सड़क, पुलिस, स्वास्थ्य, मेला भोजन/पानी, खोया-पाया, यातायात/पार्किंग, पशु चिकित्सा या किसी अन्य नागरिक समस्या की शिकायत दर्ज करना; मौजूदा शिकायत की स्थिति देखना।',
        '{"register": "file a new complaint/grievance", "status": "check status of an existing complaint", "my_complaints": "list my complaints"}',
        ARRAY['complaint', 'complaints', 'shikayat', 'शिकायत', 'grievance', 'ticket', 'शिकायत दर्ज'],
        true)
ON CONFLICT (service_key) DO UPDATE SET
    id_prefix = EXCLUDED.id_prefix, title_hi = EXCLUDED.title_hi, title_en = EXCLUDED.title_en,
    description_hi = EXCLUDED.description_hi, description_en = EXCLUDED.description_en,
    workflow_id = EXCLUDED.workflow_id, intent_hint_en = EXCLUDED.intent_hint_en, intent_hint_hi = EXCLUDED.intent_hint_hi,
    subtypes = EXCLUDED.subtypes, keywords = EXCLUDED.keywords, accepts_location = EXCLUDED.accepts_location;
