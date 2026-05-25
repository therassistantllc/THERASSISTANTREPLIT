alter table public.patient_check_ins
  add column if not exists focus_option text,
  add column if not exists focus_reflection text;

alter table public.patient_check_ins
  drop constraint if exists patient_check_ins_focus_option_check;

alter table public.patient_check_ins
  add constraint patient_check_ins_focus_option_check
  check (
    focus_option is null
    or focus_option in (
      'continue_goals',
      'new_concern',
      'symptoms_changed',
      'update_goals',
      'not_sure'
    )
  );

select pg_notify('pgrst', 'reload schema');
