-- Additive guards for the existing task table. Installed via a checked-in migration.
-- Message completion requires an accepted, verified delivered execution and exact approval.
CREATE OR REPLACE FUNCTION egc_task_revision_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE content_changed boolean; actor text; system_actor text;
BEGIN
  actor := nullif(current_setting('egc.operations_actor',true),'');
  system_actor := nullif(current_setting('egc.operations_system',true),'');
  IF TG_OP='INSERT' THEN
    NEW.revision := 1;
  ELSE
    IF OLD.source='operations' AND actor IS NULL AND system_actor IS NULL THEN
      RAISE EXCEPTION 'managed_action_requires_operations_service' USING ERRCODE='23514';
    END IF;
    IF NEW.workspace_id IS DISTINCT FROM OLD.workspace_id THEN
      RAISE EXCEPTION 'task_workspace_is_immutable' USING ERRCODE='23514';
    END IF;
    content_changed := (to_jsonb(NEW)-ARRAY['revision','updated_at','approval_status']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['revision','updated_at','approval_status']);
    NEW.revision := OLD.revision + CASE WHEN content_changed THEN 1 ELSE 0 END;
    NEW.updated_at := clock_timestamp();
    IF content_changed AND OLD.approval_status='approved' THEN NEW.approval_status := 'invalidated'; END IF;
  END IF;
  IF NEW.source='operations' THEN
    IF NEW.kind NOT IN ('manual','callback','prepare_quote','followup_message','review_notes','verify_deposit','job_readiness') OR
       NEW.status NOT IN ('open','in_progress','blocked','completed','cancelled','superseded') OR
       NEW.waiting_on NOT IN ('none','EGC','customer','provider') OR
       NEW.approval_status NOT IN ('not_required','pending','approved','rejected','expired','invalidated') OR
       nullif(btrim(NEW.assigned_user_id),'') IS NULL OR NEW.due_at IS NULL OR
       nullif(btrim(NEW.completion_condition),'') IS NULL OR
       (NEW.waiting_on IN ('customer','provider') AND NEW.review_at IS NULL) THEN
      RAISE EXCEPTION 'managed_action_invariant_failed' USING ERRCODE='23514';
    END IF;
    IF (NEW.kind='followup_message') IS DISTINCT FROM (NEW.draft_payload IS NOT NULL) THEN
      RAISE EXCEPTION 'managed_action_draft_type_mismatch' USING ERRCODE='23514';
    END IF;
    IF NEW.status='completed' AND NEW.kind='verify_deposit' THEN
      RAISE EXCEPTION 'provider_evidence_completion_not_activated' USING ERRCODE='23514';
    END IF;
    IF NEW.status='completed' AND NEW.kind='followup_message' AND (TG_OP='INSERT' OR OLD.status IS DISTINCT FROM 'completed') THEN
      IF TG_OP='INSERT' OR current_setting('egc.communication_completion',true) IS DISTINCT FROM NEW.id::text OR NEW.completed_at IS NULL OR NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(NEW.completion_evidence) proof
        JOIN communication_executions execution ON execution.id::text=proof->>'executionId'
        JOIN operation_approvals approval ON approval.id::text=proof->>'approvalId' AND approval.task_id=NEW.id AND approval.task_revision=OLD.revision AND approval.workspace_id=NEW.workspace_id
        WHERE proof->>'kind'='verified_communication' AND proof->>'taskId'=NEW.id::text
          AND proof->>'approvedRevision'=OLD.revision::text
          AND execution.contact_id=NEW.contact_id AND execution.status='accepted'
          AND execution.provider_message_id IS NOT NULL AND execution.verified_at IS NOT NULL
          AND execution.response->'delivered'='true'::jsonb
          AND proof->>'providerMessageId'=execution.provider_message_id
          AND execution.response->>'messageId'=execution.provider_message_id
          AND approval.snapshot->'task'->'draftPayload'=NEW.draft_payload
          AND CASE WHEN lower(execution.channel)='sms'
            THEN execution.payload->>'toNumber'=NEW.draft_payload->>'recipient'
            ELSE execution.payload->>'emailTo'=NEW.draft_payload->>'recipient'
              AND coalesce(execution.payload->>'subject','')=coalesce(NEW.draft_payload->>'subject','') END
          AND execution.payload->>'message'=NEW.draft_payload->>'body'
          AND lower(execution.channel)=lower(NEW.draft_payload->>'channel')
          AND approval.created_at <= execution.created_at AND approval.expires_at >= execution.created_at
      ) THEN
        RAISE EXCEPTION 'provider_evidence_completion_not_activated' USING ERRCODE='23514';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;
