-- Portal SQL tests (rolled back). psql -v ON_ERROR_STOP=1 -f tests/sql/portal_test.sql
BEGIN;
DO $$
DECLARE admin_id bigint; head_id bigint; officer_id bigint; elec_officer_id bigint;
        phed int; elec int; failed boolean;
BEGIN
    SELECT department_id INTO phed FROM grievance.departments WHERE dept_key = 'phed';
    SELECT department_id INTO elec FROM grievance.departments WHERE dept_key = 'electricity';

    INSERT INTO grievance.portal_users (username, password_hash, full_name, role)
        VALUES ('t_admin', 'x', 'Admin', 'district_admin') RETURNING user_id INTO admin_id;
    INSERT INTO grievance.portal_users (username, password_hash, full_name, role, department_id)
        VALUES ('t_head', 'x', 'Water Head', 'dept_head', phed) RETURNING user_id INTO head_id;
    INSERT INTO grievance.portal_users (username, password_hash, full_name, role, department_id)
        VALUES ('t_officer', 'x', 'Water Officer', 'field_officer', phed) RETURNING user_id INTO officer_id;
    INSERT INTO grievance.portal_users (username, password_hash, full_name, role, department_id)
        VALUES ('t_elec_officer', 'x', 'Power Officer', 'field_officer', elec) RETURNING user_id INTO elec_officer_id;

    INSERT INTO grievance.complaints (complaint_id, citizen_wa_hash, category_key, department_id, description, lat, lon)
    VALUES ('SCB-T-W1', 'h1', 'water_supply', phed, 'leak', 25.69, 85.17),
           ('SCB-T-W2', 'h2', 'water_supply', phed, 'no water', 25.69, 85.17),
           ('SCB-T-E1', 'h3', 'electricity', elec, 'no power', 25.69, 85.17);
    UPDATE grievance.complaints SET assigned_officer_user_id = officer_id, status = 'assigned' WHERE complaint_id = 'SCB-T-W1';

    -- visibility per role
    ASSERT (SELECT count(*) FROM grievance.complaints_visible_to(admin_id) WHERE complaint_id LIKE 'SCB-T-%') = 3, 'admin sees all';
    ASSERT (SELECT array_agg(complaint_id ORDER BY complaint_id) FROM grievance.complaints_visible_to(head_id) WHERE complaint_id LIKE 'SCB-T-%')
         = ARRAY['SCB-T-W1', 'SCB-T-W2'], 'dept head sees only their department';
    ASSERT (SELECT array_agg(complaint_id) FROM grievance.complaints_visible_to(officer_id) WHERE complaint_id LIKE 'SCB-T-%')
         = ARRAY['SCB-T-W1'], 'field officer sees only what is assigned to them';
    ASSERT (SELECT count(*) FROM grievance.complaints_visible_to(elec_officer_id) WHERE complaint_id LIKE 'SCB-T-%') = 0,
        'an unassigned officer sees nothing';
    ASSERT (SELECT count(*) FROM grievance.complaints_visible_to(-1)) = 0, 'unknown user sees nothing';

    UPDATE grievance.portal_users SET enabled = false WHERE user_id = head_id;
    ASSERT (SELECT count(*) FROM grievance.complaints_visible_to(head_id)) = 0, 'a disabled user sees nothing';
    UPDATE grievance.portal_users SET enabled = true WHERE user_id = head_id;

    -- assignee must be an enabled field officer of the complaint's own department
    failed := false;
    BEGIN
        UPDATE grievance.complaints SET assigned_officer_user_id = elec_officer_id WHERE complaint_id = 'SCB-T-W2';
    EXCEPTION WHEN OTHERS THEN failed := true;
    END;
    ASSERT failed, 'cannot assign a water complaint to an electricity officer';

    failed := false;
    BEGIN
        UPDATE grievance.complaints SET assigned_officer_user_id = head_id WHERE complaint_id = 'SCB-T-W2';
    EXCEPTION WHEN OTHERS THEN failed := true;
    END;
    ASSERT failed, 'cannot assign to a dept head (field officers only)';

    -- disabling an officer later never blocks unrelated updates to what they hold
    UPDATE grievance.portal_users SET enabled = false WHERE user_id = officer_id;
    UPDATE grievance.complaints SET status = 'in_progress' WHERE complaint_id = 'SCB-T-W1';
    ASSERT (SELECT status FROM grievance.complaints WHERE complaint_id = 'SCB-T-W1') = 'in_progress',
        'status still changeable after the assignee is disabled';

    ASSERT (SELECT must_change_password FROM grievance.portal_users WHERE user_id = admin_id) = false, 'column exists, defaults false';
    INSERT INTO grievance.portal_audit (user_id, action, target) VALUES (admin_id, 'test', 'x');

    RAISE NOTICE 'portal_test: all assertions passed';
END $$;
ROLLBACK;
