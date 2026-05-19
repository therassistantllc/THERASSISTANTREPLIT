-- File: supabase/seed/home_command_center_seed.sql
insert into public.dashboard_widgets (organization_id, role, widget_key, title, sort_order, is_enabled)
values
  ('11111111-1111-1111-1111-111111111111', 'admin_biller', 'today_schedule', 'Today''s Schedule', 1, true),
  ('11111111-1111-1111-1111-111111111111', 'admin_biller', 'revenue_cycle_snapshot', 'Revenue Cycle Snapshot', 2, true),
  ('11111111-1111-1111-1111-111111111111', 'admin_biller', 'claims_attention', 'Claims Needing Attention', 3, true),
  ('11111111-1111-1111-1111-111111111111', 'clinician', 'today_schedule', 'Today''s Schedule', 1, true),
  ('11111111-1111-1111-1111-111111111111', 'clinician', 'documentation_queue', 'Documentation Queue', 2, true),
  ('11111111-1111-1111-1111-111111111111', 'credentialing', 'credentialing_tasks', 'Credentialing Tasks', 1, true),
  ('11111111-1111-1111-1111-111111111111', 'owner_executive', 'revenue_cycle_snapshot', 'Revenue Cycle Snapshot', 1, true)
on conflict do nothing;

insert into public.operational_alerts (
  organization_id,
  patient_id,
  appointment_id,
  alert_type,
  severity,
  title,
  message,
  status
)
values
  ('11111111-1111-1111-1111-111111111111', '5eb894b2-87ab-48cc-acda-61a998fcb931', null, 'missing_note', 'high', 'Completed appointment missing note', 'Sarah Johnson has a completed appointment without documentation.', 'open'),
  ('11111111-1111-1111-1111-111111111111', 'pt-1002', null, 'eligibility_not_checked', 'medium', 'Eligibility not checked', 'Marcus Lee has not had eligibility checked in 30 days.', 'open'),
  ('11111111-1111-1111-1111-111111111111', null, null, 'claim_denied', 'high', 'Denied claim requires follow-up', 'Dana Patel claim clm-1003 denied by payer.', 'open')
on conflict do nothing;
