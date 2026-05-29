-- Backfill legacy free-text demographic values on `public.clients` so they
-- match the curated value sets enforced by the demographics editor and the
-- patient PATCH endpoint (see lib/demographics/options.ts).
--
-- Affects columns: state, sex_at_birth, gender_identity, preferred_language.
--
-- Strategy
--   * state             -> two-letter US state code where unambiguous.
--                         Unmapped values are left untouched and reported.
--   * sex_at_birth      -> {female,male,intersex,unknown,declined}. Unmapped
--                         values are left untouched and reported (no `other:`
--                         escape exists for this field).
--   * gender_identity   -> curated value, else wrapped with `other:<raw>` so
--                         it satisfies isValidGenderIdentity().
--   * preferred_language-> curated 2-letter code, else wrapped with
--                         `other:<raw>` so it satisfies
--                         isValidPreferredLanguage().
--
-- Rows that cannot be auto-normalized (state / sex_at_birth) are recorded in
-- `public.clients_demographics_normalization_report` for a human to resolve.
-- Counts are also emitted via RAISE NOTICE.
--
-- Safe to re-run: the report table is truncated at the start of each run and
-- only rows whose current value is non-canonical are touched.

create table if not exists public.clients_demographics_normalization_report (
  id               bigserial primary key,
  client_id        uuid not null,
  organization_id  uuid,
  column_name      text not null,
  raw_value        text not null,
  reason           text not null,
  reported_at      timestamptz not null default now()
);

create index if not exists clients_demographics_normalization_report_client_idx
  on public.clients_demographics_normalization_report (client_id);

truncate public.clients_demographics_normalization_report;

do $$
declare
  v_state_updated      integer := 0;
  v_sex_updated        integer := 0;
  v_gender_updated     integer := 0;
  v_gender_other       integer := 0;
  v_lang_updated       integer := 0;
  v_lang_other         integer := 0;
  v_state_unmapped     integer := 0;
  v_sex_unmapped       integer := 0;
begin
  ----------------------------------------------------------------------------
  -- 1. STATE: normalise to two-letter US code.
  ----------------------------------------------------------------------------
  with name_map(name, code) as (
    values
      ('alabama','AL'),('alaska','AK'),('arizona','AZ'),('arkansas','AR'),
      ('california','CA'),('colorado','CO'),('connecticut','CT'),
      ('delaware','DE'),('district of columbia','DC'),('washington dc','DC'),
      ('washington d.c.','DC'),('d.c.','DC'),('dc','DC'),
      ('florida','FL'),('georgia','GA'),('hawaii','HI'),('idaho','ID'),
      ('illinois','IL'),('indiana','IN'),('iowa','IA'),('kansas','KS'),
      ('kentucky','KY'),('louisiana','LA'),('maine','ME'),('maryland','MD'),
      ('massachusetts','MA'),('michigan','MI'),('minnesota','MN'),
      ('mississippi','MS'),('missouri','MO'),('montana','MT'),
      ('nebraska','NE'),('nevada','NV'),('new hampshire','NH'),
      ('new jersey','NJ'),('new mexico','NM'),('new york','NY'),
      ('north carolina','NC'),('north dakota','ND'),('ohio','OH'),
      ('oklahoma','OK'),('oregon','OR'),('pennsylvania','PA'),
      ('puerto rico','PR'),('rhode island','RI'),('south carolina','SC'),
      ('south dakota','SD'),('tennessee','TN'),('texas','TX'),('utah','UT'),
      ('vermont','VT'),('virginia','VA'),('u.s. virgin islands','VI'),
      ('us virgin islands','VI'),('virgin islands','VI'),('washington','WA'),
      ('west virginia','WV'),('wisconsin','WI'),('wyoming','WY')
  ),
  valid_codes(code) as (
    values
      ('AL'),('AK'),('AZ'),('AR'),('CA'),('CO'),('CT'),('DE'),('DC'),('FL'),
      ('GA'),('HI'),('ID'),('IL'),('IN'),('IA'),('KS'),('KY'),('LA'),('ME'),
      ('MD'),('MA'),('MI'),('MN'),('MS'),('MO'),('MT'),('NE'),('NV'),('NH'),
      ('NJ'),('NM'),('NY'),('NC'),('ND'),('OH'),('OK'),('OR'),('PA'),('PR'),
      ('RI'),('SC'),('SD'),('TN'),('TX'),('UT'),('VT'),('VA'),('VI'),('WA'),
      ('WV'),('WI'),('WY')
  ),
  resolved as (
    select
      c.id,
      c.state as raw,
      case
        -- already a valid 2-letter code (any case)
        when upper(btrim(c.state)) in (select code from valid_codes)
          then upper(btrim(c.state))
        -- full name (case-insensitive, trimmed, punctuation-tolerant for DC/VI)
        when (select code from name_map
                where name = lower(btrim(c.state))) is not null
          then (select code from name_map
                  where name = lower(btrim(c.state)))
        else null
      end as code
    from public.clients c
    where c.state is not null
      and btrim(c.state) <> ''
  ),
  to_update as (
    select id, code
    from resolved
    where code is not null and code <> raw
  ),
  upd as (
    update public.clients c
       set state = u.code,
           updated_at = now()
      from to_update u
     where c.id = u.id
    returning c.id
  )
  select count(*) into v_state_updated from upd;

  insert into public.clients_demographics_normalization_report
    (client_id, organization_id, column_name, raw_value, reason)
  select c.id, c.organization_id, 'state', c.state,
         'No unambiguous mapping to a US state code'
    from public.clients c
   where c.state is not null
     and btrim(c.state) <> ''
     and upper(btrim(c.state)) not in (
       'AL','AK','AZ','AR','CA','CO','CT','DE','DC','FL','GA','HI','ID','IL',
       'IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE',
       'NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','PR','RI','SC',
       'SD','TN','TX','UT','VT','VA','VI','WA','WV','WI','WY'
     );
  get diagnostics v_state_unmapped = row_count;

  ----------------------------------------------------------------------------
  -- 2. SEX AT BIRTH
  ----------------------------------------------------------------------------
  with mapped as (
    select c.id, c.sex_at_birth as raw,
      case lower(btrim(c.sex_at_birth))
        when 'f' then 'female'
        when 'female' then 'female'
        when 'm' then 'male'
        when 'male' then 'male'
        when 'i' then 'intersex'
        when 'intersex' then 'intersex'
        when 'u' then 'unknown'
        when 'unk' then 'unknown'
        when 'unknown' then 'unknown'
        when '' then null
        when 'decline' then 'declined'
        when 'declined' then 'declined'
        when 'declined to answer' then 'declined'
        when 'declined to state' then 'declined'
        when 'prefer not to say' then 'declined'
        when 'refused' then 'declined'
        else null
      end as canonical
    from public.clients c
    where c.sex_at_birth is not null
  ),
  upd as (
    update public.clients c
       set sex_at_birth = m.canonical,
           updated_at = now()
      from mapped m
     where c.id = m.id
       and m.canonical is not null
       and m.canonical <> coalesce(c.sex_at_birth, '')
    returning c.id
  )
  select count(*) into v_sex_updated from upd;

  insert into public.clients_demographics_normalization_report
    (client_id, organization_id, column_name, raw_value, reason)
  select c.id, c.organization_id, 'sex_at_birth', c.sex_at_birth,
         'No unambiguous mapping to a curated sex_at_birth code'
    from public.clients c
   where c.sex_at_birth is not null
     and c.sex_at_birth not in ('female','male','intersex','unknown','declined');
  get diagnostics v_sex_unmapped = row_count;

  ----------------------------------------------------------------------------
  -- 3. GENDER IDENTITY — wrap unmapped values in `other:` prefix.
  ----------------------------------------------------------------------------
  with mapped as (
    select c.id, c.gender_identity as raw,
      case lower(btrim(c.gender_identity))
        when 'f' then 'female'
        when 'female' then 'female'
        when 'woman' then 'female'
        when 'm' then 'male'
        when 'male' then 'male'
        when 'man' then 'male'
        when 'transgender female' then 'transgender_female'
        when 'trans female' then 'transgender_female'
        when 'trans woman' then 'transgender_female'
        when 'mtf' then 'transgender_female'
        when 'transgender male' then 'transgender_male'
        when 'trans male' then 'transgender_male'
        when 'trans man' then 'transgender_male'
        when 'ftm' then 'transgender_male'
        when 'non binary' then 'non_binary'
        when 'non-binary' then 'non_binary'
        when 'nonbinary' then 'non_binary'
        when 'nb' then 'non_binary'
        when 'enby' then 'non_binary'
        when 'two spirit' then 'two_spirit'
        when 'two-spirit' then 'two_spirit'
        when 'other' then 'other'
        when 'decline' then 'declined'
        when 'declined' then 'declined'
        when 'declined to answer' then 'declined'
        when 'declined to state' then 'declined'
        when 'prefer not to say' then 'declined'
        when 'refused' then 'declined'
        else null
      end as canonical
    from public.clients c
    where c.gender_identity is not null
      and btrim(c.gender_identity) <> ''
      and c.gender_identity not in
        ('female','male','transgender_female','transgender_male',
         'non_binary','two_spirit','other','declined')
      and not (c.gender_identity like 'other:%'
               and length(btrim(substring(c.gender_identity from 7))) > 0)
  ),
  upd_canonical as (
    update public.clients c
       set gender_identity = m.canonical,
           updated_at = now()
      from mapped m
     where c.id = m.id
       and m.canonical is not null
    returning c.id
  )
  select count(*) into v_gender_updated from upd_canonical;

  with unmapped as (
    select c.id, c.gender_identity as raw
      from public.clients c
     where c.gender_identity is not null
       and btrim(c.gender_identity) <> ''
       and c.gender_identity not in
         ('female','male','transgender_female','transgender_male',
          'non_binary','two_spirit','other','declined')
       and not (c.gender_identity like 'other:%'
                and length(btrim(substring(c.gender_identity from 7))) > 0)
  ),
  upd_other as (
    update public.clients c
       set gender_identity = 'other:' || btrim(u.raw),
           updated_at = now()
      from unmapped u
     where c.id = u.id
    returning c.id
  )
  select count(*) into v_gender_other from upd_other;

  ----------------------------------------------------------------------------
  -- 4. PREFERRED LANGUAGE — wrap unmapped values in `other:` prefix.
  ----------------------------------------------------------------------------
  with mapped as (
    select c.id, c.preferred_language as raw,
      case lower(btrim(c.preferred_language))
        when 'english' then 'en'
        when 'eng' then 'en'
        when 'en-us' then 'en'
        when 'en_us' then 'en'
        when 'spanish' then 'es'
        when 'espanol' then 'es'
        when 'español' then 'es'
        when 'spa' then 'es'
        when 'chinese' then 'zh'
        when 'mandarin' then 'zh'
        when 'cantonese' then 'zh'
        when 'zh-cn' then 'zh'
        when 'zh-tw' then 'zh'
        when 'vietnamese' then 'vi'
        when 'tagalog' then 'tl'
        when 'filipino' then 'tl'
        when 'arabic' then 'ar'
        when 'french' then 'fr'
        when 'haitian creole' then 'ht'
        when 'creole' then 'ht'
        when 'korean' then 'ko'
        when 'russian' then 'ru'
        when 'portuguese' then 'pt'
        when 'german' then 'de'
        when 'japanese' then 'ja'
        when 'hindi' then 'hi'
        when 'polish' then 'pl'
        when 'italian' then 'it'
        when 'american sign language' then 'asl'
        when 'sign language' then 'asl'
        else null
      end as canonical
    from public.clients c
    where c.preferred_language is not null
      and btrim(c.preferred_language) <> ''
      and c.preferred_language not in
        ('en','es','zh','vi','tl','ar','fr','ht','ko','ru','pt','de','ja',
         'hi','pl','it','asl','other')
      and not (c.preferred_language like 'other:%'
               and length(btrim(substring(c.preferred_language from 7))) > 0)
  ),
  upd_canonical as (
    update public.clients c
       set preferred_language = m.canonical,
           updated_at = now()
      from mapped m
     where c.id = m.id
       and m.canonical is not null
    returning c.id
  )
  select count(*) into v_lang_updated from upd_canonical;

  with unmapped as (
    select c.id, c.preferred_language as raw
      from public.clients c
     where c.preferred_language is not null
       and btrim(c.preferred_language) <> ''
       and c.preferred_language not in
         ('en','es','zh','vi','tl','ar','fr','ht','ko','ru','pt','de','ja',
          'hi','pl','it','asl','other')
       and not (c.preferred_language like 'other:%'
                and length(btrim(substring(c.preferred_language from 7))) > 0)
  ),
  upd_other as (
    update public.clients c
       set preferred_language = 'other:' || btrim(u.raw),
           updated_at = now()
      from unmapped u
     where c.id = u.id
    returning c.id
  )
  select count(*) into v_lang_other from upd_other;

  raise notice
    'clients demographics backfill: state_updated=%, state_unmapped=%, sex_updated=%, sex_unmapped=%, gender_canonicalized=%, gender_wrapped_other=%, language_canonicalized=%, language_wrapped_other=%',
    v_state_updated, v_state_unmapped,
    v_sex_updated, v_sex_unmapped,
    v_gender_updated, v_gender_other,
    v_lang_updated, v_lang_other;
end;
$$;

-- Reload PostgREST schema cache so the new report table is visible to clients.
select pg_notify('pgrst', 'reload schema');
