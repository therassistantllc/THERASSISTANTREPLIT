-- Clinical concept dictionary foundation.
-- Modeled on the OpenMRS Concept service: every coded clinical value lives in
-- a shared dictionary with a stable id, datatype, and mappings to external
-- code systems (LOINC, SNOMED, ICD-10, RxNorm, CPT).
create extension if not exists pgcrypto;

-- ─────────────────────────────────────────────────────────────────────────────
-- Schema
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.concepts (
  id                          uuid primary key default gen_random_uuid(),
  name                        text not null,
  description                 text,
  datatype                    text not null check (datatype in (
    'numeric', 'coded', 'text', 'boolean', 'datetime', 'date', 'document', 'n_a'
  )),
  concept_class               text not null check (concept_class in (
    'Question', 'Finding', 'Diagnosis', 'Procedure', 'Drug',
    'LabTest', 'LabSet', 'MedSet', 'ConvSet', 'Misc'
  )),
  is_set                      boolean not null default false,
  retired                     boolean not null default false,
  created_by_organization_id  uuid references public.organizations(id) on delete set null,
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now()
);

create index if not exists idx_concepts_class on public.concepts (concept_class) where retired = false;
create index if not exists idx_concepts_name on public.concepts (lower(name)) where retired = false;
create index if not exists idx_concepts_org on public.concepts (created_by_organization_id) where created_by_organization_id is not null;

create table if not exists public.concept_names (
  id          uuid primary key default gen_random_uuid(),
  concept_id  uuid not null references public.concepts(id) on delete cascade,
  name        text not null,
  locale      text not null default 'en',
  name_type   text not null default 'synonym' check (name_type in ('full', 'short', 'synonym', 'indexed')),
  created_at  timestamptz not null default now()
);

create index if not exists idx_concept_names_concept on public.concept_names (concept_id);
create unique index if not exists uq_concept_names_concept_locale_name
  on public.concept_names (concept_id, locale, lower(name));

create table if not exists public.concept_mappings (
  id           uuid primary key default gen_random_uuid(),
  concept_id   uuid not null references public.concepts(id) on delete cascade,
  code_system  text not null check (code_system in (
    'SNOMED', 'LOINC', 'ICD10', 'ICD10CM', 'RxNorm', 'CPT', 'HCPCS', 'LOCAL'
  )),
  code         text not null,
  display      text,
  created_at   timestamptz not null default now()
);

create index if not exists idx_concept_mappings_concept on public.concept_mappings (concept_id);
create index if not exists idx_concept_mappings_lookup on public.concept_mappings (code_system, code);
create unique index if not exists uq_concept_mappings
  on public.concept_mappings (concept_id, code_system, code);

create table if not exists public.concept_answers (
  id                 uuid primary key default gen_random_uuid(),
  concept_id         uuid not null references public.concepts(id) on delete cascade,
  answer_concept_id  uuid not null references public.concepts(id) on delete cascade,
  sort_weight        integer not null default 0,
  created_at         timestamptz not null default now()
);

create index if not exists idx_concept_answers_concept on public.concept_answers (concept_id, sort_weight);
create unique index if not exists uq_concept_answers
  on public.concept_answers (concept_id, answer_concept_id);

-- Concept set membership: a "set" concept (is_set = true, e.g. PHQ-9 root) has
-- ordered member concepts (its 9 questions). Mirrors OpenMRS concept_set.
create table if not exists public.concept_set_members (
  id                 uuid primary key default gen_random_uuid(),
  concept_set_id     uuid not null references public.concepts(id) on delete cascade,
  member_concept_id  uuid not null references public.concepts(id) on delete cascade,
  sort_weight        integer not null default 0,
  created_at         timestamptz not null default now()
);
create index if not exists idx_concept_set_members on public.concept_set_members (concept_set_id, sort_weight);
create unique index if not exists uq_concept_set_members
  on public.concept_set_members (concept_set_id, member_concept_id);
alter table public.concept_set_members enable row level security;
drop policy if exists concept_set_members_read on public.concept_set_members;
create policy concept_set_members_read on public.concept_set_members for select to authenticated using (
  exists (
    select 1 from public.concepts c
    where c.id = concept_set_members.concept_set_id
      and (c.created_by_organization_id is null
           or c.created_by_organization_id::text = coalesce(auth.jwt() ->> 'organization_id', auth.jwt() -> 'app_metadata' ->> 'organization_id', ''))
  )
);

-- ─────────────────────────────────────────────────────────────────────────────
-- RLS — dictionary is globally readable to authenticated users.
-- Writes are restricted by org match on created_by_organization_id (or null = global, admin-only via service role).
-- ─────────────────────────────────────────────────────────────────────────────
alter table public.concepts enable row level security;
alter table public.concept_names enable row level security;
alter table public.concept_mappings enable row level security;
alter table public.concept_answers enable row level security;

drop policy if exists concepts_read on public.concepts;
create policy concepts_read on public.concepts
  for select to authenticated using (
    -- Global dictionary (NULL org) is visible to everyone.
    created_by_organization_id is null
    -- Org-local concepts are only visible to members of that org.
    or created_by_organization_id::text = coalesce(
      auth.jwt() ->> 'organization_id',
      auth.jwt() -> 'app_metadata' ->> 'organization_id',
      ''
    )
  );

drop policy if exists concepts_write on public.concepts;
create policy concepts_write on public.concepts
  for all to authenticated
  using (
    created_by_organization_id is not null
    and created_by_organization_id::text = coalesce(auth.jwt() ->> 'organization_id', auth.jwt() -> 'app_metadata' ->> 'organization_id', '')
  )
  with check (
    created_by_organization_id is not null
    and created_by_organization_id::text = coalesce(auth.jwt() ->> 'organization_id', auth.jwt() -> 'app_metadata' ->> 'organization_id', '')
  );

-- Child-table reads inherit from the parent concept's visibility — direct table
-- queries cannot bypass org scoping.
drop policy if exists concept_names_read on public.concept_names;
create policy concept_names_read on public.concept_names for select to authenticated using (
  exists (
    select 1 from public.concepts c
    where c.id = concept_names.concept_id
      and (c.created_by_organization_id is null
           or c.created_by_organization_id::text = coalesce(auth.jwt() ->> 'organization_id', auth.jwt() -> 'app_metadata' ->> 'organization_id', ''))
  )
);
drop policy if exists concept_mappings_read on public.concept_mappings;
create policy concept_mappings_read on public.concept_mappings for select to authenticated using (
  exists (
    select 1 from public.concepts c
    where c.id = concept_mappings.concept_id
      and (c.created_by_organization_id is null
           or c.created_by_organization_id::text = coalesce(auth.jwt() ->> 'organization_id', auth.jwt() -> 'app_metadata' ->> 'organization_id', ''))
  )
);
drop policy if exists concept_answers_read on public.concept_answers;
create policy concept_answers_read on public.concept_answers for select to authenticated using (
  exists (
    select 1 from public.concepts c
    where c.id = concept_answers.concept_id
      and (c.created_by_organization_id is null
           or c.created_by_organization_id::text = coalesce(auth.jwt() ->> 'organization_id', auth.jwt() -> 'app_metadata' ->> 'organization_id', ''))
  )
);

-- ─────────────────────────────────────────────────────────────────────────────
-- Seed: PHQ-9, GAD-7, vitals starter set.
-- Stable UUIDs so future re-runs and JSON re-imports stay aligned.
-- ─────────────────────────────────────────────────────────────────────────────

-- Helper: every seeded concept upsert updates name/description/datatype/class/is_set
-- so re-applying the seed (or future JSON re-imports) keeps the DB aligned.

-- Shared 0-3 Likert answer choices (PHQ-9/GAD-7 share these)
insert into public.concepts (id, name, description, datatype, concept_class, is_set)
values
  ('c01ce700-0000-4000-8000-000000000000', 'Not at all', '0 - Not at all', 'coded', 'Misc', false),
  ('c01ce700-0000-4000-8000-000000000001', 'Several days', '1 - Several days', 'coded', 'Misc', false),
  ('c01ce700-0000-4000-8000-000000000002', 'More than half the days', '2 - More than half the days', 'coded', 'Misc', false),
  ('c01ce700-0000-4000-8000-000000000003', 'Nearly every day', '3 - Nearly every day', 'coded', 'Misc', false)
on conflict (id) do update set
  name = excluded.name,
  description = excluded.description,
  datatype = excluded.datatype,
  concept_class = excluded.concept_class,
  is_set = excluded.is_set,
  updated_at = now();

-- PHQ-9 root + 9 questions
insert into public.concepts (id, name, description, datatype, concept_class, is_set)
values
  ('9c800000-0000-4000-8000-000000000000', 'PHQ-9 total score', 'Patient Health Questionnaire-9 total score (0-27)', 'numeric', 'LabSet', true),
  ('9c800000-0000-4000-8000-000000000001', 'PHQ-9 Q1 — Little interest or pleasure', 'Over the last 2 weeks, how often have you been bothered by little interest or pleasure in doing things?', 'numeric', 'Question', false),
  ('9c800000-0000-4000-8000-000000000002', 'PHQ-9 Q2 — Feeling down or depressed', 'Feeling down, depressed, or hopeless', 'numeric', 'Question', false),
  ('9c800000-0000-4000-8000-000000000003', 'PHQ-9 Q3 — Sleep trouble', 'Trouble falling or staying asleep, or sleeping too much', 'numeric', 'Question', false),
  ('9c800000-0000-4000-8000-000000000004', 'PHQ-9 Q4 — Tired or low energy', 'Feeling tired or having little energy', 'numeric', 'Question', false),
  ('9c800000-0000-4000-8000-000000000005', 'PHQ-9 Q5 — Appetite', 'Poor appetite or overeating', 'numeric', 'Question', false),
  ('9c800000-0000-4000-8000-000000000006', 'PHQ-9 Q6 — Feeling bad about self', 'Feeling bad about yourself - or that you are a failure or have let yourself or your family down', 'numeric', 'Question', false),
  ('9c800000-0000-4000-8000-000000000007', 'PHQ-9 Q7 — Concentration', 'Trouble concentrating on things, such as reading the newspaper or watching television', 'numeric', 'Question', false),
  ('9c800000-0000-4000-8000-000000000008', 'PHQ-9 Q8 — Psychomotor', 'Moving or speaking so slowly that other people could have noticed; or being so fidgety or restless that you have been moving around a lot more than usual', 'numeric', 'Question', false),
  ('9c800000-0000-4000-8000-000000000009', 'PHQ-9 Q9 — Self-harm ideation', 'Thoughts that you would be better off dead, or of hurting yourself in some way', 'numeric', 'Question', false)
on conflict (id) do update set
  name = excluded.name, description = excluded.description, datatype = excluded.datatype,
  concept_class = excluded.concept_class, is_set = excluded.is_set, updated_at = now();

-- GAD-7 root + 7 questions
insert into public.concepts (id, name, description, datatype, concept_class, is_set)
values
  ('9ad70000-0000-4000-8000-000000000000', 'GAD-7 total score', 'Generalized Anxiety Disorder-7 total score (0-21)', 'numeric', 'LabSet', true),
  ('9ad70000-0000-4000-8000-000000000001', 'GAD-7 Q1 — Nervous or on edge', 'Feeling nervous, anxious, or on edge', 'numeric', 'Question', false),
  ('9ad70000-0000-4000-8000-000000000002', 'GAD-7 Q2 — Cannot stop worrying', 'Not being able to stop or control worrying', 'numeric', 'Question', false),
  ('9ad70000-0000-4000-8000-000000000003', 'GAD-7 Q3 — Worrying too much', 'Worrying too much about different things', 'numeric', 'Question', false),
  ('9ad70000-0000-4000-8000-000000000004', 'GAD-7 Q4 — Trouble relaxing', 'Trouble relaxing', 'numeric', 'Question', false),
  ('9ad70000-0000-4000-8000-000000000005', 'GAD-7 Q5 — Restless', 'Being so restless that it is hard to sit still', 'numeric', 'Question', false),
  ('9ad70000-0000-4000-8000-000000000006', 'GAD-7 Q6 — Easily annoyed', 'Becoming easily annoyed or irritable', 'numeric', 'Question', false),
  ('9ad70000-0000-4000-8000-000000000007', 'GAD-7 Q7 — Afraid', 'Feeling afraid as if something awful might happen', 'numeric', 'Question', false)
on conflict (id) do update set
  name = excluded.name, description = excluded.description, datatype = excluded.datatype,
  concept_class = excluded.concept_class, is_set = excluded.is_set, updated_at = now();

-- Vitals starter set
insert into public.concepts (id, name, description, datatype, concept_class, is_set)
values
  ('71ca1500-0000-4000-8000-000000000001', 'Height (cm)', 'Body height in centimeters', 'numeric', 'Finding', false),
  ('71ca1500-0000-4000-8000-000000000002', 'Weight (kg)', 'Body weight in kilograms', 'numeric', 'Finding', false),
  ('71ca1500-0000-4000-8000-000000000003', 'Systolic blood pressure (mmHg)', 'Systolic blood pressure', 'numeric', 'Finding', false),
  ('71ca1500-0000-4000-8000-000000000004', 'Diastolic blood pressure (mmHg)', 'Diastolic blood pressure', 'numeric', 'Finding', false),
  ('71ca1500-0000-4000-8000-000000000005', 'Heart rate (bpm)', 'Heart rate in beats per minute', 'numeric', 'Finding', false)
on conflict (id) do update set
  name = excluded.name, description = excluded.description, datatype = excluded.datatype,
  concept_class = excluded.concept_class, is_set = excluded.is_set, updated_at = now();

-- Diagnosis placeholder + a few common starter diagnoses (ICD-10 mapped below)
insert into public.concepts (id, name, description, datatype, concept_class, is_set)
values
  ('d1a90000-0000-4000-8000-000000000001', 'Diagnosis (free text placeholder)', 'Holds a diagnosis until a proper ICD-10-coded concept replaces it', 'text', 'Diagnosis', false),
  ('d1a90000-0000-4000-8000-000000000002', 'Major depressive disorder, single episode, unspecified', 'ICD-10 F32.9 — common depression diagnosis starter concept', 'coded', 'Diagnosis', false),
  ('d1a90000-0000-4000-8000-000000000003', 'Generalized anxiety disorder', 'ICD-10 F41.1 — common anxiety diagnosis starter concept', 'coded', 'Diagnosis', false),
  ('d1a90000-0000-4000-8000-000000000004', 'Post-traumatic stress disorder, unspecified', 'ICD-10 F43.10 — common PTSD diagnosis starter concept', 'coded', 'Diagnosis', false),
  ('d1a90000-0000-4000-8000-000000000005', 'Adjustment disorder, unspecified', 'ICD-10 F43.20 — common adjustment diagnosis starter concept', 'coded', 'Diagnosis', false)
on conflict (id) do update set
  name = excluded.name, description = excluded.description, datatype = excluded.datatype,
  concept_class = excluded.concept_class, is_set = excluded.is_set, updated_at = now();

-- ─────────────────────────────────────────────────────────────────────────────
-- Concept names (full names — synonyms can be added later)
-- ─────────────────────────────────────────────────────────────────────────────
insert into public.concept_names (concept_id, name, locale, name_type)
select id, name, 'en', 'full' from public.concepts
where id in (
  'c01ce700-0000-4000-8000-000000000000',
  'c01ce700-0000-4000-8000-000000000001',
  'c01ce700-0000-4000-8000-000000000002',
  'c01ce700-0000-4000-8000-000000000003',
  '9c800000-0000-4000-8000-000000000000',
  '9c800000-0000-4000-8000-000000000001',
  '9c800000-0000-4000-8000-000000000002',
  '9c800000-0000-4000-8000-000000000003',
  '9c800000-0000-4000-8000-000000000004',
  '9c800000-0000-4000-8000-000000000005',
  '9c800000-0000-4000-8000-000000000006',
  '9c800000-0000-4000-8000-000000000007',
  '9c800000-0000-4000-8000-000000000008',
  '9c800000-0000-4000-8000-000000000009',
  '9ad70000-0000-4000-8000-000000000000',
  '9ad70000-0000-4000-8000-000000000001',
  '9ad70000-0000-4000-8000-000000000002',
  '9ad70000-0000-4000-8000-000000000003',
  '9ad70000-0000-4000-8000-000000000004',
  '9ad70000-0000-4000-8000-000000000005',
  '9ad70000-0000-4000-8000-000000000006',
  '9ad70000-0000-4000-8000-000000000007',
  '71ca1500-0000-4000-8000-000000000001',
  '71ca1500-0000-4000-8000-000000000002',
  '71ca1500-0000-4000-8000-000000000003',
  '71ca1500-0000-4000-8000-000000000004',
  '71ca1500-0000-4000-8000-000000000005',
  'd1a90000-0000-4000-8000-000000000001',
  'd1a90000-0000-4000-8000-000000000002',
  'd1a90000-0000-4000-8000-000000000003',
  'd1a90000-0000-4000-8000-000000000004',
  'd1a90000-0000-4000-8000-000000000005'
)
on conflict (concept_id, locale, lower(name)) do update set name_type = excluded.name_type;

-- ─────────────────────────────────────────────────────────────────────────────
-- LOINC mappings
-- ─────────────────────────────────────────────────────────────────────────────
insert into public.concept_mappings (concept_id, code_system, code, display) values
  ('9c800000-0000-4000-8000-000000000000', 'LOINC', '44261-6', 'PHQ-9 total score [Reported]'),
  ('9c800000-0000-4000-8000-000000000001', 'LOINC', '44250-9', 'PHQ-9 item 1'),
  ('9c800000-0000-4000-8000-000000000002', 'LOINC', '44255-8', 'PHQ-9 item 2'),
  ('9c800000-0000-4000-8000-000000000003', 'LOINC', '44259-0', 'PHQ-9 item 3'),
  ('9c800000-0000-4000-8000-000000000004', 'LOINC', '44254-1', 'PHQ-9 item 4'),
  ('9c800000-0000-4000-8000-000000000005', 'LOINC', '44251-7', 'PHQ-9 item 5'),
  ('9c800000-0000-4000-8000-000000000006', 'LOINC', '44258-2', 'PHQ-9 item 6'),
  ('9c800000-0000-4000-8000-000000000007', 'LOINC', '44252-5', 'PHQ-9 item 7'),
  ('9c800000-0000-4000-8000-000000000008', 'LOINC', '44253-3', 'PHQ-9 item 8'),
  ('9c800000-0000-4000-8000-000000000009', 'LOINC', '44260-8', 'PHQ-9 item 9'),
  ('9ad70000-0000-4000-8000-000000000000', 'LOINC', '70274-6', 'Generalized anxiety disorder 7 item (GAD-7) total score'),
  ('71ca1500-0000-4000-8000-000000000001', 'LOINC', '8302-2', 'Body height'),
  ('71ca1500-0000-4000-8000-000000000002', 'LOINC', '29463-7', 'Body weight'),
  ('71ca1500-0000-4000-8000-000000000003', 'LOINC', '8480-6', 'Systolic blood pressure'),
  ('71ca1500-0000-4000-8000-000000000004', 'LOINC', '8462-4', 'Diastolic blood pressure'),
  ('71ca1500-0000-4000-8000-000000000005', 'LOINC', '8867-4', 'Heart rate'),
  ('d1a90000-0000-4000-8000-000000000002', 'ICD10CM', 'F32.9',  'Major depressive disorder, single episode, unspecified'),
  ('d1a90000-0000-4000-8000-000000000003', 'ICD10CM', 'F41.1',  'Generalized anxiety disorder'),
  ('d1a90000-0000-4000-8000-000000000004', 'ICD10CM', 'F43.10', 'Post-traumatic stress disorder, unspecified'),
  ('d1a90000-0000-4000-8000-000000000005', 'ICD10CM', 'F43.20', 'Adjustment disorder, unspecified')
on conflict (concept_id, code_system, code) do update set display = excluded.display;

-- ─────────────────────────────────────────────────────────────────────────────
-- Concept answers: PHQ-9 + GAD-7 questions all use the shared 0-3 Likert set
-- ─────────────────────────────────────────────────────────────────────────────
do $$
declare
  q uuid;
  q_ids uuid[] := array[
    '9c800000-0000-4000-8000-000000000001', '9c800000-0000-4000-8000-000000000002',
    '9c800000-0000-4000-8000-000000000003', '9c800000-0000-4000-8000-000000000004',
    '9c800000-0000-4000-8000-000000000005', '9c800000-0000-4000-8000-000000000006',
    '9c800000-0000-4000-8000-000000000007', '9c800000-0000-4000-8000-000000000008',
    '9c800000-0000-4000-8000-000000000009',
    '9ad70000-0000-4000-8000-000000000001', '9ad70000-0000-4000-8000-000000000002',
    '9ad70000-0000-4000-8000-000000000003', '9ad70000-0000-4000-8000-000000000004',
    '9ad70000-0000-4000-8000-000000000005', '9ad70000-0000-4000-8000-000000000006',
    '9ad70000-0000-4000-8000-000000000007'
  ];
begin
  foreach q in array q_ids loop
    insert into public.concept_answers (concept_id, answer_concept_id, sort_weight) values
      (q, 'c01ce700-0000-4000-8000-000000000000', 0),
      (q, 'c01ce700-0000-4000-8000-000000000001', 1),
      (q, 'c01ce700-0000-4000-8000-000000000002', 2),
      (q, 'c01ce700-0000-4000-8000-000000000003', 3)
    on conflict (concept_id, answer_concept_id) do update set sort_weight = excluded.sort_weight;
  end loop;
end $$;

-- PHQ-9 + GAD-7 set membership: assessment root → ordered question members.
insert into public.concept_set_members (concept_set_id, member_concept_id, sort_weight) values
  ('9c800000-0000-4000-8000-000000000000', '9c800000-0000-4000-8000-000000000001', 1),
  ('9c800000-0000-4000-8000-000000000000', '9c800000-0000-4000-8000-000000000002', 2),
  ('9c800000-0000-4000-8000-000000000000', '9c800000-0000-4000-8000-000000000003', 3),
  ('9c800000-0000-4000-8000-000000000000', '9c800000-0000-4000-8000-000000000004', 4),
  ('9c800000-0000-4000-8000-000000000000', '9c800000-0000-4000-8000-000000000005', 5),
  ('9c800000-0000-4000-8000-000000000000', '9c800000-0000-4000-8000-000000000006', 6),
  ('9c800000-0000-4000-8000-000000000000', '9c800000-0000-4000-8000-000000000007', 7),
  ('9c800000-0000-4000-8000-000000000000', '9c800000-0000-4000-8000-000000000008', 8),
  ('9c800000-0000-4000-8000-000000000000', '9c800000-0000-4000-8000-000000000009', 9),
  ('9ad70000-0000-4000-8000-000000000000', '9ad70000-0000-4000-8000-000000000001', 1),
  ('9ad70000-0000-4000-8000-000000000000', '9ad70000-0000-4000-8000-000000000002', 2),
  ('9ad70000-0000-4000-8000-000000000000', '9ad70000-0000-4000-8000-000000000003', 3),
  ('9ad70000-0000-4000-8000-000000000000', '9ad70000-0000-4000-8000-000000000004', 4),
  ('9ad70000-0000-4000-8000-000000000000', '9ad70000-0000-4000-8000-000000000005', 5),
  ('9ad70000-0000-4000-8000-000000000000', '9ad70000-0000-4000-8000-000000000006', 6),
  ('9ad70000-0000-4000-8000-000000000000', '9ad70000-0000-4000-8000-000000000007', 7)
on conflict (concept_set_id, member_concept_id) do update set sort_weight = excluded.sort_weight;

select pg_notify('pgrst', 'reload schema');
