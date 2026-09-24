-- Core SQL tests. Run against a migrated DB:  psql -v ON_ERROR_STOP=1 -f tests/sql/core_test.sql
-- Everything runs in one transaction and is rolled back.
BEGIN;

DO $$
DECLARE r jsonb; r2 jsonb; ok boolean; n int; s text := 'test-secret'; k text := 'test-key';
BEGIN
    -- norm_phone
    ASSERT core.norm_phone('+91 94310-12345') = '9431012345', 'norm strips +91 and punctuation';
    ASSERT core.norm_phone('06152-240001') = '06152240001', 'landline keeps leading 0';
    ASSERT core.norm_phone('919431012345') = '9431012345', 'bare 91 prefix dropped';

    -- first message: new citizen, first contact, not dup
    r := core.begin_turn('919000000001', 'wamid.T1', 'text', 'hi', 'en', s, k);
    ASSERT (r->>'is_dup')::boolean = false, 'first message is not a dup';
    ASSERT (r->>'first_contact')::boolean = true, 'first contact flagged';
    ASSERT r->>'wa_hash' = core.hash_phone('9000000001', s), 'hash is stable across number formats';
    ASSERT r->>'lang' = 'en', 'language follows the guess for new citizens';
    ASSERT (r->>'version')::int = 0, 'fresh session version 0';

    -- duplicate delivery of the same Meta message id
    r2 := core.begin_turn('919000000001', 'wamid.T1', 'text', 'hi', 'en', s, k);
    ASSERT (r2->>'is_dup')::boolean = true, 'same wamid is a dup';

    -- second message: no longer first contact
    r2 := core.begin_turn('919000000001', 'wamid.T2', 'text', 'नमस्ते', 'hi', s, k);
    ASSERT (r2->>'first_contact')::boolean = false, 'notice shown only once';
    ASSERT r2->>'lang' = 'hi', 'language follows script while not explicitly set';

    -- a button/voice/location (no language guess) keeps the current language
    r2 := core.begin_turn('919000000001', 'wamid.T2b', 'button', NULL, NULL, s, k);
    ASSERT r2->>'lang' = 'hi', 'no guess keeps language (regression: NULL NOT IN -> NULL lang)';

    -- explicit language choice sticks
    PERFORM core.set_lang(r->>'wa_hash', 'en');
    r2 := core.begin_turn('919000000001', 'wamid.T3', 'text', 'नमस्ते', 'hi', s, k);
    ASSERT r2->>'lang' = 'en', 'explicit language choice overrides script guess';

    -- encrypted number round-trip
    ASSERT (SELECT pgp_sym_decrypt(wa_number_enc, k) FROM core.citizens WHERE wa_hash = r->>'wa_hash') = '9000000001',
        'number decrypts with the key';

    -- end_turn optimistic locking
    ok := core.end_turn(r->>'wa_hash', (r2->>'version')::int, 'echo.wait', '{"a":1}', 'wamid.T3', 'echo', 'repeat', 'text', true);
    ASSERT ok, 'end_turn succeeds on the current version';
    ok := core.end_turn(r->>'wa_hash', (r2->>'version')::int, 'echo.other', '{}', 'wamid.T3', 'echo', NULL, 'text', true);
    ASSERT NOT ok, 'stale version is rejected';
    ASSERT (SELECT state FROM core.sessions WHERE wa_hash = r->>'wa_hash') = 'echo.wait', 'state kept from winning turn';
    ASSERT (SELECT service_key FROM core.message_log WHERE wa_msg_id = 'wamid.T3') = 'echo', 'inbound row annotated';

    -- session expiry returns an empty session
    UPDATE core.sessions SET updated_at = now() - interval '31 minutes' WHERE wa_hash = r->>'wa_hash';
    r2 := core.begin_turn('919000000001', 'wamid.T4', 'text', 'x', 'en', s, k);
    ASSERT r2->>'state' IS NULL AND r2->'context' = '{}'::jsonb, 'expired session comes back empty';

    -- location text never stored
    r2 := core.begin_turn('919000000001', 'wamid.T5', 'location', '25.7,85.1', 'en', s, k);
    ASSERT (SELECT text FROM core.message_log WHERE wa_msg_id = 'wamid.T5') IS NULL, 'location coordinates not logged';

    -- rate limit: 20 allowed in 5 min, 21st flagged with a one-time notice, 22nd silent
    FOR n IN 1..20 LOOP
        r2 := core.begin_turn('919000000002', 'wamid.R' || n, 'text', 'x', 'en', s, k);
        ASSERT (r2->>'rate_limited')::boolean = false, 'within limit at ' || n;
    END LOOP;
    r2 := core.begin_turn('919000000002', 'wamid.R21', 'text', 'x', 'en', s, k);
    ASSERT (r2->>'rate_limited')::boolean AND (r2->>'rate_notice')::boolean, '21st limited with notice';
    r2 := core.begin_turn('919000000002', 'wamid.R22', 'text', 'x', 'en', s, k);
    ASSERT (r2->>'rate_limited')::boolean AND NOT (r2->>'rate_notice')::boolean, '22nd limited silently';

    -- admins
    PERFORM core.set_admins('9000000003, +91 90000 00004', s);
    r2 := core.begin_turn('919000000004', 'wamid.A1', 'text', 'pin', 'en', s, k);
    ASSERT (r2->>'is_admin')::boolean, 'admin recognised';
    ASSERT NOT (core.begin_turn('919000000005', 'wamid.A2', 'text', 'pin', 'en', s, k)->>'is_admin')::boolean, 'non-admin';

    -- number registry / phone guard
    PERFORM core.register_numbers('test', ARRAY['9431012345', '06152-240001']);
    ASSERT core.disallowed_numbers(ARRAY['+91 9431012345', '112', '06152240001']) = '{}', 'registered + static allowed';
    ASSERT core.disallowed_numbers(ARRAY['9999999999']) = ARRAY['9999999999'], 'unknown number blocked';
    PERFORM core.register_numbers('test', ARRAY['9431012345']);
    ASSERT core.disallowed_numbers(ARRAY['06152240001']) = ARRAY['06152240001'], 're-register replaces source';

    -- purge
    UPDATE core.message_log SET ts = now() - interval '200 days' WHERE wa_msg_id = 'wamid.T1';
    ASSERT (core.purge_older_than(180)->>'message_log')::int = 1, 'purge removes old log rows';

    -- rpc wrappers
    r := core.rpc_begin_turn(jsonb_build_object('wa_id', '919000000009', 'msg_id', 'wamid.RPC1', 'kind', 'text',
                             'text', 'hi', 'lang_guess', 'en', 'hash_secret', s, 'enc_key', k));
    ASSERT jsonb_typeof(r->'services') = 'array' AND r->'templates' ? 'menu_prompt', 'rpc_begin_turn carries registry + templates';
    ASSERT r->'settings'->>'llm_enabled' = 'true', 'settings exposed';
    r2 := core.rpc_end_turn(jsonb_build_object('wa_hash', r->>'wa_hash', 'version', (r->>'version')::int, 'state', 'echo.wait',
                            'context', '{"x":1}'::jsonb, 'in_msg_id', 'wamid.RPC1', 'service_key', 'echo', 'via', 'button',
                            'resolved', true, 'set_lang', 'hi', 'feedback_rating', 1, 'unanswered_reason', 'no_service', 'text', 'blah'));
    ASSERT (r2->>'ok')::boolean, 'rpc_end_turn ok';
    ASSERT (SELECT lang_explicit FROM core.citizens WHERE wa_hash = r->>'wa_hash'), 'rpc sets explicit language';
    ASSERT (SELECT count(*) FROM core.feedback WHERE wa_hash = r->>'wa_hash') = 1, 'rpc stores feedback';
    ASSERT (SELECT count(*) FROM core.unanswered WHERE wa_hash = r->>'wa_hash') = 1, 'rpc stores unanswered';
    r2 := core.rpc_end_turn(jsonb_build_object('wa_hash', r->>'wa_hash', 'version', (r->>'version')::int, 'in_msg_id', 'wamid.RPC1'));
    ASSERT NOT (r2->>'ok')::boolean AND (SELECT error FROM core.message_log WHERE wa_msg_id = 'wamid.RPC1') = 'version_conflict',
        'conflict recorded on the inbound row';
    PERFORM core.rpc_log_out(jsonb_build_object('wa_hash', r->>'wa_hash', 'kind', 'text', 'text', 'hello', 'out_id', 'wamid.OUT1'));
    ASSERT (SELECT direction FROM core.message_log WHERE wa_msg_id = 'wamid.OUT1') = 'out', 'outbound logged';

    RAISE NOTICE 'core_test: all assertions passed';
END $$;

ROLLBACK;
