-- Migration: 20260531000000_note_templates_starter_seed.sql
-- Purpose: Ship a starter library of psychotherapy note templates so a brand
--          new organization isn't dropped into a blank note picker on day one.
--          Covers Intake / 90791 (org default), Individual psychotherapy /
--          90834 and 90837, Family / 90847, and Group / 90853.
--
-- Behaviour:
--   - Adds a SQL function seed_default_note_templates(org_id uuid) that inserts
--     the starter set. It is idempotent: it only inserts templates whose
--     (organization_id, name) pair doesn't already exist, so re-running on an
--     org that already has some / all of them won't duplicate. The Intake
--     template is only marked is_default when the org currently has no
--     default template (respects any default a clinician already picked).
--   - Installs an AFTER INSERT trigger on public.organizations so every newly
--     created org automatically gets the starter set.
--   - Backfills any existing organization that currently has zero active
--     note templates.
--
-- Schema note: this migration runs after 20260530010000_clinical_notes_soap_alignment.sql,
-- which renamed default_interventions -> default_objective and added
-- default_assessment, so we seed all four SOAP sections directly.

create or replace function public.seed_default_note_templates(org_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  has_default boolean;
begin
  if org_id is null then
    return;
  end if;

  select exists (
    select 1 from public.note_templates
    where organization_id = org_id
      and archived_at is null
      and is_default = true
  ) into has_default;

  -- Intake / Diagnostic evaluation (90791). Marked as the org default only if
  -- nothing else is already flagged default for this org.
  insert into public.note_templates (
    organization_id, name, service_type, cpt_code,
    default_subjective, default_objective, default_assessment, default_plan, is_default
  )
  select
    org_id,
    'Intake / Diagnostic Evaluation',
    'Intake',
    '90791',
    E'Chief complaint / reason for referral:\n\nHistory of presenting problem (onset, course, severity, triggers):\n\nRelevant psychiatric, medical, family, social, and developmental history:\n\nCurrent medications and substance use:\n',
    E'Mental status exam (appearance, behavior, mood/affect, thought process, cognition, insight/judgment):\n\nRisk screen (SI/HI/self-harm): denies\n\nClinical interview and biopsychosocial assessment completed. Reviewed presenting concerns and gathered history.\n',
    E'Diagnosis / impression:\n\nClinical formulation (predisposing, precipitating, perpetuating, protective factors):\n\nMedical necessity for proposed treatment:\n',
    E'Recommended treatment modality and frequency:\n\nInitial goals:\n\nReferrals / collateral contacts:\n\nNext appointment:\n',
    not has_default
  where not exists (
    select 1 from public.note_templates t
    where t.organization_id = org_id and t.name = 'Intake / Diagnostic Evaluation'
  );

  -- Individual psychotherapy, 45 minutes (90834).
  insert into public.note_templates (
    organization_id, name, service_type, cpt_code,
    default_subjective, default_objective, default_assessment, default_plan, is_default
  )
  select
    org_id,
    'Individual Psychotherapy - 45 min',
    'Individual',
    '90834',
    E'Client report since last session (mood, sleep, appetite, stressors, wins):\n\nProgress on between-session work / homework:\n\nCurrent symptoms and severity:\n\nRisk assessment (SI/HI/self-harm): denies\n',
    E'Therapeutic modality: \n\nInterventions used this session (e.g., cognitive restructuring, behavioral activation, exposure, mindfulness, motivational interviewing):\n\nClient response to interventions (engagement, affect, skills practiced in-session):\n',
    E'Progress toward treatment goals:\n\nDiagnosis / clinical impression today:\n\nMedical necessity for continued treatment:\n',
    E'Treatment goals addressed:\n\nBetween-session work / homework assigned:\n\nNext session focus:\n\nNext appointment:\n',
    false
  where not exists (
    select 1 from public.note_templates t
    where t.organization_id = org_id and t.name = 'Individual Psychotherapy - 45 min'
  );

  -- Individual psychotherapy, 60 minutes (90837).
  insert into public.note_templates (
    organization_id, name, service_type, cpt_code,
    default_subjective, default_objective, default_assessment, default_plan, is_default
  )
  select
    org_id,
    'Individual Psychotherapy - 60 min',
    'Individual',
    '90837',
    E'Client report since last session (mood, sleep, appetite, stressors, wins):\n\nProgress on between-session work / homework:\n\nCurrent symptoms and severity (justification for extended session):\n\nRisk assessment (SI/HI/self-harm): denies\n',
    E'Therapeutic modality: \n\nInterventions used this session (e.g., trauma processing, prolonged exposure, EMDR, in-depth cognitive restructuring):\n\nClient response to interventions (engagement, affect, in-session skills practice):\n',
    E'Progress toward treatment goals:\n\nDiagnosis / clinical impression today:\n\nMedical necessity for 60-minute session:\n',
    E'Treatment goals addressed:\n\nBetween-session work / homework assigned:\n\nNext session focus:\n\nNext appointment:\n',
    false
  where not exists (
    select 1 from public.note_templates t
    where t.organization_id = org_id and t.name = 'Individual Psychotherapy - 60 min'
  );

  -- Family psychotherapy with patient present (90847).
  insert into public.note_templates (
    organization_id, name, service_type, cpt_code,
    default_subjective, default_objective, default_assessment, default_plan, is_default
  )
  select
    org_id,
    'Family Psychotherapy (with patient)',
    'Family',
    '90847',
    E'Family members present:\n\nIdentified patient and family report since last session:\n\nCurrent family stressors, conflicts, and dynamics observed:\n\nProgress on prior between-session work:\n\nRisk assessment (SI/HI/safety concerns): denies\n',
    E'Therapeutic modality (e.g., structural family therapy, emotionally focused therapy, Bowenian):\n\nInterventions (e.g., communication coaching, boundary setting, reframing, enactments):\n\nFamily response to interventions:\n',
    E'Progress toward family treatment goals:\n\nClinical impression of family functioning today:\n\nMedical necessity for continued family work:\n',
    E'Treatment goals addressed:\n\nBetween-session assignments for family:\n\nNext session focus / who will attend:\n\nNext appointment:\n',
    false
  where not exists (
    select 1 from public.note_templates t
    where t.organization_id = org_id and t.name = 'Family Psychotherapy (with patient)'
  );

  -- Group psychotherapy (90853).
  insert into public.note_templates (
    organization_id, name, service_type, cpt_code,
    default_subjective, default_objective, default_assessment, default_plan, is_default
  )
  select
    org_id,
    'Group Psychotherapy',
    'Group',
    '90853',
    E'Group topic / theme:\n\nClient''s participation level and presentation in group:\n\nIssues raised by client this session:\n\nClient''s interactions with other group members:\n\nRisk assessment (SI/HI/self-harm): denies\n',
    E'Group modality and structure (e.g., CBT skills group, process group, DBT skills):\n\nFacilitator interventions directed at this client:\n\nClient response and skills practiced:\n',
    E'Progress toward this client''s treatment goals in the group context:\n\nClinical impression today:\n\nMedical necessity for continued group participation:\n',
    E'Treatment goals addressed:\n\nBetween-session skill practice assigned:\n\nNext group focus:\n\nNext appointment:\n',
    false
  where not exists (
    select 1 from public.note_templates t
    where t.organization_id = org_id and t.name = 'Group Psychotherapy'
  );
end;
$$;

-- Trigger to auto-seed every newly created organization.
create or replace function public.seed_default_note_templates_trigger()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.seed_default_note_templates(NEW.id);
  return NEW;
exception when others then
  -- Never block organization creation if seeding fails for some reason
  -- (e.g. note_templates table not yet present in a partial environment).
  raise warning 'seed_default_note_templates failed for organization %: %', NEW.id, sqlerrm;
  return NEW;
end;
$$;

drop trigger if exists trg_seed_default_note_templates on public.organizations;
create trigger trg_seed_default_note_templates
  after insert on public.organizations
  for each row execute function public.seed_default_note_templates_trigger();

-- Backfill: any existing org with zero active note templates gets the starter set.
do $$
declare
  org record;
begin
  for org in
    select o.id
    from public.organizations o
    where not exists (
      select 1 from public.note_templates t
      where t.organization_id = o.id and t.archived_at is null
    )
  loop
    perform public.seed_default_note_templates(org.id);
  end loop;
end $$;

select pg_notify('pgrst', 'reload schema');
