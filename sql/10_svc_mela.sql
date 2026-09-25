-- svc_mela: Sonpur Mela service data. Idempotent.
-- Staff edit the Google Sheet; the sync workflow validates it
-- (n8n/src/services/mela_sheet.js) and calls svc_mela.replace_all() - one
-- transaction, so citizens never see a half-loaded dataset.

CREATE SCHEMA IF NOT EXISTS svc_mela;

CREATE TABLE IF NOT EXISTS svc_mela.places (
    id           text PRIMARY KEY,               -- permanent sheet id, e.g. TH01
    category     text NOT NULL,                  -- thana | health_centre | vet_camp | parking | ghat | ...
    name_en      text,
    name_hi      text,
    location_en  text,
    location_hi  text,
    lat          double precision,               -- from the sheet (overrides a captured point)
    lon          double precision,
    hours        text,
    notes        text,
    sort         int NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS svc_mela.duty (
    id           bigserial PRIMARY KEY,
    place_id     text NOT NULL REFERENCES svc_mela.places (id) ON DELETE CASCADE,
    shift_no     smallint CHECK (shift_no IN (1, 2, 3)),   -- NULL = all day
    person_name  text,
    phones       text[] NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS svc_mela.control_duty (
    id           bigserial PRIMARY KEY,
    desk         text NOT NULL,
    sort         int NOT NULL DEFAULT 0,
    shift_no     smallint CHECK (shift_no IN (1, 2, 3)),
    person_name  text,
    designation  text,
    phones       text[] NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS svc_mela.events (
    id            text PRIMARY KEY,
    date          date NOT NULL,
    time          text,
    programme_en  text,
    programme_hi  text,
    artists       text,
    department    text,
    venue         text,
    is_highlight  boolean NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS events_date_idx ON svc_mela.events (date);

CREATE TABLE IF NOT EXISTS svc_mela.guidelines (
    id       text PRIMARY KEY,
    kind     text NOT NULL CHECK (kind IN ('do', 'dont', 'emergency')),
    text_en  text,
    text_hi  text,
    sort     int NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS svc_mela.settings (
    key    text PRIMARY KEY,
    value  text NOT NULL DEFAULT ''
);

-- Points captured on-site by admins (plan §6.1b). The sync never touches this
-- table; a lat/lon typed into the sheet takes precedence.
CREATE TABLE IF NOT EXISTS svc_mela.place_coords (
    place_id          text PRIMARY KEY,
    lat               double precision NOT NULL,
    lon               double precision NOT NULL,
    captured_by_hash  text,
    captured_at       timestamptz NOT NULL DEFAULT now()
);

-- Approved general-information text for the "Ask a question" LLM answers
-- (loaded from data/history.md by scripts/db_migrate.sh).
CREATE TABLE IF NOT EXISTS svc_mela.qa_context (
    id       int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    content  text NOT NULL DEFAULT ''
);

-- Replace every sheet-sourced table in one transaction (the caller's).
-- p = validateMelaSheet().data: {places, duty, control, events, guidelines, settings}
CREATE OR REPLACE FUNCTION svc_mela.replace_all(p jsonb) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE n_numbers int;
BEGIN
    DELETE FROM svc_mela.duty;
    DELETE FROM svc_mela.control_duty;
    DELETE FROM svc_mela.places;
    DELETE FROM svc_mela.events;
    DELETE FROM svc_mela.guidelines;
    DELETE FROM svc_mela.settings;

    INSERT INTO svc_mela.places (id, category, name_en, name_hi, location_en, location_hi, lat, lon, hours, notes, sort)
    SELECT x->>'id', x->>'category', x->>'name_en', x->>'name_hi', x->>'location_en', x->>'location_hi',
           (x->>'lat')::float8, (x->>'lon')::float8, x->>'hours', x->>'notes', coalesce((x->>'sort')::int, 0)
    FROM jsonb_array_elements(coalesce(p->'places', '[]')) x;

    INSERT INTO svc_mela.duty (place_id, shift_no, person_name, phones)
    SELECT x->>'place_id', (x->>'shift_no')::smallint, x->>'person_name',
           coalesce(array(SELECT jsonb_array_elements_text(x->'phones')), '{}')
    FROM jsonb_array_elements(coalesce(p->'duty', '[]')) x;

    INSERT INTO svc_mela.control_duty (desk, sort, shift_no, person_name, designation, phones)
    SELECT x->>'desk', coalesce((x->>'sort')::int, 0), (x->>'shift_no')::smallint, x->>'person_name', x->>'designation',
           coalesce(array(SELECT jsonb_array_elements_text(x->'phones')), '{}')
    FROM jsonb_array_elements(coalesce(p->'control', '[]')) x;

    INSERT INTO svc_mela.events (id, date, time, programme_en, programme_hi, artists, department, venue, is_highlight)
    SELECT x->>'id', (x->>'date')::date, x->>'time', x->>'programme_en', x->>'programme_hi', x->>'artists',
           x->>'department', x->>'venue', coalesce((x->>'is_highlight')::boolean, false)
    FROM jsonb_array_elements(coalesce(p->'events', '[]')) x;

    INSERT INTO svc_mela.guidelines (id, kind, text_en, text_hi, sort)
    SELECT x->>'id', x->>'kind', x->>'text_en', x->>'text_hi', coalesce((x->>'sort')::int, 0)
    FROM jsonb_array_elements(coalesce(p->'guidelines', '[]')) x;

    INSERT INTO svc_mela.settings (key, value)
    SELECT key, coalesce(value #>> '{}', '') FROM jsonb_each(coalesce(p->'settings', '{}'));

    -- Every number the Mela service may send (phone guard, core.disallowed_numbers)
    n_numbers := core.register_numbers('mela', ARRAY(
        SELECT unnest(phones) FROM svc_mela.duty
        UNION SELECT unnest(phones) FROM svc_mela.control_duty
        UNION SELECT value FROM svc_mela.settings WHERE key LIKE 'public_helpline_%' AND value <> ''));

    RETURN jsonb_build_object(
        'places', (SELECT count(*) FROM svc_mela.places), 'duty', (SELECT count(*) FROM svc_mela.duty),
        'control', (SELECT count(*) FROM svc_mela.control_duty), 'events', (SELECT count(*) FROM svc_mela.events),
        'guidelines', (SELECT count(*) FROM svc_mela.guidelines), 'numbers', n_numbers);
END $$;

-- Everything the service needs for one turn (a few KB), as JSON.
CREATE OR REPLACE FUNCTION svc_mela.snapshot() RETURNS jsonb
LANGUAGE sql STABLE AS $$
    SELECT jsonb_build_object(
        'places', coalesce((SELECT jsonb_agg(jsonb_build_object(
                'id', p.id, 'category', p.category, 'name_en', p.name_en, 'name_hi', p.name_hi,
                'location_en', p.location_en, 'location_hi', p.location_hi, 'hours', p.hours, 'notes', p.notes, 'sort', p.sort,
                'lat', coalesce(p.lat, c.lat), 'lon', coalesce(p.lon, c.lon),
                'coord_source', CASE WHEN p.lat IS NOT NULL THEN 'sheet' WHEN c.lat IS NOT NULL THEN 'captured' END)
                ORDER BY p.sort, p.id)
            FROM svc_mela.places p LEFT JOIN svc_mela.place_coords c ON c.place_id = p.id), '[]'),
        'duty', coalesce((SELECT jsonb_agg(jsonb_build_object('place_id', place_id, 'shift_no', shift_no,
                'person_name', person_name, 'phones', to_jsonb(phones)) ORDER BY id) FROM svc_mela.duty), '[]'),
        'control', coalesce((SELECT jsonb_agg(jsonb_build_object('desk', desk, 'sort', sort, 'shift_no', shift_no,
                'person_name', person_name, 'designation', designation, 'phones', to_jsonb(phones)) ORDER BY sort, id)
                FROM svc_mela.control_duty), '[]'),
        'events', coalesce((SELECT jsonb_agg(jsonb_build_object('id', id, 'date', to_char(date, 'YYYY-MM-DD'), 'time', time,
                'programme_en', programme_en, 'programme_hi', programme_hi, 'artists', artists, 'department', department,
                'venue', venue, 'is_highlight', is_highlight) ORDER BY date, time, id) FROM svc_mela.events), '[]'),
        'guidelines', coalesce((SELECT jsonb_agg(to_jsonb(g) ORDER BY sort, id) FROM svc_mela.guidelines g), '[]'),
        'settings', coalesce((SELECT jsonb_object_agg(key, value) FROM svc_mela.settings), '{}')
    )
$$;

-- Apply service side effects (admin coordinate capture).
-- p = {wa_hash, effects: [{type: 'save_coords', place_id, lat, lon}]}
CREATE OR REPLACE FUNCTION svc_mela.apply_effects(p jsonb) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE e jsonb; n int := 0;
BEGIN
    FOR e IN SELECT * FROM jsonb_array_elements(coalesce(p->'effects', '[]')) LOOP
        IF e->>'type' = 'save_coords' AND EXISTS (SELECT 1 FROM svc_mela.places WHERE id = e->>'place_id') THEN
            INSERT INTO svc_mela.place_coords (place_id, lat, lon, captured_by_hash)
            VALUES (e->>'place_id', (e->>'lat')::float8, (e->>'lon')::float8, p->>'wa_hash')
            ON CONFLICT (place_id) DO UPDATE SET lat = EXCLUDED.lat, lon = EXCLUDED.lon,
                captured_by_hash = EXCLUDED.captured_by_hash, captured_at = now();
            n := n + 1;
        END IF;
    END LOOP;
    RETURN jsonb_build_object('applied', n);
END $$;

-- One line for the 08:00 daily report (analytics.daily_report calls
-- svc_<key>.digest() for every enabled service that defines one).
CREATE OR REPLACE FUNCTION svc_mela.digest() RETURNS text
LANGUAGE sql STABLE AS $$
    WITH pins AS (
        SELECT p.category, count(*) AS total,
               count(*) FILTER (WHERE coalesce(p.lat, c.lat) IS NOT NULL) AS pinned
        FROM svc_mela.places p LEFT JOIN svc_mela.place_coords c ON c.place_id = p.id
        GROUP BY p.category
    ), today AS (
        SELECT count(*) AS n FROM svc_mela.events WHERE date = (now() AT TIME ZONE 'Asia/Kolkata')::date
    ), sync AS (
        SELECT max(ts) AS last_ok FROM core.sync_runs WHERE service_key = 'mela' AND status = 'ok'
    )
    SELECT format('Mela: sites with map pins %s/%s (%s) · programme items today: %s · last good sheet sync: %s',
                  coalesce(sum(pinned), 0), coalesce(sum(total), 0),
                  coalesce(string_agg(format('%s %s/%s', category, pinned, total), ', ' ORDER BY category), 'no sites'),
                  (SELECT n FROM today),
                  coalesce((SELECT to_char(last_ok AT TIME ZONE 'Asia/Kolkata', 'DD Mon HH24:MI') FROM sync), 'never')
                  || CASE WHEN (SELECT last_ok FROM sync) < now() - interval '1 hour' THEN ' ⚠ STALE' ELSE '' END)
    FROM pins
$$;

-- Sync bookkeeping (generic, lives in core): record a run and say whether to
-- alert - failed runs alert at most once per hour for the same set of errors.
CREATE OR REPLACE FUNCTION core.record_sync(p jsonb) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE should_alert boolean;
BEGIN
    should_alert := p->>'status' <> 'ok' AND NOT EXISTS (
        SELECT 1 FROM core.sync_runs r
        WHERE r.service_key = p->>'service_key' AND r.status <> 'ok'
          AND r.errors = coalesce(p->'errors', '[]'::jsonb) AND r.ts > now() - interval '1 hour');
    INSERT INTO core.sync_runs (service_key, source, status, rows, errors)
    VALUES (p->>'service_key', p->>'source', p->>'status', (p->>'rows')::int, coalesce(p->'errors', '[]'::jsonb));
    RETURN jsonb_build_object('should_alert', should_alert);
END $$;

-- Registry row. Disabled by default: enable once real data is synced
--   UPDATE core.services SET enabled = true WHERE service_key = 'mela';
INSERT INTO core.services (service_key, id_prefix, title_hi, title_en, description_hi, description_en,
                           menu_order, enabled, workflow_id, intent_hint_en, intent_hint_hi, subtypes, keywords, accepts_location)
VALUES ('mela', 'mela', 'सोनपुर मेला', 'Sonpur Mela', 'कार्यक्रम, थाना, अस्पताल, पार्किंग, घाट', 'Programme, police, health, parking, ghats',
        10, false, 'SvcMela000000001',
        'Anything about Sonpur Mela (Harihar Kshetra fair): programme/artists, control room, temporary police stations, health centres, veterinary camps, parking, ghats, nearest facility, rules, history and general questions.',
        'सोनपुर मेला: कार्यक्रम, कंट्रोल रूम, थाना, अस्पताल, पशु शिविर, पार्किंग, घाट, नज़दीकी सुविधा, नियम, इतिहास',
        '{"today": "today''s cultural programme or artists", "schedule": "full programme schedule", "control": "control room, helpline, complaint, emergency",
          "thana": "police station / police help", "health_centre": "doctor, hospital, medical camp, ambulance", "vet_camp": "veterinary camp, animal doctor",
          "parking": "where to park vehicles", "ghat": "bathing ghats", "near": "nearest facility to the user", "rules": "do''s and don''ts, what is allowed",
          "ask": "history or any other general question about the Mela"}',
        -- registry keywords send text straight to this service (no LLM call); the
        -- service then works out the topic itself (n8n/src/services/mela.js)
        ARRAY['mela', 'sonpur', 'sonepur', 'harihar', 'मेला', 'सोनपुर', 'हरिहर',
              'thana', 'police', 'chowki', 'chori', 'पुलिस', 'थाना', 'चौकी', 'चोरी',
              'doctor', 'hospital', 'dispensary', 'medical', 'ambulance', 'aspatal', 'beemar', 'डॉक्टर', 'अस्पताल', 'एम्बुलेंस', 'बीमार',
              'vet', 'pashu', 'bail', 'haathi', 'animal', 'पशु', 'हाथी', 'जानवर',
              'parking', 'park', 'gaadi', 'पार्किंग', 'गाड़ी', 'ghat', 'snan', 'घाट', 'स्नान',
              'program', 'programme', 'singer', 'artist', 'show', 'tonight', 'aaj', 'कार्यक्रम', 'कलाकार', 'आज',
              'helpline', 'control', 'complaint', 'emergency', 'हेल्पलाइन', 'कंट्रोल', 'शिकायत',
              'lost', 'khoya', 'खोया', 'toilet', 'शौचालय', 'hotel', 'होटल', 'near', 'nearest', 'nearby', 'नज़दीकी', 'pin'],
        true)
ON CONFLICT (service_key) DO UPDATE SET
    id_prefix = EXCLUDED.id_prefix, title_hi = EXCLUDED.title_hi, title_en = EXCLUDED.title_en,
    description_hi = EXCLUDED.description_hi, description_en = EXCLUDED.description_en,
    workflow_id = EXCLUDED.workflow_id, intent_hint_en = EXCLUDED.intent_hint_en, intent_hint_hi = EXCLUDED.intent_hint_hi,
    subtypes = EXCLUDED.subtypes, keywords = EXCLUDED.keywords, accepts_location = EXCLUDED.accepts_location;
