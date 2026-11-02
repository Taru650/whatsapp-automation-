-- grievance schema SQL tests (rolled back). psql -v ON_ERROR_STOP=1 -f tests/sql/grievance_test.sql
BEGIN;
DO $$
DECLARE admin_id bigint; head_id bigint; officer_id bigint; d double precision; failed boolean;
BEGIN
    -- seed data: 11 categories including the animal-fair veterinary category
    ASSERT (SELECT count(*) FROM grievance.departments) >= 11, 'departments seeded';
    ASSERT (SELECT count(*) FROM grievance.complaint_categories) = 11, 'all 11 categories seeded';
    ASSERT EXISTS (SELECT 1 FROM grievance.complaint_categories WHERE category_key = 'veterinary_animal'),
        'veterinary/animal category present (Mela is an animal fair)';
    ASSERT NOT EXISTS (SELECT 1 FROM grievance.complaint_categories c
        LEFT JOIN grievance.departments d ON d.department_id = c.department_id WHERE d.department_id IS NULL),
        'every category maps to a real department';

    -- haversine sanity: Patna-ish 1 degree of latitude is roughly 111 km
    d := grievance.haversine_m(25.0, 85.0, 26.0, 85.0);
    ASSERT d > 110000 AND d < 112000, 'haversine_m: ' || d::text;
    ASSERT grievance.haversine_m(25.69, 85.17, 25.69, 85.17) = 0, 'zero distance to self';

    -- RBAC hierarchy: district_admin has no department, dept_head/field_officer must
    INSERT INTO grievance.portal_users (username, password_hash, full_name, role)
        VALUES ('admin1', 'x', 'District Admin', 'district_admin') RETURNING user_id INTO admin_id;
    INSERT INTO grievance.portal_users (username, password_hash, full_name, role, department_id, created_by_user_id)
        VALUES ('head1', 'x', 'Water Head', 'dept_head', (SELECT department_id FROM grievance.departments WHERE dept_key = 'phed'), admin_id)
        RETURNING user_id INTO head_id;
    INSERT INTO grievance.portal_users (username, password_hash, full_name, role, department_id, created_by_user_id)
        VALUES ('officer1', 'x', 'Water Officer', 'field_officer', (SELECT department_id FROM grievance.departments WHERE dept_key = 'phed'), head_id)
        RETURNING user_id INTO officer_id;
    ASSERT officer_id IS NOT NULL, 'dept_head creating a field_officer in their own department succeeds';

    failed := false;
    BEGIN
        INSERT INTO grievance.portal_users (username, password_hash, full_name, role, department_id, created_by_user_id)
            VALUES ('officer2', 'x', 'Wrong Dept Officer', 'field_officer',
                    (SELECT department_id FROM grievance.departments WHERE dept_key = 'electricity'), head_id);
    EXCEPTION WHEN OTHERS THEN failed := true;
    END;
    ASSERT failed, 'a dept_head cannot create a field_officer outside their own department';

    failed := false;
    BEGIN
        INSERT INTO grievance.portal_users (username, password_hash, full_name, role, department_id)
            VALUES ('bad_admin', 'x', 'Bad Admin', 'district_admin', (SELECT department_id FROM grievance.departments WHERE dept_key = 'phed'));
    EXCEPTION WHEN OTHERS THEN failed := true;
    END;
    ASSERT failed, 'district_admin must not have a department (CHECK constraint)';

    -- mandatory evidence before closure
    INSERT INTO grievance.complaints (complaint_id, citizen_wa_hash, category_key, department_id, description, lat, lon)
        VALUES ('SCB-TEST-000001', 'wa1', 'water_supply', (SELECT department_id FROM grievance.departments WHERE dept_key = 'phed'), 'leak', 25.69, 85.17);

    failed := false;
    BEGIN
        UPDATE grievance.complaints SET status = 'closed' WHERE complaint_id = 'SCB-TEST-000001';
    EXCEPTION WHEN OTHERS THEN failed := true;
    END;
    ASSERT failed, 'closing without a remark+photo is rejected';

    INSERT INTO grievance.complaint_status_history (complaint_id, from_status, to_status, changed_by_user_id, remark)
        VALUES ('SCB-TEST-000001', 'open', 'closed', officer_id, 'fixed the leak');
    failed := false;
    BEGIN
        UPDATE grievance.complaints SET status = 'closed' WHERE complaint_id = 'SCB-TEST-000001';
    EXCEPTION WHEN OTHERS THEN failed := true;
    END;
    ASSERT failed, 'a remark alone, with no photo evidence, is still rejected';

    -- the citizen's intake photo proves the problem, not the fix
    INSERT INTO grievance.complaint_evidence (complaint_id, uploaded_by, wa_hash, file_path, mime_type, kind)
        VALUES ('SCB-TEST-000001', 'citizen', 'wa1', 'wa1/leak.jpg', 'image/jpeg', 'photo');
    failed := false;
    BEGIN
        UPDATE grievance.complaints SET status = 'closed' WHERE complaint_id = 'SCB-TEST-000001';
    EXCEPTION WHEN OTHERS THEN failed := true;
    END;
    ASSERT failed, 'remark + only the citizen''s photo is still rejected: an officer photo is required';

    INSERT INTO grievance.complaint_evidence (complaint_id, uploaded_by, uploaded_by_user_id, file_path, mime_type, kind)
        VALUES ('SCB-TEST-000001', 'officer', officer_id, 'SCB-TEST-000001/fix.jpg', 'image/jpeg', 'photo');
    UPDATE grievance.complaints SET status = 'closed', closed_at = now() WHERE complaint_id = 'SCB-TEST-000001';
    ASSERT (SELECT status FROM grievance.complaints WHERE complaint_id = 'SCB-TEST-000001') = 'closed',
        'remark + photo together allow closure';

    -- a non-closing transition (e.g. open -> assigned) never needs evidence
    INSERT INTO grievance.complaints (complaint_id, citizen_wa_hash, category_key, department_id, description, lat, lon)
        VALUES ('SCB-TEST-000002', 'wa2', 'water_supply', (SELECT department_id FROM grievance.departments WHERE dept_key = 'phed'), 'leak2', 25.69, 85.17);
    UPDATE grievance.complaints SET status = 'assigned', assigned_officer_user_id = officer_id WHERE complaint_id = 'SCB-TEST-000002';
    ASSERT (SELECT status FROM grievance.complaints WHERE complaint_id = 'SCB-TEST-000002') = 'assigned',
        'assigning (not closing) a complaint needs no evidence';

    -- notification outbox
    INSERT INTO grievance.notification_outbox (complaint_id, wa_hash, template_key, payload)
        VALUES ('SCB-TEST-000001', 'wa1', 'status_update', '{"status":"closed"}');
    ASSERT (SELECT status FROM grievance.notification_outbox WHERE complaint_id = 'SCB-TEST-000001') = 'pending',
        'a new notification starts pending';

    RAISE NOTICE 'grievance_test: all assertions passed';
END $$;
ROLLBACK;
