-- Citizen status notifications (M8): portal status change -> outbox row ->
-- core-11-notify-poll (n8n, every minute) -> WhatsApp. Idempotent; runs after
-- 30_grievance.sql, 31_svc_complaint.sql and 32_portal.sql.
--
-- Why an outbox and not a direct call: the portal is a separate process with
-- no route into n8n's internal send workflow, and must never hold the
-- citizen's phone number (portal_rw has no access to core at all). It only
-- writes a row that names the complaint; n8n, which already holds the
-- decryption key, resolves the number when it sends.

ALTER TABLE grievance.notification_outbox ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE grievance.notification_outbox ADD COLUMN IF NOT EXISTS claimed_at timestamptz;
ALTER TABLE grievance.notification_outbox ADD COLUMN IF NOT EXISTS out_id text;  -- WhatsApp message id (wamid) once accepted

-- One notification per complaint per status: a complaint moved to another
-- department and assigned again, or re-assigned to a second officer, does not
-- tell the citizen "an officer has been assigned" twice.
CREATE UNIQUE INDEX IF NOT EXISTS notification_outbox_once_idx ON grievance.notification_outbox (complaint_id, template_key);
CREATE INDEX IF NOT EXISTS notification_outbox_due_idx ON grievance.notification_outbox (next_attempt_at) WHERE status = 'pending';

-- Written by a trigger on the history table, not by each portal route: every
-- status change already records a history row in the same transaction, so
-- the notification commits (or rolls back) with the change itself, whichever
-- code path made it. Only these statuses reach the citizen; 'open' (filed,
-- or moved back after a department transfer) is internal.
CREATE OR REPLACE FUNCTION grievance.queue_status_notification() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.to_status NOT IN ('assigned', 'in_progress', 'resolved', 'closed')
       OR NEW.to_status IS NOT DISTINCT FROM NEW.from_status THEN
        RETURN NEW;
    END IF;
    INSERT INTO grievance.notification_outbox (complaint_id, wa_hash, template_key, payload)
    SELECT c.complaint_id, c.citizen_wa_hash, 'status_' || NEW.to_status,
           jsonb_strip_nulls(jsonb_build_object(
               'complaint_id', c.complaint_id,
               'status', NEW.to_status,
               -- only the closing officer's note goes to the citizen; assignment
               -- remarks name staff and are internal
               'remark', CASE WHEN NEW.to_status IN ('resolved', 'closed') THEN NEW.remark END))
    FROM grievance.complaints c
    WHERE c.complaint_id = NEW.complaint_id
    ON CONFLICT (complaint_id, template_key) DO NOTHING;
    RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS complaint_status_notify ON grievance.complaint_status_history;
CREATE TRIGGER complaint_status_notify AFTER INSERT ON grievance.complaint_status_history
    FOR EACH ROW EXECUTE FUNCTION grievance.queue_status_notification();

-- Claim up to p_limit due notifications for one poll (FOR UPDATE SKIP LOCKED,
-- so two polls running at once never take the same row), with each citizen's
-- number decrypted and their current language. A row stuck in 'sending' for
-- 10 minutes (n8n died mid-batch) is claimed again: delivery is at least
-- once, so a crash can repeat a message but never lose one.
CREATE OR REPLACE FUNCTION svc_complaint.claim_notifications(p_limit int, p_enc_key text) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE r jsonb;
BEGIN
    WITH picked AS (
        SELECT o.id FROM grievance.notification_outbox o
        WHERE (o.status = 'pending' AND o.next_attempt_at <= now())
           OR (o.status = 'sending' AND o.claimed_at < now() - interval '10 minutes')
        ORDER BY o.id
        LIMIT greatest(1, least(coalesce(p_limit, 50), 200))
        FOR UPDATE SKIP LOCKED
    ), claimed AS (
        UPDATE grievance.notification_outbox o
        SET status = 'sending', attempts = o.attempts + 1, claimed_at = now()
        FROM picked WHERE o.id = picked.id
        RETURNING o.id, o.complaint_id, o.wa_hash, o.template_key, o.payload, o.attempts
    )
    SELECT coalesce(jsonb_agg(jsonb_build_object(
               'id', c.id, 'complaint_id', c.complaint_id, 'wa_hash', c.wa_hash,
               'template_key', c.template_key, 'payload', c.payload, 'attempts', c.attempts,
               -- stored as core.norm_phone() (Indian numbers without the 91);
               -- the Cloud API needs the country code back
               'to', CASE WHEN z.wa_number_enc IS NULL THEN NULL
                          ELSE (SELECT CASE WHEN d ~ '^[6-9][0-9]{9}$' THEN '91' || d ELSE d END
                                FROM (SELECT pgp_sym_decrypt(z.wa_number_enc, p_enc_key) AS d) s) END,
               'lang', coalesce(z.lang, g.lang, 'hi')) ORDER BY c.id), '[]'::jsonb)
    INTO r
    FROM claimed c
    LEFT JOIN core.citizens z ON z.wa_hash = c.wa_hash
    LEFT JOIN grievance.complaints g ON g.complaint_id = c.complaint_id;
    RETURN r;
END $$;

-- Record one poll's outcome: [{id, ok, error?, out_id?, final?}]. A failure is
-- retried with backoff (2, 4, 8, 16 minutes) and marked 'failed' on the 5th
-- attempt, or at once when final (nothing to retry, e.g. no number on record).
-- Returns the counts plus the rows that just failed for good (for the admin alert).
-- Error text is shown in the portal, which must never see a citizen's number:
-- any long digit run in it (Meta's message could echo the recipient) is masked.
-- Meta's own error codes (6 digits, e.g. 131026) are short enough to survive.
CREATE OR REPLACE FUNCTION svc_complaint.mask_numbers(p text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
    SELECT regexp_replace(coalesce(p, ''), '\+?[0-9][0-9 -]{6,}[0-9]', '[number]', 'g')
$$;

CREATE OR REPLACE FUNCTION svc_complaint.finish_notifications(p jsonb) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
    e         jsonb;
    v_err     text;
    v_status  text;
    v_cid     text;
    n_sent    int := 0;
    n_retry   int := 0;
    v_failed  jsonb := '[]'::jsonb;
BEGIN
    FOR e IN SELECT * FROM jsonb_array_elements(coalesce(p, '[]'::jsonb)) LOOP
        IF coalesce((e->>'ok')::boolean, false) THEN
            UPDATE grievance.notification_outbox
            SET status = 'sent', sent_at = now(), last_error = NULL, out_id = e->>'out_id'
            WHERE id = (e->>'id')::bigint AND status = 'sending';
            IF FOUND THEN n_sent := n_sent + 1; END IF;
        ELSE
            v_err := left(svc_complaint.mask_numbers(coalesce(e->>'error', 'unknown error')), 500);
            UPDATE grievance.notification_outbox
            SET status = CASE WHEN attempts >= 5 OR coalesce((e->>'final')::boolean, false) THEN 'failed' ELSE 'pending' END,
                next_attempt_at = now() + make_interval(mins => power(2, least(attempts, 6))::int),
                last_error = v_err
            WHERE id = (e->>'id')::bigint AND status = 'sending'
            RETURNING status, complaint_id INTO v_status, v_cid;
            IF v_status = 'failed' THEN
                v_failed := v_failed || jsonb_build_object('complaint_id', v_cid, 'error', left(v_err, 200));
            ELSIF v_status = 'pending' THEN
                n_retry := n_retry + 1;
            END IF;
            v_status := NULL;
        END IF;
    END LOOP;
    RETURN jsonb_build_object('sent', n_sent, 'retrying', n_retry, 'failed', v_failed);
END $$;

-- claim_notifications decrypts citizens' numbers: n8n's own user only
-- (same as core.run_purge), never the portal or Metabase.
REVOKE EXECUTE ON FUNCTION svc_complaint.claim_notifications(int, text), svc_complaint.finish_notifications(jsonb) FROM PUBLIC;

-- The portal (via grievance_app) reads delivery status for the complaint page;
-- new objects above need the same grants as the rest of the schema.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA grievance TO grievance_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA grievance TO grievance_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA grievance TO grievance_app;
