-- Core platform schema: service registry, sessions, citizens, logging.
-- Idempotent: safe to re-run on every deploy (scripts/db_migrate.sh).
--
-- Secrets (phone-hash secret, encryption key) are never stored in the DB;
-- n8n passes them as parameters from its environment on every call.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE SCHEMA IF NOT EXISTS core;

-- Service registry: the only thing the router knows about services.
CREATE TABLE IF NOT EXISTS core.services (
    service_key      text PRIMARY KEY,
    id_prefix        text NOT NULL UNIQUE,          -- button/list ids and states start with '<id_prefix>:' / '<id_prefix>.'
    title_hi         text NOT NULL,                 -- <= 20 chars (reply-button title limit)
    title_en         text NOT NULL,
    description_hi   text,                          -- <= 72 chars (list-row description limit)
    description_en   text,
    menu_order       int  NOT NULL DEFAULT 100,
    enabled          boolean NOT NULL DEFAULT false,
    workflow_id      text NOT NULL,                 -- fixed n8n workflow id (n8n/src/workflows)
    intent_hint_en   text,                          -- fed to the LLM classifier prompt
    intent_hint_hi   text,
    subtypes         jsonb NOT NULL DEFAULT '{}',   -- {subtype: hint} for the classifier
    keywords         text[] NOT NULL DEFAULT '{}',
    accepts_location boolean NOT NULL DEFAULT false
);

-- User-facing strings, both languages. max_len is enforced by tests/check_templates.py.
CREATE TABLE IF NOT EXISTS core.templates (
    key      text PRIMARY KEY,
    hi       text NOT NULL,
    en       text NOT NULL,
    max_len  int
);

CREATE TABLE IF NOT EXISTS core.citizens (
    wa_hash          text PRIMARY KEY,              -- HMAC-SHA256(phone, PHONE_HASH_SECRET)
    wa_number_enc    bytea,                         -- pgp_sym_encrypt(phone, PGCRYPTO_KEY)
    lang             text NOT NULL DEFAULT 'hi' CHECK (lang IN ('hi', 'en')),
    lang_explicit    boolean NOT NULL DEFAULT false, -- true once the citizen used the language toggle
    first_seen       timestamptz NOT NULL DEFAULT now(),
    last_seen        timestamptz NOT NULL DEFAULT now(),
    notice_shown_at  timestamptz,
    msg_count        int NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS core.sessions (
    wa_hash     text PRIMARY KEY REFERENCES core.citizens (wa_hash) ON DELETE CASCADE,
    state       text,
    context     jsonb NOT NULL DEFAULT '{}',
    version     int  NOT NULL DEFAULT 0,
    updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS core.message_log (
    id           bigserial PRIMARY KEY,
    wa_msg_id    text UNIQUE,                       -- inbound Meta message id (dedupe) / outbound id
    wa_hash      text NOT NULL,
    direction    text NOT NULL CHECK (direction IN ('in', 'out')),
    service_key  text,
    state        text,
    subtype      text,
    kind         text,                              -- text | button | list | location | unsupported | ...
    text         text,                              -- never holds citizen coordinates
    via          text,                              -- button | list | text | llm | system
    resolved     boolean,
    llm_tokens   int,
    latency_ms   int,
    error        text,
    ts           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS message_log_ts_idx ON core.message_log (ts);
CREATE INDEX IF NOT EXISTS message_log_service_ts_idx ON core.message_log (service_key, ts);
CREATE INDEX IF NOT EXISTS message_log_rate_idx ON core.message_log (wa_hash, ts) WHERE direction = 'in';

CREATE TABLE IF NOT EXISTS core.feedback (
    id              bigserial PRIMARY KEY,
    wa_hash         text NOT NULL,
    service_key     text,
    rating          smallint NOT NULL CHECK (rating IN (-1, 1)),
    ts              timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS core.unanswered (
    id           bigserial PRIMARY KEY,
    wa_hash      text NOT NULL,
    text         text,
    service_key  text,
    reason       text,
    ts           timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS core.sync_runs (
    id           bigserial PRIMARY KEY,
    service_key  text NOT NULL,
    source       text,
    status       text NOT NULL CHECK (status IN ('ok', 'rejected', 'error')),
    rows         int,
    errors       jsonb,
    ts           timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS core.admins (
    wa_hash   text PRIMARY KEY,
    label     text,
    added_at  timestamptz NOT NULL DEFAULT now()
);

-- Runtime switches operators can flip without a restart (e.g. llm_enabled).
CREATE TABLE IF NOT EXISTS core.settings (
    key    text PRIMARY KEY,
    value  text NOT NULL
);

-- Numbers the bot is allowed to send. Services register theirs from their
-- sync jobs via core.register_numbers(); static emergency numbers live here too.
CREATE TABLE IF NOT EXISTS core.number_registry (
    source  text NOT NULL,
    phone   text NOT NULL,                          -- normalised (core.norm_phone)
    PRIMARY KEY (source, phone)
);

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

-- Digits only; drop a leading 91 country code from 12-digit numbers.
CREATE OR REPLACE FUNCTION core.norm_phone(p text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
    SELECT CASE
        WHEN d ~ '^91[6-9][0-9]{9}$' THEN substr(d, 3)
        ELSE d
    END
    FROM (SELECT regexp_replace(coalesce(p, ''), '[^0-9]', '', 'g') AS d) s
$$;

CREATE OR REPLACE FUNCTION core.hash_phone(p_phone text, p_secret text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
    SELECT encode(hmac(core.norm_phone(p_phone), p_secret, 'sha256'), 'hex')
$$;

-- Replace one source's registered numbers atomically.
CREATE OR REPLACE FUNCTION core.register_numbers(p_source text, p_phones text[]) RETURNS int
LANGUAGE plpgsql AS $$
DECLARE n int;
BEGIN
    DELETE FROM core.number_registry WHERE source = p_source;
    INSERT INTO core.number_registry (source, phone)
    SELECT DISTINCT p_source, core.norm_phone(x)
    FROM unnest(coalesce(p_phones, '{}')) AS x
    WHERE core.norm_phone(x) <> '';
    GET DIAGNOSTICS n = ROW_COUNT;
    RETURN n;
END $$;

-- Returns the subset of p_phones that is NOT allowed (empty array = all fine).
CREATE OR REPLACE FUNCTION core.disallowed_numbers(p_phones text[]) RETURNS text[]
LANGUAGE sql STABLE AS $$
    SELECT coalesce(array_agg(x ORDER BY x), '{}')
    FROM unnest(coalesce(p_phones, '{}')) AS x
    WHERE NOT EXISTS (
        SELECT 1 FROM core.number_registry r WHERE r.phone = core.norm_phone(x)
    )
$$;

-- Replace the admin list from plain numbers (ADMIN_WA_NUMBERS, comma separated).
CREATE OR REPLACE FUNCTION core.set_admins(p_numbers text, p_secret text) RETURNS int
LANGUAGE plpgsql AS $$
DECLARE n int;
BEGIN
    DELETE FROM core.admins;
    INSERT INTO core.admins (wa_hash, label)
    SELECT DISTINCT core.hash_phone(trim(x), p_secret), 'env'
    FROM unnest(string_to_array(coalesce(p_numbers, ''), ',')) AS x
    WHERE core.norm_phone(x) <> '';
    GET DIAGNOSTICS n = ROW_COUNT;
    RETURN n;
END $$;

-- ---------------------------------------------------------------------------
-- begin_turn: everything the router needs about an inbound message, in one call.
--   * dedupes on the Meta message id (Meta retries webhooks)
--   * upserts the citizen (hashed id + encrypted number)
--   * applies the per-user rate limit
--   * loads the session (expired sessions come back empty)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION core.begin_turn(
    p_wa_id        text,
    p_msg_id       text,
    p_kind         text,
    p_text         text,
    p_lang_guess   text,
    p_hash_secret  text,
    p_enc_key      text,
    p_rate_limit   int      DEFAULT 20,
    p_rate_window  interval DEFAULT '5 minutes',
    p_session_ttl  interval DEFAULT '30 minutes'
) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
    v_hash      text := core.hash_phone(p_wa_id, p_hash_secret);
    v_inserted  boolean;
    v_first     boolean;
    v_cit       core.citizens;
    v_sess      core.sessions;
    v_recent    int;
    v_expired   boolean;
BEGIN
    IF p_msg_id IS NOT NULL THEN
        INSERT INTO core.message_log (wa_msg_id, wa_hash, direction, kind, text)
        VALUES (p_msg_id, v_hash, 'in', p_kind, CASE WHEN p_kind = 'location' THEN NULL ELSE p_text END)
        ON CONFLICT (wa_msg_id) DO NOTHING;
        GET DIAGNOSTICS v_recent = ROW_COUNT;
        v_inserted := v_recent = 1;
        IF NOT v_inserted THEN
            RETURN jsonb_build_object('is_dup', true, 'wa_hash', v_hash);
        END IF;
    END IF;

    INSERT INTO core.citizens (wa_hash, wa_number_enc, lang)
    VALUES (v_hash, pgp_sym_encrypt(core.norm_phone(p_wa_id), p_enc_key),
            CASE WHEN p_lang_guess IN ('hi', 'en') THEN p_lang_guess ELSE 'hi' END)
    ON CONFLICT (wa_hash) DO UPDATE
        SET last_seen = now(),
            msg_count = core.citizens.msg_count + 1,
            -- follow the citizen's script unless they chose a language explicitly
            lang = CASE
                -- (coalesce: buttons/voice/location carry no language guess)
                WHEN core.citizens.lang_explicit OR coalesce(p_lang_guess, '') NOT IN ('hi', 'en') THEN core.citizens.lang
                ELSE p_lang_guess
            END
    RETURNING * INTO v_cit;

    v_first := v_cit.notice_shown_at IS NULL;
    IF v_first THEN
        UPDATE core.citizens SET notice_shown_at = now() WHERE wa_hash = v_hash;
    END IF;

    SELECT count(*) INTO v_recent
    FROM core.message_log
    WHERE wa_hash = v_hash AND direction = 'in' AND ts > now() - p_rate_window;

    INSERT INTO core.sessions (wa_hash) VALUES (v_hash)
    ON CONFLICT (wa_hash) DO NOTHING;
    SELECT * INTO v_sess FROM core.sessions WHERE wa_hash = v_hash;
    v_expired := v_sess.updated_at < now() - p_session_ttl;

    RETURN jsonb_build_object(
        'is_dup',        false,
        'wa_hash',       v_hash,
        'lang',          v_cit.lang,
        'first_contact', v_first,
        'is_admin',      EXISTS (SELECT 1 FROM core.admins a WHERE a.wa_hash = v_hash),
        'rate_limited',  v_recent > p_rate_limit,
        'rate_notice',   v_recent = p_rate_limit + 1,   -- tell them once, then stay silent
        'state',         CASE WHEN v_expired THEN NULL ELSE v_sess.state END,
        'context',       CASE WHEN v_expired THEN '{}'::jsonb ELSE v_sess.context END,
        'version',       v_sess.version
    );
END $$;

-- end_turn: save the new session state with an optimistic version check and
-- annotate the inbound log row. Returns false on a version conflict (a second
-- message from the same citizen was processed concurrently); the router then
-- re-runs the turn once.
CREATE OR REPLACE FUNCTION core.end_turn(
    p_wa_hash      text,
    p_version      int,
    p_state        text,
    p_context      jsonb,
    p_in_msg_id    text,
    p_service_key  text,
    p_subtype      text,
    p_via          text,
    p_resolved     boolean,
    p_llm_tokens   int DEFAULT NULL,
    p_latency_ms   int DEFAULT NULL
) RETURNS boolean
LANGUAGE plpgsql AS $$
DECLARE n int;
BEGIN
    UPDATE core.sessions
       SET state = p_state,
           context = coalesce(p_context, '{}'),
           version = version + 1,
           updated_at = now()
     WHERE wa_hash = p_wa_hash AND version = p_version;
    GET DIAGNOSTICS n = ROW_COUNT;

    UPDATE core.message_log
       SET service_key = p_service_key, state = p_state, subtype = p_subtype,
           via = p_via, resolved = p_resolved, llm_tokens = p_llm_tokens,
           latency_ms = p_latency_ms
     WHERE wa_msg_id = p_in_msg_id;

    RETURN n = 1;
END $$;

CREATE OR REPLACE FUNCTION core.set_lang(p_wa_hash text, p_lang text) RETURNS void
LANGUAGE sql AS $$
    UPDATE core.citizens SET lang = p_lang, lang_explicit = true
    WHERE wa_hash = p_wa_hash AND p_lang IN ('hi', 'en')
$$;

CREATE OR REPLACE FUNCTION core.log_out(
    p_wa_hash     text,
    p_service_key text,
    p_kind        text,
    p_text        text,
    p_out_id      text,
    p_error       text
) RETURNS void
LANGUAGE sql AS $$
    INSERT INTO core.message_log (wa_msg_id, wa_hash, direction, service_key, kind, text, via, error)
    VALUES (p_out_id, p_wa_hash, 'out', p_service_key, p_kind, left(p_text, 4096), 'system', p_error)
    ON CONFLICT (wa_msg_id) DO NOTHING
$$;

-- Retention (DPDP): drop personal data older than p_days.
CREATE OR REPLACE FUNCTION core.purge_older_than(p_days int) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
    cutoff timestamptz := now() - make_interval(days => p_days);
    n_log int; n_fb int; n_un int; n_cit int;
BEGIN
    DELETE FROM core.message_log WHERE ts < cutoff;        GET DIAGNOSTICS n_log = ROW_COUNT;
    DELETE FROM core.feedback WHERE ts < cutoff;           GET DIAGNOSTICS n_fb = ROW_COUNT;
    DELETE FROM core.unanswered WHERE ts < cutoff;         GET DIAGNOSTICS n_un = ROW_COUNT;
    DELETE FROM core.citizens WHERE last_seen < cutoff;    GET DIAGNOSTICS n_cit = ROW_COUNT;
    RETURN jsonb_build_object('message_log', n_log, 'feedback', n_fb,
                              'unanswered', n_un, 'citizens', n_cit);
END $$;

-- Registry rows the router needs, in menu order (cheap; read on every turn).
CREATE OR REPLACE VIEW core.v_enabled_services AS
SELECT service_key, id_prefix, title_hi, title_en, description_hi, description_en,
       menu_order, workflow_id, intent_hint_en, intent_hint_hi, subtypes, keywords,
       accepts_location
FROM core.services
WHERE enabled
ORDER BY menu_order, service_key;

-- Analytics views (M3 dashboards build on these); no raw numbers exposed.
CREATE OR REPLACE VIEW core.v_daily AS
SELECT date_trunc('day', ts AT TIME ZONE 'Asia/Kolkata')::date AS day,
       count(*) FILTER (WHERE direction = 'in')  AS inbound,
       count(*) FILTER (WHERE direction = 'out') AS outbound,
       count(DISTINCT wa_hash) FILTER (WHERE direction = 'in') AS citizens
FROM core.message_log
GROUP BY 1;

-- ---------------------------------------------------------------------------
-- JSON entry points used by the n8n workflows (one parameter each, so values
-- containing commas/quotes can never break the query parameter list).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION core.rpc_begin_turn(p jsonb) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE t jsonb;
BEGIN
    t := core.begin_turn(p->>'wa_id', p->>'msg_id', p->>'kind', p->>'text', p->>'lang_guess',
                         p->>'hash_secret', p->>'enc_key');
    IF (t->>'is_dup')::boolean THEN
        RETURN t;
    END IF;
    RETURN t || jsonb_build_object(
        'services',  coalesce((SELECT jsonb_agg(to_jsonb(s)) FROM core.v_enabled_services s), '[]'::jsonb),
        'templates', coalesce((SELECT jsonb_object_agg(key, jsonb_build_object('hi', hi, 'en', en)) FROM core.templates), '{}'::jsonb),
        'settings',  coalesce((SELECT jsonb_object_agg(key, value) FROM core.settings), '{}'::jsonb)
    );
END $$;

-- p: {wa_hash, version, state, context, in_msg_id, service_key, subtype, via, resolved,
--     llm_tokens, latency_ms, set_lang, feedback_rating, unanswered_reason, text}
CREATE OR REPLACE FUNCTION core.rpc_end_turn(p jsonb) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE ok boolean;
BEGIN
    IF p IS NULL OR jsonb_typeof(p) <> 'object' THEN
        RETURN jsonb_build_object('ok', true, 'skipped', true);   -- e.g. rate-limit notice: nothing to persist
    END IF;
    IF p->>'set_lang' IN ('hi', 'en') THEN
        PERFORM core.set_lang(p->>'wa_hash', p->>'set_lang');
    END IF;
    IF p ? 'feedback_rating' AND p->>'feedback_rating' IS NOT NULL THEN
        INSERT INTO core.feedback (wa_hash, service_key, rating)
        VALUES (p->>'wa_hash', p->>'service_key', (p->>'feedback_rating')::smallint);
    END IF;
    IF p->>'unanswered_reason' IS NOT NULL THEN
        INSERT INTO core.unanswered (wa_hash, text, service_key, reason)
        VALUES (p->>'wa_hash', left(p->>'text', 1000), p->>'service_key', p->>'unanswered_reason');
    END IF;
    ok := core.end_turn(p->>'wa_hash', (p->>'version')::int, p->>'state',
                        coalesce(p->'context', '{}'::jsonb), p->>'in_msg_id', p->>'service_key',
                        p->>'subtype', p->>'via', (p->>'resolved')::boolean,
                        (p->>'llm_tokens')::int, (p->>'latency_ms')::int);
    IF NOT ok THEN
        UPDATE core.message_log SET error = 'version_conflict' WHERE wa_msg_id = p->>'in_msg_id';
    END IF;
    RETURN jsonb_build_object('ok', ok);
END $$;

-- p: {wa_hash, service_key, kind, text, out_id, error}
CREATE OR REPLACE FUNCTION core.rpc_log_out(p jsonb) RETURNS jsonb
LANGUAGE plpgsql AS $$
BEGIN
    PERFORM core.log_out(coalesce(p->>'wa_hash', 'unknown'), p->>'service_key', p->>'kind',
                         p->>'text', nullif(p->>'out_id', ''), p->>'error');
    RETURN jsonb_build_object('ok', true);
END $$;

