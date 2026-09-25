-- Analytics (M3) SQL tests: reconciliation, masking, admin/UAT exclusion,
-- read-only role, daily report, purge. One transaction, rolled back.
BEGIN;
TRUNCATE core.message_log, core.feedback, core.unanswered, core.citizens, core.sessions, core.admins, analytics.daily_archive;
UPDATE core.settings SET value = '2026-08-01' WHERE key = 'analytics_since';
UPDATE core.settings SET value = '180' WHERE key = 'retention_days';

-- Citizens c1, c2; one admin; c3 only before go-live. Times are IST.
INSERT INTO core.admins (wa_hash, label) VALUES ('adminaaaaaaaaaaaaaaaa', 'test admin');
INSERT INTO core.citizens (wa_hash, first_seen, last_seen) VALUES
    ('c1aaaaaaaaaaaaaaaaaaa', '2026-08-01 10:00+05:30', '2026-08-02 00:10+05:30'),
    ('c2bbbbbbbbbbbbbbbbbbb', '2026-08-01 23:30+05:30', '2026-08-01 23:30+05:30'),
    ('c3ccccccccccccccccccc', '2026-07-31 23:00+05:30', '2026-07-31 23:00+05:30'),
    ('adminaaaaaaaaaaaaaaaa', '2026-08-01 09:00+05:30', '2026-08-01 09:00+05:30');
INSERT INTO core.message_log (wa_msg_id, wa_hash, direction, service_key, subtype, kind, text, via, resolved, llm_tokens, latency_ms, detail, error, ts) VALUES
    ('m1', 'c1aaaaaaaaaaaaaaaaaaa', 'in', 'mela', 'thana', 'button', NULL, 'button', true, NULL, 200, NULL, NULL, '2026-08-01 10:00+05:30'),
    ('m2', 'c1aaaaaaaaaaaaaaaaaaa', 'in', 'mela', 'near_thana', 'location', NULL, 'location', true, NULL, 400, 'gps:<500m', NULL, '2026-08-01 10:02+05:30'),
    ('m3', 'c1aaaaaaaaaaaaaaaaaaa', 'in', 'mela', 'ask_unanswered', 'text', 'call 98765 43210 kab tak mela?', 'llm', false, 1000, 900, NULL, NULL, '2026-08-01 10:04+05:30'),
    ('m4', 'c2bbbbbbbbbbbbbbbbbbb', 'in', 'mela', 'today', 'list', NULL, 'list', true, NULL, 300, NULL, 'version_conflict', '2026-08-01 23:30+05:30'),
    ('m5', 'c1aaaaaaaaaaaaaaaaaaa', 'in', 'mela', 'control', 'button', NULL, 'button', true, NULL, 250, NULL, NULL, '2026-08-02 00:10+05:30'),
    ('m6', 'adminaaaaaaaaaaaaaaaa', 'in', 'mela', 'adm_menu', 'text', 'pin', 'text', true, NULL, 100, NULL, NULL, '2026-08-01 09:00+05:30'),
    ('m7', 'adminaaaaaaaaaaaaaaaa', 'in', 'mela', 'adm_saved', 'location', NULL, 'location', true, NULL, 100, NULL, NULL, '2026-08-01 09:01+05:30'),
    ('m8', 'c3ccccccccccccccccccc', 'in', 'mela', 'thana', 'button', NULL, 'button', true, NULL, 100, NULL, NULL, '2026-07-31 23:00+05:30'),
    ('o1', 'c1aaaaaaaaaaaaaaaaaaa', 'out', 'mela', NULL, 'text', 'x', NULL, NULL, NULL, NULL, NULL, 'graph 500', '2026-08-01 10:00+05:30'),
    ('o2', 'admin', 'out', 'admin', NULL, 'template', '', NULL, NULL, NULL, NULL, NULL, 'HTTP 404: template not found', '2026-08-01 08:00+05:30'),
    ('m9', 'c2bbbbbbbbbbbbbbbbbbb', 'in', 'mela', 'ask', 'text', 'मेरा नंबर ९८७६५४३२१० है, 98765.43210', 'llm', true, NULL, 100, NULL, NULL, '2026-08-01 23:31+05:30');
INSERT INTO core.feedback (wa_hash, service_key, rating, ts) VALUES
    ('c1aaaaaaaaaaaaaaaaaaa', 'mela', -1, '2026-08-01 10:03+05:30'),
    ('adminaaaaaaaaaaaaaaaa', 'mela', 1, '2026-08-01 09:02+05:30');
INSERT INTO core.unanswered (wa_hash, text, service_key, reason, ts) VALUES
    ('c1aaaaaaaaaaaaaaaaaaa', 'call 98765 43210 kab tak mela?', 'mela', 'qa_no_answer', '2026-08-01 10:04+05:30'),
    ('adminaaaaaaaaaaaaaaaa', 'admin test question', 'mela', 'no_service', '2026-08-01 09:03+05:30');

DO $$
DECLARE d record; r jsonb; n int; col record;
BEGIN
    -- v_daily: IST days, admins and pre-go-live excluded
    SELECT * INTO d FROM analytics.v_daily WHERE day = '2026-08-01';
    ASSERT d.citizens = 2 AND d.turns = 5, format('citizens/turns %s/%s', d.citizens, d.turns);
    ASSERT d.new_citizens = 2, 'new citizens (admin excluded)';
    ASSERT d.menu_taps = 2 AND d.typed = 2 AND d.locations = 1, 'channel split';
    ASSERT d.resolved_pct = 80.0, format('resolved_pct %s', d.resolved_pct);
    ASSERT d.unanswered = 1 AND d.thumbs_down = 1 AND d.thumbs_up = 0, 'admin feedback/unanswered excluded';
    ASSERT d.send_errors = 1 AND d.llm_tokens = 1000 AND d.via_llm = 2, 'errors and tokens (admin alert failure not counted)';
    ASSERT d.turn_errors = 0, 'a version conflict (double tap) is not an error';
    ASSERT d.llm_usd_est = 0.001, format('cost estimate %s', d.llm_usd_est);
    ASSERT (SELECT turns FROM analytics.v_daily WHERE day = '2026-08-02') = 1, '00:10 IST belongs to the next day';
    ASSERT NOT EXISTS (SELECT 1 FROM analytics.v_daily WHERE day = '2026-07-31'), 'before go-live not counted';

    -- M3 gate: a sampled day reconciles with message_log
    r := analytics.reconcile('2026-08-01');
    ASSERT (r->>'ok')::boolean AND (r->>'raw_inbound')::int = 7 AND (r->>'admin_inbound')::int = 2, r::text;
    r := analytics.reconcile('2026-07-31');
    ASSERT (r->>'ok')::boolean AND (r->>'before_go_live')::int = 1 AND (r->>'view_turns')::int = 0, r::text;

    -- detail views
    ASSERT (SELECT about_subtype FROM analytics.v_feedback) = 'near_thana', 'feedback attributed to the answer before it';
    ASSERT (SELECT turns FROM analytics.v_near WHERE origin = 'gps' AND distance_bucket = '<500m') = 1, 'near-me buckets';
    ASSERT (SELECT times FROM analytics.v_unanswered_themes WHERE theme LIKE '%kab tak mela%') = 1, 'unanswered themes';
    ASSERT (SELECT count(*) FROM analytics.v_topics WHERE day = '2026-08-01') = 5, 'topics';
    ASSERT (SELECT text_masked FROM analytics.v_turns WHERE subtype = 'ask') = 'मेरा नंबर [number] है, [number]',
        format('Devanagari and dotted numbers masked: %s', (SELECT text_masked FROM analytics.v_turns WHERE subtype = 'ask'));

    -- no raw numbers anywhere in the analytics schema
    ASSERT (SELECT text_masked FROM analytics.v_turns WHERE subtype = 'ask_unanswered') = 'call [number] kab tak mela?', 'masked';
    FOR col IN SELECT table_name, column_name FROM information_schema.columns
               WHERE table_schema = 'analytics' AND data_type IN ('text', 'character varying') LOOP
        EXECUTE format('SELECT count(*) FROM analytics.%I WHERE translate(%I, ''०१२३४५६७८९'', ''0123456789'') ~ ''\d{6,}|\d{3,}[ .-]\d{3,}''', col.table_name, col.column_name) INTO n;
        ASSERT n = 0, format('%s.%s exposes a number-like value', col.table_name, col.column_name);
    END LOOP;
    ASSERT NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'analytics'
                       AND (column_name LIKE '%\_enc' OR column_name IN ('wa_hash', 'wa_id', 'phone'))), 'no identifying columns';

    -- daily report
    r := analytics.daily_report('2026-08-01');
    ASSERT r->>'text' LIKE '%Citizens: 2 (2 new) · messages: 5%', r->>'text';
    ASSERT r->>'text' LIKE '%Not answered: "call [number] kab tak mela" ×1%', r->>'text';
    ASSERT position(E'\n' IN r->>'line') = 0 AND length(r->>'line') <= 900, 'template line is one line';
    ASSERT r->>'text' LIKE '%1 admin WhatsApp alert(s) failed%', 'admin alert failures surfaced';
    ASSERT (SELECT (stats->>'turns')::int FROM analytics.daily_archive WHERE day = '2026-08-01') = 5, 'archived';

    RAISE NOTICE 'analytics_test: views, reconciliation, masking, report ok';
END $$;

-- The Metabase role reads analytics views and nothing in core.
SET LOCAL ROLE analytics_ro;
DO $$
BEGIN
    ASSERT (SELECT count(*) FROM analytics.v_daily) >= 2, 'analytics_ro reads the views';
    BEGIN
        PERFORM 1 FROM core.citizens LIMIT 1;
        RAISE EXCEPTION 'analytics_ro must not read core.citizens';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    BEGIN
        PERFORM analytics.daily_report('2026-08-01');
        RAISE EXCEPTION 'analytics_ro must not run the report';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    RAISE NOTICE 'analytics_test: read-only role ok';
END $$;
RESET ROLE;

-- Purge: aggregates archived first, personal rows older than retention removed.
DO $$
DECLARE r jsonb; old_day date := ((now() - interval '200 days') AT TIME ZONE 'Asia/Kolkata')::date;
BEGIN
    UPDATE core.settings SET value = '2000-01-01' WHERE key = 'analytics_since';
    INSERT INTO core.citizens (wa_hash, first_seen, last_seen) VALUES ('oldddddddddddddddddd', now() - interval '200 days', now() - interval '200 days');
    INSERT INTO core.message_log (wa_msg_id, wa_hash, direction, subtype, kind, ts)
    VALUES ('old1', 'oldddddddddddddddddd', 'in', 'thana', 'button', now() - interval '200 days');
    INSERT INTO core.feedback (wa_hash, rating, ts) VALUES ('oldddddddddddddddddd', 1, now() - interval '200 days');
    INSERT INTO core.message_log (wa_msg_id, wa_hash, direction, kind, ts) VALUES ('new1', 'c1aaaaaaaaaaaaaaaaaaa', 'in', 'text', now());

    r := core.run_purge();
    ASSERT (r->>'message_log')::int >= 1 AND (r->>'citizens')::int >= 1 AND (r->>'feedback')::int >= 1, r::text;
    ASSERT NOT EXISTS (SELECT 1 FROM core.message_log WHERE wa_msg_id = 'old1'), 'old row purged';
    ASSERT NOT EXISTS (SELECT 1 FROM core.citizens WHERE wa_hash = 'oldddddddddddddddddd'), 'old citizen purged';
    ASSERT EXISTS (SELECT 1 FROM core.message_log WHERE wa_msg_id = 'new1'), 'recent row kept';
    ASSERT (SELECT (stats->>'turns')::int FROM analytics.daily_archive WHERE day = old_day) = 1, 'old day archived before purge';

    UPDATE core.settings SET value = '10' WHERE key = 'retention_days';
    BEGIN
        PERFORM core.run_purge();
        RAISE EXCEPTION 'purge below the safety floor must fail';
    EXCEPTION WHEN raise_exception THEN
        IF SQLERRM NOT LIKE '%safety floor%' THEN RAISE; END IF;
    END;
    RAISE NOTICE 'analytics_test: purge ok';
END $$;

ROLLBACK;
