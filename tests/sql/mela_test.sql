-- svc_mela SQL tests (rolled back). psql -v ON_ERROR_STOP=1 -f tests/sql/mela_test.sql
BEGIN;
DO $$
DECLARE r jsonb; s jsonb; d jsonb := '{
  "places": [
    {"id": "TH01", "category": "thana", "name_en": "Nakash Thana", "lat": null, "lon": null, "sort": 0},
    {"id": "GH01", "category": "ghat", "name_en": "Kali Ghat", "lat": 25.6925, "lon": 85.1755, "sort": 1}],
  "duty": [
    {"place_id": "TH01", "shift_no": 1, "person_name": "Vishal Anand", "phones": ["9308642005"]},
    {"place_id": "TH01", "shift_no": null, "person_name": "", "phones": ["06158-221084"]}],
  "control": [{"desk": "Police", "sort": 0, "shift_no": 2, "person_name": "SI X", "designation": "", "phones": ["9123641400"]}],
  "events": [{"id": "E01", "date": "2026-11-24", "time": "18:30", "programme_en": "Folk night", "is_highlight": true}],
  "guidelines": [{"id": "G1", "kind": "do", "text_en": "Keep children close", "sort": 1}],
  "settings": {"shift1_start": "06:00", "public_helpline_1": "06158-221084"}}';
BEGIN
    r := svc_mela.replace_all(d);
    ASSERT r->>'places' = '2' AND r->>'duty' = '2' AND r->>'events' = '1', 'replace_all counts: ' || r::text;
    ASSERT core.disallowed_numbers(ARRAY['9308642005', '06158221084', '9123641400']) = '{}', 'mela numbers registered for the phone guard';

    -- captured point is used when the sheet has none; the sheet wins otherwise
    r := svc_mela.apply_effects('{"wa_hash": "adm", "effects": [
        {"type": "save_coords", "place_id": "TH01", "lat": 25.69, "lon": 85.17},
        {"type": "save_coords", "place_id": "GH01", "lat": 1, "lon": 1},
        {"type": "save_coords", "place_id": "NOPE", "lat": 1, "lon": 1}]}');
    ASSERT r->>'applied' = '2', 'unknown place ignored';
    s := svc_mela.snapshot();
    ASSERT (SELECT x->>'coord_source' FROM jsonb_array_elements(s->'places') x WHERE x->>'id' = 'TH01') = 'captured', 'captured coords used';
    ASSERT (SELECT (x->>'lat')::float8 FROM jsonb_array_elements(s->'places') x WHERE x->>'id' = 'GH01') = 25.6925, 'sheet lat/lon wins';
    ASSERT s->'events'->0->>'date' = '2026-11-24' AND (s->'events'->0->>'is_highlight')::boolean, 'events in snapshot';
    ASSERT jsonb_array_length(s->'duty'->0->'phones') = 1, 'phones as arrays';

    -- a re-sync never wipes captured points
    PERFORM svc_mela.replace_all(d);
    ASSERT (SELECT count(*) FROM svc_mela.place_coords WHERE place_id IN ('TH01', 'GH01')) = 2, 'place_coords survive replace_all';

    -- a sheet without a number removes it from the phone guard
    PERFORM svc_mela.replace_all(jsonb_set(d, '{duty}', '[]'));
    ASSERT core.disallowed_numbers(ARRAY['9308642005']) = ARRAY['9308642005'], 'dropped numbers are no longer allowed';

    -- places to visit + FAQ: stored, in the snapshot, numbers inside answers allowed
    r := svc_mela.replace_all(d || '{
      "attractions": [{"id": "A01", "type": "animal_bazaar", "name_en": "Ghoda Bazaar", "name_hi": "घोड़ा बाज़ार", "lat": 25.6951, "lon": 85.1782,
                       "keywords": ["horse", "घोड़ा"], "sort": 0}],
      "faq": [{"id": "Q01", "question_en": "Entry fee?", "answer_en": "Free. Call 9431000000.", "sort": 0}],
      "text_numbers": ["9431000000"]}');
    ASSERT r->>'attractions' = '1' AND r->>'faq' = '1', 'replace_all counts attractions/faq: ' || r::text;
    s := svc_mela.snapshot();
    ASSERT s->'attractions'->0->>'name_hi' = 'घोड़ा बाज़ार' AND s->'attractions'->0->'keywords' = '["horse", "घोड़ा"]'::jsonb, 'attractions in snapshot: ' || (s->'attractions')::text;
    ASSERT (s->'attractions'->0->>'lat')::float8 = 25.6951, 'attraction coordinates';
    ASSERT s->'faq'->0->>'answer_en' = 'Free. Call 9431000000.', 'faq in snapshot';
    ASSERT core.disallowed_numbers(ARRAY['9431000000']) = '{}', 'a number written in an FAQ answer may be sent';
    PERFORM svc_mela.replace_all(d);
    ASSERT (SELECT count(*) FROM svc_mela.attractions) = 0 AND svc_mela.snapshot()->'faq' = '[]'::jsonb, 'an older sheet without the tabs clears them';
    ASSERT core.disallowed_numbers(ARRAY['9431000000']) = ARRAY['9431000000'], 'and its numbers';

    -- sync alert throttling: once per hour per identical error set
    ASSERT (core.record_sync('{"service_key": "mela", "status": "rejected", "errors": [{"row": 14}]}')->>'should_alert')::boolean, 'first failure alerts';
    ASSERT NOT (core.record_sync('{"service_key": "mela", "status": "rejected", "errors": [{"row": 14}]}')->>'should_alert')::boolean, 'same failure is quiet';
    ASSERT (core.record_sync('{"service_key": "mela", "status": "rejected", "errors": [{"row": 15}]}')->>'should_alert')::boolean, 'new failure alerts';
    ASSERT NOT (core.record_sync('{"service_key": "mela", "status": "ok", "rows": 50}')->>'should_alert')::boolean, 'success never alerts';

    -- health: ok with a fresh successful sync, degraded when it is over an hour old
    UPDATE core.services SET enabled = true WHERE service_key = 'mela';
    DELETE FROM core.sync_runs;
    PERFORM core.record_sync('{"service_key": "mela", "status": "ok", "rows": 2}');
    ASSERT core.health()->>'status' = 'ok', 'fresh sync is healthy: ' || core.health()::text;
    UPDATE core.sync_runs SET ts = now() - interval '2 hours';
    ASSERT core.health()->>'status' = 'degraded' AND core.health()->'issues'->>0 LIKE 'mela sheet not synced%', 'stale sync degrades';

    ASSERT (SELECT length(content) FROM svc_mela.qa_context) > 1000, 'Q&A context loaded by db_migrate.sh';
    ASSERT (SELECT enabled FROM core.services WHERE service_key = 'mela') IS NOT NULL, 'mela registered';
    RAISE NOTICE 'mela_test: all assertions passed';
END $$;
ROLLBACK;
