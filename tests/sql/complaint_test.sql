-- svc_complaint schema SQL tests (rolled back). psql -v ON_ERROR_STOP=1 -f tests/sql/complaint_test.sql
BEGIN;
DO $$
DECLARE id1 text; id2 text; r jsonb; s jsonb; mela_kw text[]; cmp_kw text[];
BEGIN
    -- next_complaint_id: stable format, monotonic within the year
    id1 := svc_complaint.next_complaint_id();
    id2 := svc_complaint.next_complaint_id();
    ASSERT id1 ~ '^SCB-\d{4}-C\d{5}$', 'id format: ' || id1;
    ASSERT id2 > id1, 'ids increase monotonically: ' || id1 || ' / ' || id2;

    -- apply_effects: creates the complaint, its evidence and an 'open' history row
    r := svc_complaint.apply_effects('{"wa_hash": "wa-abc", "effects": [
        {"type": "create_complaint", "category_key": "water_supply", "description": "no water since morning",
         "lang": "hi", "lat": 25.69, "lon": 85.17,
         "evidence": [{"path": "wa-abc/1.jpg", "mime": "image/jpeg", "kind": "photo", "sha256": "abc"}]}]}');
    ASSERT r->>'complaint_id' ~ '^SCB-\d{4}-C\d{5}$', 'apply_effects returns a real id: ' || r::text;
    ASSERT (SELECT status FROM grievance.complaints WHERE complaint_id = r->>'complaint_id') = 'open', 'new complaint starts open';
    ASSERT (SELECT department_id FROM grievance.complaints WHERE complaint_id = r->>'complaint_id')
         = (SELECT department_id FROM grievance.complaint_categories WHERE category_key = 'water_supply'),
        'department copied from the category at creation time';
    ASSERT (SELECT count(*) FROM grievance.complaint_evidence WHERE complaint_id = r->>'complaint_id') = 1, 'evidence row inserted';
    ASSERT (SELECT to_status FROM grievance.complaint_status_history WHERE complaint_id = r->>'complaint_id') = 'open',
        'intake recorded in status history';
    ASSERT (SELECT due_at > created_at FROM grievance.complaints WHERE complaint_id = r->>'complaint_id'), 'due_at set from category sla_days';

    -- an unknown category is never silently misfiled
    r := svc_complaint.apply_effects('{"wa_hash": "wa-abc", "effects": [
        {"type": "create_complaint", "category_key": "not_a_real_category", "description": "x", "lat": 1, "lon": 1}]}');
    ASSERT r->>'complaint_id' IS NULL, 'unknown category produces no complaint';

    -- snapshot(): categories for the menu, the citizen's own complaints, and the geofence setting
    s := svc_complaint.snapshot('wa-abc');
    ASSERT jsonb_array_length(s->'categories') = 11, 'snapshot lists all 11 categories';
    ASSERT jsonb_array_length(s->'my_complaints') >= 1, 'snapshot includes this citizen''s complaint';
    ASSERT NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(svc_complaint.snapshot('someone-else-entirely')->'my_complaints') x
        WHERE x->>'complaint_id' = r->>'complaint_id'
    ), 'a citizen never sees another citizen''s complaint id';
    ASSERT (s->'geofence'->>'enabled') = 'false', 'geofence disabled by default';

    -- coexistence with mela: the one intentional keyword correction
    SELECT keywords INTO mela_kw FROM core.services WHERE service_key = 'mela';
    ASSERT NOT ('complaint' = ANY (mela_kw)), 'mela no longer owns the "complaint" keyword';
    ASSERT NOT ('शिकायत' = ANY (mela_kw)), 'mela no longer owns the "शिकायत" keyword';
    ASSERT 'control' = ANY (mela_kw), 'mela keeps its own control-room keyword';

    -- registry row: disabled by default, like every new service (docs/adding-a-service.md)
    ASSERT (SELECT id_prefix FROM core.services WHERE service_key = 'complaint') = 'cmp', 'complaint service registered';
    SELECT keywords INTO cmp_kw FROM core.services WHERE service_key = 'complaint';
    ASSERT 'scb' = ANY (cmp_kw),
        '"scb" must be a keyword, or typing a bare complaint id with no pending state goes to the LLM instead of this service';
    ASSERT NOT (SELECT enabled FROM core.services WHERE service_key = 'complaint'), 'disabled by default until M5 is staged';
    -- menu_order is higher than mela's on purpose (not lower): both services
    -- set accepts_location, and route.js falls back to the first enabled
    -- service with that flag for an unsolicited location share with no
    -- pending state - mela must stay that default so "near me" is unchanged.
    -- Keyword routing is unaffected by this ordering (decided by which
    -- service's own keyword list matches, checked above).
    ASSERT (SELECT menu_order FROM core.services WHERE service_key = 'complaint')
         > (SELECT menu_order FROM core.services WHERE service_key = 'mela'),
        'mela stays the default handler for an unsolicited location share ("near me")';

    RAISE NOTICE 'complaint_test: all assertions passed';
END $$;
ROLLBACK;
