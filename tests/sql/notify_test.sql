-- Status-notification outbox tests (sql/33_notify.sql), rolled back.
-- psql -v ON_ERROR_STOP=1 -f tests/sql/notify_test.sql
BEGIN;

-- fixtures; anything already pending in this DB is parked so counts are exact
UPDATE grievance.notification_outbox SET status = 'sent' WHERE status IN ('pending', 'sending');
INSERT INTO core.citizens (wa_hash, wa_number_enc, lang)
VALUES ('t_notify_h1', pgp_sym_encrypt('9876543210', 'test-key'), 'en'),
       ('t_notify_h2', pgp_sym_encrypt('447700900123', 'test-key'), 'hi');
INSERT INTO grievance.portal_users (username, password_hash, full_name, role, department_id)
SELECT 't_notify_officer', 'x', 'Officer Name', 'field_officer', department_id
FROM grievance.departments WHERE dept_key = 'phed';
INSERT INTO grievance.complaints (complaint_id, citizen_wa_hash, category_key, department_id, description, lat, lon)
SELECT id, h, 'water_supply', (SELECT department_id FROM grievance.departments WHERE dept_key = 'phed'), 'leak', 25.69, 85.17
FROM (VALUES ('SCB-T-N1', 't_notify_h1'), ('SCB-T-N2', 't_notify_h2'), ('SCB-T-N3', 't_notify_gone')) v(id, h);

-- The trigger runs with the PORTAL's privileges (grievance_app), exactly as a
-- portal request would.
SET LOCAL ROLE grievance_app;
DO $$
DECLARE officer bigint; failed boolean;
BEGIN
    SELECT user_id INTO officer FROM grievance.portal_users WHERE username = 't_notify_officer';

    -- filing ('open') is confirmed in the chat itself: no outbox row
    INSERT INTO grievance.complaint_status_history (complaint_id, from_status, to_status, remark)
    VALUES ('SCB-T-N1', NULL, 'open', 'registered via WhatsApp');
    ASSERT (SELECT count(*) FROM grievance.notification_outbox WHERE complaint_id = 'SCB-T-N1') = 0, 'open is not notified';

    -- assign -> one row, with no staff name in it
    UPDATE grievance.complaints SET assigned_officer_user_id = officer, status = 'assigned' WHERE complaint_id = 'SCB-T-N1';
    INSERT INTO grievance.complaint_status_history (complaint_id, from_status, to_status, changed_by_user_id, remark)
    VALUES ('SCB-T-N1', 'open', 'assigned', officer, 'Assigned to Officer Name');
    ASSERT (SELECT count(*) FROM grievance.notification_outbox WHERE complaint_id = 'SCB-T-N1') = 1, 'assignment queued';
    ASSERT (SELECT payload FROM grievance.notification_outbox WHERE complaint_id = 'SCB-T-N1')
         = '{"complaint_id": "SCB-T-N1", "status": "assigned"}'::jsonb, 'assignment remark (names staff) stays internal';
    ASSERT (SELECT wa_hash || template_key || status FROM grievance.notification_outbox WHERE complaint_id = 'SCB-T-N1')
         = 't_notify_h1status_assignedpending', 'addressed by hash, pending';

    -- re-assign, transfer back to open, assign again: still just the one row
    INSERT INTO grievance.complaint_status_history (complaint_id, from_status, to_status, changed_by_user_id, remark)
    VALUES ('SCB-T-N1', 'assigned', 'assigned', officer, 'Assigned to someone else'),
           ('SCB-T-N1', 'assigned', 'open', officer, 'Moved to another department'),
           ('SCB-T-N1', 'open', 'assigned', officer, 'Assigned again');
    ASSERT (SELECT count(*) FROM grievance.notification_outbox WHERE complaint_id = 'SCB-T-N1') = 1,
        'the citizen hears "assigned" once, however often staff re-assign';

    UPDATE grievance.complaints SET status = 'in_progress' WHERE complaint_id = 'SCB-T-N1';
    INSERT INTO grievance.complaint_status_history (complaint_id, from_status, to_status, changed_by_user_id)
    VALUES ('SCB-T-N1', 'assigned', 'in_progress', officer);

    -- a close that the evidence trigger refuses leaves no notification behind
    failed := false;
    BEGIN
        INSERT INTO grievance.complaint_status_history (complaint_id, from_status, to_status, changed_by_user_id, remark)
        VALUES ('SCB-T-N1', 'in_progress', 'closed', officer, 'done');
        UPDATE grievance.complaints SET status = 'closed', closed_at = now() WHERE complaint_id = 'SCB-T-N1';
    EXCEPTION WHEN OTHERS THEN failed := true;
    END;
    ASSERT failed, 'closing without officer proof is refused';
    ASSERT NOT EXISTS (SELECT 1 FROM grievance.notification_outbox WHERE complaint_id = 'SCB-T-N1' AND template_key = 'status_closed'),
        'a rolled-back close must not tell the citizen it was closed';

    -- a real close carries the officer's note
    INSERT INTO grievance.complaint_status_history (complaint_id, from_status, to_status, changed_by_user_id, remark)
    VALUES ('SCB-T-N1', 'in_progress', 'closed', officer, 'Pipe joint replaced');
    INSERT INTO grievance.complaint_evidence (complaint_id, uploaded_by, uploaded_by_user_id, file_path, mime_type, kind, sha256)
    VALUES ('SCB-T-N1', 'officer', officer, 'officer/SCB-T-N1/a.jpg', 'image/jpeg', 'photo', repeat('a', 64));
    UPDATE grievance.complaints SET status = 'closed', closed_at = now() WHERE complaint_id = 'SCB-T-N1';
    ASSERT (SELECT payload->>'remark' FROM grievance.notification_outbox WHERE complaint_id = 'SCB-T-N1' AND template_key = 'status_closed')
         = 'Pipe joint replaced', 'closing note queued';

    UPDATE grievance.complaints SET assigned_officer_user_id = officer, status = 'assigned' WHERE complaint_id IN ('SCB-T-N2', 'SCB-T-N3');
    INSERT INTO grievance.complaint_status_history (complaint_id, from_status, to_status, changed_by_user_id)
    VALUES ('SCB-T-N2', 'open', 'assigned', officer), ('SCB-T-N3', 'open', 'assigned', officer);

    -- the portal can read delivery status but can never claim (decrypt numbers)
    ASSERT (SELECT count(*) FROM grievance.notification_outbox WHERE complaint_id LIKE 'SCB-T-N%') = 5, 'portal reads outbox';
    failed := false;
    BEGIN
        PERFORM svc_complaint.claim_notifications(10, 'test-key');
    EXCEPTION WHEN insufficient_privilege THEN failed := true;
    END;
    ASSERT failed, 'portal role must not be able to claim notifications (they carry decrypted numbers)';
END $$;
RESET ROLE;

DO $$
DECLARE b jsonb; r jsonb; n1 jsonb; n2 jsonb; n3 jsonb; id1 bigint; id2 bigint; id3 bigint;
BEGIN
    b := svc_complaint.claim_notifications(200, 'test-key');
    ASSERT jsonb_array_length(b) = 5, 'all five due rows claimed: ' || b::text;
    ASSERT (SELECT array_agg(e->>'template_key' ORDER BY (e->>'id')::bigint) FROM jsonb_array_elements(b) e
            WHERE e->>'complaint_id' = 'SCB-T-N1') = ARRAY['status_assigned', 'status_in_progress', 'status_closed'],
        'oldest first, so the citizen gets them in order';
    SELECT e INTO n1 FROM jsonb_array_elements(b) e WHERE e->>'complaint_id' = 'SCB-T-N1' AND e->>'template_key' = 'status_assigned';
    SELECT e INTO n2 FROM jsonb_array_elements(b) e WHERE e->>'complaint_id' = 'SCB-T-N2';
    SELECT e INTO n3 FROM jsonb_array_elements(b) e WHERE e->>'complaint_id' = 'SCB-T-N3';
    ASSERT n1->>'to' = '919876543210', 'Indian number gets its 91 back: ' || (n1->>'to');
    ASSERT n1->>'lang' = 'en' AND n2->>'lang' = 'hi', 'citizen''s own language';
    ASSERT n2->>'to' = '447700900123', 'a foreign number is left as stored';
    ASSERT n3->'to' = 'null'::jsonb, 'a purged citizen has no number';
    ASSERT (SELECT bool_and(status = 'sending' AND attempts = 1 AND claimed_at IS NOT NULL)
            FROM grievance.notification_outbox WHERE complaint_id LIKE 'SCB-T-N%'), 'claimed rows are marked sending';
    ASSERT jsonb_array_length(svc_complaint.claim_notifications(200, 'test-key')) = 0, 'a claimed row is not handed out twice';

    id1 := (n1->>'id')::bigint; id2 := (n2->>'id')::bigint; id3 := (n3->>'id')::bigint;
    r := svc_complaint.finish_notifications(jsonb_build_array(
        jsonb_build_object('id', id1, 'ok', true, 'out_id', 'wamid.X1'),
        jsonb_build_object('id', id2, 'ok', false, 'error', 'HTTP 400: undeliverable to +91 98765-43210 (code 131026)'),
        jsonb_build_object('id', id3, 'ok', false, 'final', true, 'error', 'no WhatsApp number on record')));
    ASSERT (r->>'sent')::int = 1 AND (r->>'retrying')::int = 1, r::text;
    ASSERT jsonb_array_length(r->'failed') = 1 AND r->'failed'->0->>'complaint_id' = 'SCB-T-N3', 'final failure reported once: ' || r::text;
    ASSERT (SELECT status || '|' || out_id FROM grievance.notification_outbox WHERE id = id1) = 'sent|wamid.X1', 'sent with wamid';
    ASSERT (SELECT status = 'pending' AND last_error LIKE 'HTTP 400%'
                   AND next_attempt_at BETWEEN now() + interval '1 minute 50 seconds' AND now() + interval '2 minutes 10 seconds'
            FROM grievance.notification_outbox WHERE id = id2), 'first failure retried in 2 minutes';
    ASSERT (SELECT last_error FROM grievance.notification_outbox WHERE id = id2) = 'HTTP 400: undeliverable to [number] (code 131026)',
        'a number in Meta''s error text never reaches the portal, the error code does: '
        || (SELECT last_error FROM grievance.notification_outbox WHERE id = id2);
    ASSERT (SELECT status FROM grievance.notification_outbox WHERE id = id3) = 'failed', 'nothing to retry: failed at once';
    ASSERT jsonb_array_length(svc_complaint.claim_notifications(200, 'test-key')) = 0, 'a retry is not due before its time';

    -- the 5th failed attempt is the last
    UPDATE grievance.notification_outbox SET next_attempt_at = now(), attempts = 4 WHERE id = id2;
    b := svc_complaint.claim_notifications(200, 'test-key');
    ASSERT jsonb_array_length(b) = 1 AND (b->0->>'attempts')::int = 5, b::text;
    r := svc_complaint.finish_notifications(jsonb_build_array(jsonb_build_object('id', id2, 'ok', false, 'error', 'still failing')));
    ASSERT (SELECT status FROM grievance.notification_outbox WHERE id = id2) = 'failed', 'given up after 5 attempts';
    ASSERT r->'failed'->0->>'complaint_id' = 'SCB-T-N2', r::text;

    -- a result for a row that is no longer 'sending' changes nothing
    r := svc_complaint.finish_notifications(jsonb_build_array(jsonb_build_object('id', id1, 'ok', false, 'error', 'late')));
    ASSERT (SELECT status FROM grievance.notification_outbox WHERE id = id1) = 'sent', 'a sent row stays sent';

    -- a row left 'sending' by a crashed poll is picked up again after 10 minutes
    UPDATE grievance.notification_outbox SET claimed_at = now() - interval '11 minutes'
    WHERE complaint_id = 'SCB-T-N1' AND template_key = 'status_in_progress';
    b := svc_complaint.claim_notifications(200, 'test-key');
    ASSERT jsonb_array_length(b) = 1 AND b->0->>'template_key' = 'status_in_progress', 'stale claim recovered: ' || b::text;
END $$;

ROLLBACK;
