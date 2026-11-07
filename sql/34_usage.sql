-- Usage statistics for the staff portal's Usage page (district admin only).
-- Idempotent; runs after 20_analytics.sql (the analytics views) and
-- 30_grievance.sql (grievance_app).
--
-- The portal's login (portal_rw via grievance_app) has no access to core or
-- analytics. This one SECURITY DEFINER function hands it aggregates only:
-- day totals, topic counts and the unanswered-question themes, all from the
-- analytics views, which already leave out phone numbers (citizens are a
-- pseudonymous ref there, and digit runs/e-mails in typed text are masked)
-- and admin numbers. No row-level citizen data leaves this function.
--
-- It checks the caller's role itself (same double check as
-- grievance.complaints_visible_to): only an enabled district admin gets data.

CREATE OR REPLACE FUNCTION grievance.usage_report(p_user_id bigint, p_days int) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
    v_days int := greatest(1, least(coalesce(p_days, 14), 90));
    v_to   date := (now() AT TIME ZONE 'Asia/Kolkata')::date;
    v_from date := v_to - (v_days - 1);
BEGIN
    IF NOT EXISTS (SELECT 1 FROM grievance.portal_users u
                   WHERE u.user_id = p_user_id AND u.enabled AND u.role = 'district_admin') THEN
        RAISE EXCEPTION 'usage statistics are for the district admin only' USING ERRCODE = '42501';
    END IF;

    RETURN jsonb_build_object(
        'from', v_from,
        'to', v_to,
        'days', v_days,
        'totals', (
            SELECT jsonb_build_object(
                'citizens', count(DISTINCT t.citizen_ref),
                'messages', count(*),
                'answered_pct', round(100.0 * count(*) FILTER (WHERE t.resolved) / nullif(count(*) FILTER (WHERE t.resolved IS NOT NULL), 0), 1))
            FROM analytics.v_turns t WHERE t.day BETWEEN v_from AND v_to),
        'new_citizens', (
            SELECT coalesce(sum(d.new_citizens), 0) FROM analytics.v_daily d WHERE d.day BETWEEN v_from AND v_to),
        'complaints_filed', (
            SELECT count(*) FROM grievance.complaints c
            WHERE (c.created_at AT TIME ZONE 'Asia/Kolkata')::date BETWEEN v_from AND v_to),
        'daily', coalesce((
            SELECT jsonb_agg(jsonb_build_object(
                       'day', d.day, 'citizens', d.citizens, 'new_citizens', d.new_citizens,
                       'messages', d.turns, 'answered_pct', d.resolved_pct, 'unanswered', d.unanswered,
                       'thumbs_up', d.thumbs_up, 'thumbs_down', d.thumbs_down) ORDER BY d.day)
            FROM analytics.v_daily d WHERE d.day BETWEEN v_from AND v_to), '[]'::jsonb),
        'topics', coalesce((
            SELECT jsonb_agg(jsonb_build_object('service_key', x.service_key, 'subtype', x.subtype,
                                                'messages', x.n, 'citizens', x.c) ORDER BY x.n DESC)
            FROM (SELECT coalesce(t.service_key, '(core)') AS service_key, coalesce(t.subtype, '(none)') AS subtype,
                         count(*) AS n, count(DISTINCT t.citizen_ref) AS c
                  FROM analytics.v_turns t WHERE t.day BETWEEN v_from AND v_to
                  GROUP BY 1, 2) x), '[]'::jsonb),
        'unanswered', coalesce((
            SELECT jsonb_agg(jsonb_build_object('theme', y.theme, 'times', y.n, 'last_day', y.last_day,
                                                'example', y.example) ORDER BY y.n DESC, y.last_day DESC)
            FROM (SELECT u.theme, count(*) AS n, max(u.day) AS last_day,
                         (array_agg(u.text_masked ORDER BY u.ts_ist DESC))[1] AS example
                  FROM analytics.v_unanswered u
                  WHERE u.day BETWEEN v_from AND v_to AND u.theme IS NOT NULL
                  GROUP BY u.theme
                  ORDER BY count(*) DESC, max(u.day) DESC
                  LIMIT 20) y), '[]'::jsonb)
    );
END $$;

REVOKE EXECUTE ON FUNCTION grievance.usage_report(bigint, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION grievance.usage_report(bigint, int) TO grievance_app;
