-- Re-run metadata derivation after formal_gate_v2 becomes the active trigger.
-- UPDATE is intentionally allowed so legacy rows are demoted rather than rejected.

update public.chat_reports
set answer_json = answer_json;
