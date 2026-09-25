-- M3 analytics: read-only views for Metabase, the 08:00 daily report, the
-- long-term daily archive and the retention purge. Idempotent.
--
-- Rules every view follows:
--   * no raw phone numbers: citizens appear only as a short pseudonymous ref
--     (first 10 hex chars of the HMAC hash), and digit runs / e-mails that
--     citizens typed into free text are masked;
--   * admin/test phones (core.admins) are never counted;
--   * rows before settings.analytics_since (the go-live date) are ignored, so
--     UAT traffic does not pollute Mela figures;
--   * days are IST calendar days.
-- The Metabase login (role analytics_ro) can read this schema and nothing else.

CREATE SCHEMA IF NOT EXISTS analytics;

INSERT INTO core.settings (key, value) VALUES
    ('analytics_since', '2000-01-01'),   -- set to the go-live date at cut-over
    ('retention_days', '180'),           -- plan §9: personal data kept 180 days
    -- Claude Haiku 4.5 is $1 / MTok input and $5 / MTok output. The bot's calls
    -- are ~92% input tokens (prompt + context, short JSON answer), so the
    -- blended rate is ≈ $1.35 / MTok. Only an estimate: check the Anthropic
    -- console for the real bill.
    ('llm_usd_per_mtok', '1.35'),
    ('usd_inr', '84')
ON CONFLICT (key) DO NOTHING;

-- Indexes for the dashboard/report queries at Mela scale (millions of rows).
CREATE INDEX IF NOT EXISTS message_log_out_err_idx ON core.message_log (ts)
    WHERE direction = 'out' AND error IS NOT NULL;
-- "day = X" / "day >= X" filters on the views use this (IST calendar day)
CREATE INDEX IF NOT EXISTS message_log_in_day_idx ON core.message_log (((ts AT TIME ZONE 'Asia/Kolkata')::date))
    WHERE direction = 'in';

-- Aggregates that outlive the purge (no personal data): next year's Mela can be
-- compared with this one.
CREATE TABLE IF NOT EXISTS analytics.daily_archive (
    day          date PRIMARY KEY,
    stats        jsonb NOT NULL,
    archived_at  timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION analytics.mask(p text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
    -- Devanagari / full-width digits are folded to ASCII first, so a number typed
    -- as ९८७६५४३२१० is masked too; dots count as separators (98765.43210).
    SELECT regexp_replace(
             regexp_replace(translate(p, '०१२३४५६७८९０１２３４５６７８９', '01234567890123456789'),
                            '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}', '[email]', 'g'),
             '\+?\d[\d \t.-]{4,}\d', '[number]', 'g')
$$;

-- Normalised free text for grouping "themes": masked, lower-case, no punctuation.
CREATE OR REPLACE FUNCTION analytics.theme(p text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
    SELECT nullif(btrim(regexp_replace(regexp_replace(lower(analytics.mask(p)),
                  '[^[:alnum:][:space:]\[\]ऀ-ॿ]', ' ', 'g'), '\s+', ' ', 'g')), '')
$$;

-- SECURITY DEFINER: views call this as the Metabase user, which cannot read core.
CREATE OR REPLACE FUNCTION analytics.setting(p_key text, p_default text) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
    SELECT coalesce((SELECT value FROM core.settings WHERE key = p_key), p_default)
$$;

CREATE OR REPLACE FUNCTION analytics.since() RETURNS timestamptz
LANGUAGE sql STABLE AS $$
    SELECT (analytics.setting('analytics_since', '2000-01-01')::date)::timestamp AT TIME ZONE 'Asia/Kolkata'
$$;
-- Views compare against "(SELECT analytics.since())": a scalar subquery is
-- evaluated once per query. A bare call is evaluated per row (a SECURITY
-- DEFINER function can't be inlined): 39 s instead of 0.1 s on 4.8M rows.

-- ---------------------------------------------------------------------------
-- Base views
-- ---------------------------------------------------------------------------
-- Every counted inbound turn.
CREATE OR REPLACE VIEW analytics.v_turns AS
SELECT m.id,
       (m.ts AT TIME ZONE 'Asia/Kolkata')                   AS ts_ist,
       (m.ts AT TIME ZONE 'Asia/Kolkata')::date             AS day,
       extract(hour FROM m.ts AT TIME ZONE 'Asia/Kolkata')::int AS hour,
       left(m.wa_hash, 10)                                  AS citizen_ref,
       m.service_key, m.subtype, m.kind, m.via, m.resolved, m.detail,
       m.llm_tokens, m.latency_ms, m.error,
       CASE WHEN m.kind = 'text' THEN analytics.mask(m.text) END AS text_masked
FROM core.message_log m
WHERE m.direction = 'in'
  AND m.ts >= (SELECT analytics.since())
  AND NOT EXISTS (SELECT 1 FROM core.admins a WHERE a.wa_hash = m.wa_hash);

-- Outbound delivery failures (Graph API errors, phone-guard blocks).
CREATE OR REPLACE VIEW analytics.v_send_errors AS
SELECT (m.ts AT TIME ZONE 'Asia/Kolkata')::date AS day,
       (m.ts AT TIME ZONE 'Asia/Kolkata')       AS ts_ist,
       m.service_key, m.kind, left(m.error, 200) AS error
FROM core.message_log m
WHERE m.direction = 'out' AND m.error IS NOT NULL
  AND coalesce(m.service_key, '') <> 'admin'     -- admin alerts are reported separately
  AND m.ts >= (SELECT analytics.since())
  AND NOT EXISTS (SELECT 1 FROM core.admins a WHERE a.wa_hash = m.wa_hash);

-- Feedback, attributed to the answer it was about (the citizen's previous turn).
CREATE OR REPLACE VIEW analytics.v_feedback AS
SELECT (f.ts AT TIME ZONE 'Asia/Kolkata')::date AS day,
       f.service_key,
       prev.subtype AS about_subtype,
       f.rating
FROM core.feedback f
LEFT JOIN LATERAL (
    SELECT m.subtype FROM core.message_log m
    WHERE m.wa_hash = f.wa_hash AND m.direction = 'in' AND m.ts < f.ts
      AND coalesce(m.subtype, '') NOT IN ('feedback', 'menu')
    ORDER BY m.ts DESC LIMIT 1
) prev ON true
WHERE f.ts >= (SELECT analytics.since())
  AND NOT EXISTS (SELECT 1 FROM core.admins a WHERE a.wa_hash = f.wa_hash);

-- Questions the bot could not answer (the weekly review list).
CREATE OR REPLACE VIEW analytics.v_unanswered AS
SELECT (u.ts AT TIME ZONE 'Asia/Kolkata')         AS ts_ist,
       (u.ts AT TIME ZONE 'Asia/Kolkata')::date   AS day,
       u.service_key, u.reason,
       analytics.mask(u.text)                     AS text_masked,
       analytics.theme(u.text)                    AS theme
FROM core.unanswered u
WHERE u.ts >= (SELECT analytics.since())
  AND NOT EXISTS (SELECT 1 FROM core.admins a WHERE a.wa_hash = u.wa_hash);

-- ---------------------------------------------------------------------------
-- Dashboard views
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW analytics.v_daily AS
WITH t AS (
    SELECT day,
           count(*)                                              AS turns,
           count(DISTINCT citizen_ref)                           AS citizens,
           count(*) FILTER (WHERE kind IN ('button', 'list'))    AS menu_taps,
           count(*) FILTER (WHERE kind = 'text')                 AS typed,
           count(*) FILTER (WHERE kind = 'location')             AS locations,
           count(*) FILTER (WHERE kind = 'unsupported')          AS voice_media,
           count(*) FILTER (WHERE via = 'llm')                   AS via_llm,
           count(*) FILTER (WHERE resolved)                      AS resolved,
           count(*) FILTER (WHERE resolved IS NOT NULL)          AS judged,
           -- a service that failed (citizen got the apology); version conflicts
           -- (double taps, reply already sent) are not errors
           count(*) FILTER (WHERE subtype = 'error')             AS turn_errors,
           coalesce(sum(llm_tokens), 0)                          AS llm_tokens,
           percentile_cont(0.5)  WITHIN GROUP (ORDER BY latency_ms) AS p50_ms,
           percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms) AS p95_ms
    FROM analytics.v_turns GROUP BY day
), n AS (
    SELECT (first_seen AT TIME ZONE 'Asia/Kolkata')::date AS day, count(*) AS new_citizens
    FROM core.citizens c
    WHERE first_seen >= (SELECT analytics.since())
      AND NOT EXISTS (SELECT 1 FROM core.admins a WHERE a.wa_hash = c.wa_hash)
    GROUP BY 1
), f AS (
    SELECT day, count(*) FILTER (WHERE rating = 1) AS thumbs_up, count(*) FILTER (WHERE rating = -1) AS thumbs_down
    FROM analytics.v_feedback GROUP BY day
), u AS (
    SELECT day, count(*) AS unanswered FROM analytics.v_unanswered GROUP BY day
), e AS (
    SELECT day, count(*) AS send_errors FROM analytics.v_send_errors GROUP BY day
)
SELECT t.day, t.citizens, coalesce(n.new_citizens, 0) AS new_citizens, t.turns,
       t.menu_taps, t.typed, t.locations, t.voice_media, t.via_llm,
       round(100.0 * t.resolved / nullif(t.judged, 0), 1)   AS resolved_pct,
       coalesce(u.unanswered, 0)                            AS unanswered,
       coalesce(f.thumbs_up, 0)                             AS thumbs_up,
       coalesce(f.thumbs_down, 0)                           AS thumbs_down,
       round(100.0 * f.thumbs_down / nullif(f.thumbs_up + f.thumbs_down, 0), 1) AS thumbs_down_pct,
       t.turn_errors, coalesce(e.send_errors, 0)            AS send_errors,
       round(t.p50_ms::numeric) AS p50_ms, round(t.p95_ms::numeric) AS p95_ms,
       t.llm_tokens,
       round(t.llm_tokens / 1e6 * analytics.setting('llm_usd_per_mtok', '1.35')::numeric, 3) AS llm_usd_est
FROM t
LEFT JOIN n USING (day) LEFT JOIN f USING (day) LEFT JOIN u USING (day) LEFT JOIN e USING (day);

-- Traffic by hour of day (peak planning, staffing of the control room).
CREATE OR REPLACE VIEW analytics.v_hourly AS
SELECT day, hour, count(*) AS turns, count(DISTINCT citizen_ref) AS citizens
FROM analytics.v_turns GROUP BY day, hour;

-- What citizens ask for: per service and subtype.
CREATE OR REPLACE VIEW analytics.v_topics AS
SELECT day, coalesce(service_key, '(core)') AS service_key, coalesce(subtype, '(none)') AS subtype,
       count(*) AS turns, count(DISTINCT citizen_ref) AS citizens,
       count(*) FILTER (WHERE via = 'llm') AS via_llm,
       round(100.0 * count(*) FILTER (WHERE resolved) / nullif(count(*) FILTER (WHERE resolved IS NOT NULL), 0), 1) AS resolved_pct
FROM analytics.v_turns GROUP BY 1, 2, 3;

-- 👍/👎 per answer type.
CREATE OR REPLACE VIEW analytics.v_feedback_by_topic AS
SELECT day, coalesce(service_key, '(core)') AS service_key, coalesce(about_subtype, '(unknown)') AS about_subtype,
       count(*) FILTER (WHERE rating = 1) AS thumbs_up, count(*) FILTER (WHERE rating = -1) AS thumbs_down,
       round(100.0 * count(*) FILTER (WHERE rating = -1) / count(*), 1) AS thumbs_down_pct
FROM analytics.v_feedback GROUP BY 1, 2, 3;

-- Unanswered questions grouped by normalised text, for the weekly review.
CREATE OR REPLACE VIEW analytics.v_unanswered_themes AS
SELECT theme, count(*) AS times,
       min(day) AS first_day, max(day) AS last_day,
       string_agg(DISTINCT reason, ', ') AS reasons,
       (array_agg(text_masked ORDER BY ts_ist DESC))[1] AS example
FROM analytics.v_unanswered
WHERE theme IS NOT NULL
GROUP BY theme;

-- Near me: which category, GPS or landmark, and how far the nearest help was.
CREATE OR REPLACE VIEW analytics.v_near AS
SELECT day, subtype,
       split_part(detail, ':', 1) AS origin,
       split_part(detail, ':', 2) AS distance_bucket,
       count(*) AS turns
FROM analytics.v_turns
WHERE subtype LIKE 'near\_%' AND detail IS NOT NULL
GROUP BY 1, 2, 3, 4;

-- Sheet sync health.
CREATE OR REPLACE VIEW analytics.v_sync AS
SELECT (ts AT TIME ZONE 'Asia/Kolkata') AS ts_ist, service_key, status, rows,
       CASE WHEN status <> 'ok' THEN analytics.mask(left(errors::text, 300)) END AS problems
FROM core.sync_runs;

-- ---------------------------------------------------------------------------
-- Reconciliation (M3 gate): a day's view figures must equal raw message_log
-- counts once admin and pre-go-live rows are taken out.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION analytics.reconcile(p_day date) RETURNS jsonb
LANGUAGE sql STABLE AS $$
    WITH raw AS (
        SELECT m.* FROM core.message_log m
        WHERE m.direction = 'in' AND (m.ts AT TIME ZONE 'Asia/Kolkata')::date = p_day
    ), adm AS (
        SELECT * FROM raw WHERE wa_hash IN (SELECT wa_hash FROM core.admins)
    ), early AS (
        SELECT * FROM raw WHERE ts < (SELECT analytics.since()) AND wa_hash NOT IN (SELECT wa_hash FROM core.admins)
    ), v AS (
        SELECT * FROM analytics.v_daily WHERE day = p_day
    )
    SELECT jsonb_build_object(
        'day', p_day,
        'raw_inbound', (SELECT count(*) FROM raw),
        'admin_inbound', (SELECT count(*) FROM adm),
        'before_go_live', (SELECT count(*) FROM early),
        'view_turns', coalesce((SELECT turns FROM v), 0),
        'raw_citizens', (SELECT count(DISTINCT wa_hash) FROM raw
                         WHERE wa_hash NOT IN (SELECT wa_hash FROM core.admins) AND ts >= (SELECT analytics.since())),
        'view_citizens', coalesce((SELECT citizens FROM v), 0),
        'ok', (SELECT count(*) FROM raw) - (SELECT count(*) FROM adm) - (SELECT count(*) FROM early)
                  = coalesce((SELECT turns FROM v), 0)
              AND (SELECT count(DISTINCT wa_hash) FROM raw
                   WHERE wa_hash NOT IN (SELECT wa_hash FROM core.admins) AND ts >= (SELECT analytics.since()))
                  = coalesce((SELECT citizens FROM v), 0))
$$;

-- ---------------------------------------------------------------------------
-- Daily report (core-85-daily-report, 08:00 IST) and archive
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION analytics.day_stats(p_day date) RETURNS jsonb
LANGUAGE sql STABLE AS $$
    SELECT coalesce((SELECT to_jsonb(d) - 'day' FROM analytics.v_daily d WHERE d.day = p_day), '{}'::jsonb)
        || jsonb_build_object(
            'top_topics', coalesce((SELECT jsonb_agg(x) FROM (
                SELECT service_key, subtype, turns FROM analytics.v_topics
                -- answers only: navigation steps and admin tools are not "topics"
                WHERE day = p_day AND subtype NOT IN ('menu', 'feedback', '(none)', 'open', 'ask_prompt', 'near_menu', 'near_ask', 'error')
                  AND subtype NOT LIKE 'adm\_%'
                ORDER BY turns DESC, subtype LIMIT 5) x), '[]'),
            'peak_hour', (SELECT jsonb_build_object('hour', hour, 'turns', turns) FROM analytics.v_hourly
                          WHERE day = p_day ORDER BY turns DESC, hour LIMIT 1),
            'near', coalesce((SELECT jsonb_object_agg(distance_bucket, n) FROM (
                SELECT distance_bucket, sum(turns) AS n FROM analytics.v_near WHERE day = p_day GROUP BY 1) x), '{}'))
$$;

CREATE OR REPLACE FUNCTION analytics.archive_day(p_day date) RETURNS void
LANGUAGE sql AS $$
    INSERT INTO analytics.daily_archive (day, stats) VALUES (p_day, analytics.day_stats(p_day))
    ON CONFLICT (day) DO UPDATE SET stats = EXCLUDED.stats, archived_at = now()
$$;

-- Returns {day, stats, text (multi-line, e-mail), line (one line, WhatsApp template)}.
-- Services add their own lines by defining svc_<key>.digest() RETURNS text.
CREATE OR REPLACE FUNCTION analytics.daily_report(p_day date DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
    d        date := coalesce(p_day, ((now() AT TIME ZONE 'Asia/Kolkata')::date - 1));
    s        jsonb;
    inr      numeric := analytics.setting('usd_inr', '84')::numeric;
    lines    text[] := '{}';
    topics   text;
    themes   text;
    svc      record;
    extra    text;
    syncs    text;
    adm_fail int;
BEGIN
    s := analytics.day_stats(d);
    INSERT INTO analytics.daily_archive (day, stats) VALUES (d, s)
    ON CONFLICT (day) DO UPDATE SET stats = EXCLUDED.stats, archived_at = now();

    SELECT string_agg(format('%s %s', x->>'subtype', x->>'turns'), ', ')
      INTO topics FROM jsonb_array_elements(s->'top_topics') x;
    SELECT string_agg(format('"%s" ×%s', left(theme, 40), n), ', ')
      INTO themes FROM (SELECT theme, count(*) AS n FROM analytics.v_unanswered
                        WHERE day = d AND theme IS NOT NULL GROUP BY theme ORDER BY n DESC, theme LIMIT 3) t;
    SELECT string_agg(format('%s: %s failed', service_key, n), ', ')
      INTO syncs FROM (SELECT service_key, count(*) AS n FROM core.sync_runs
                       WHERE status <> 'ok' AND (ts AT TIME ZONE 'Asia/Kolkata')::date = d GROUP BY 1) t;

    lines := lines || format('Citizen bot report for %s', to_char(d, 'DD Mon YYYY'));
    lines := lines || format('Citizens: %s (%s new) · messages: %s (menu %s, typed %s, location %s, voice/media %s)',
        coalesce(s->>'citizens', '0'), coalesce(s->>'new_citizens', '0'), coalesce(s->>'turns', '0'),
        coalesce(s->>'menu_taps', '0'), coalesce(s->>'typed', '0'), coalesce(s->>'locations', '0'), coalesce(s->>'voice_media', '0'));
    lines := lines || format('Answered: %s%% · unanswered: %s · 👍 %s / 👎 %s',
        coalesce(s->>'resolved_pct', '-'), coalesce(s->>'unanswered', '0'),
        coalesce(s->>'thumbs_up', '0'), coalesce(s->>'thumbs_down', '0'));
    IF topics IS NOT NULL THEN lines := lines || ('Top: ' || topics); END IF;
    IF s->'peak_hour' IS NOT NULL AND s->'peak_hour' <> 'null' THEN
        lines := lines || format('Peak hour: %s:00–%s:00 (%s messages)',
            lpad(s->'peak_hour'->>'hour', 2, '0'), lpad(((s->'peak_hour'->>'hour')::int + 1)::text, 2, '0'), s->'peak_hour'->>'turns');
    END IF;
    IF themes IS NOT NULL THEN lines := lines || ('Not answered: ' || themes); END IF;
    lines := lines || format('Errors: %s turn, %s send · reply time p95: %s ms · AI: %s tokens ≈ ₹%s',
        coalesce(s->>'turn_errors', '0'), coalesce(s->>'send_errors', '0'), coalesce(s->>'p95_ms', '-'),
        coalesce(s->>'llm_tokens', '0'), round(coalesce((s->>'llm_usd_est')::numeric, 0) * inr, 2));
    IF syncs IS NOT NULL THEN lines := lines || ('Sheet sync problems: ' || syncs); END IF;
    SELECT count(*) INTO adm_fail FROM core.message_log
     WHERE direction = 'out' AND service_key = 'admin' AND error IS NOT NULL
       AND (ts AT TIME ZONE 'Asia/Kolkata')::date = d;
    IF adm_fail > 0 THEN
        lines := lines || format('⚠ %s admin WhatsApp alert(s) failed to send - is the admin_alert template approved?', adm_fail);
    END IF;

    FOR svc IN SELECT service_key FROM core.services WHERE enabled ORDER BY menu_order LOOP
        IF to_regprocedure(format('svc_%s.digest()', svc.service_key)) IS NOT NULL THEN
            BEGIN
                EXECUTE format('SELECT svc_%s.digest()', svc.service_key) INTO extra;
                IF extra IS NOT NULL AND extra <> '' THEN lines := lines || extra; END IF;
            EXCEPTION WHEN OTHERS THEN
                lines := lines || format('%s digest failed: %s', svc.service_key, SQLERRM);
            END;
        END IF;
    END LOOP;

    RETURN jsonb_build_object(
        'day', d,
        'stats', s,
        'text', array_to_string(lines, E'\n'),
        -- WhatsApp template parameters may not contain newlines: one line, ≤ 900 chars
        'line', left(array_to_string(lines, ' | '), 900));
END $$;

-- ---------------------------------------------------------------------------
-- Retention purge (core-09-purge, nightly). Archives aggregates first, so the
-- day totals survive; then deletes personal data older than retention_days.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION core.run_purge() RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
    days    int := analytics.setting('retention_days', '180')::int;
    cutoff  timestamptz := now() - make_interval(days => days);
    d       date;
    n_arch  int := 0;
    n_sync  int;
    r       jsonb;
BEGIN
    IF days < 30 THEN
        RAISE EXCEPTION 'retention_days = % is below the 30-day safety floor', days;
    END IF;
    FOR d IN SELECT DISTINCT (ts AT TIME ZONE 'Asia/Kolkata')::date FROM core.message_log
             WHERE ts < cutoff AND direction = 'in'
             EXCEPT SELECT day FROM analytics.daily_archive LOOP
        PERFORM analytics.archive_day(d);
        n_arch := n_arch + 1;
    END LOOP;
    r := core.purge_older_than(days);
    DELETE FROM core.sync_runs WHERE ts < now() - interval '90 days';
    GET DIAGNOSTICS n_sync = ROW_COUNT;
    RETURN r || jsonb_build_object('retention_days', days, 'archived_days', n_arch, 'sync_runs', n_sync);
END $$;

-- ---------------------------------------------------------------------------
-- Read-only role for Metabase. The login user (metabase_ro) is created by
-- scripts/db_migrate.sh when METABASE_DB_PASSWORD is set.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'analytics_ro') THEN
        CREATE ROLE analytics_ro NOLOGIN;
    END IF;
END $$;
REVOKE ALL ON SCHEMA core FROM analytics_ro;
REVOKE ALL ON ALL TABLES IN SCHEMA core FROM analytics_ro;
GRANT USAGE ON SCHEMA analytics TO analytics_ro;
REVOKE ALL ON ALL TABLES IN SCHEMA analytics FROM analytics_ro;
GRANT SELECT ON analytics.v_turns, analytics.v_send_errors, analytics.v_feedback, analytics.v_unanswered,
                analytics.v_daily, analytics.v_hourly, analytics.v_topics, analytics.v_feedback_by_topic,
                analytics.v_unanswered_themes, analytics.v_near, analytics.v_sync, analytics.daily_archive
      TO analytics_ro;
-- The views need mask/theme/setting/since (PUBLIC by default); the report and
-- purge functions are for the n8n user only.
REVOKE EXECUTE ON FUNCTION analytics.daily_report(date), analytics.archive_day(date), analytics.day_stats(date),
                           analytics.reconcile(date), core.run_purge() FROM PUBLIC;
