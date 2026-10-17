-- T-0304 legal CMS: versioned documents and consent records (enabling)
create schema if not exists legal;

create table legal.document_version (
  doc_key            text not null check (doc_key in ('terms','privacy','cardholder','esim','insurance','p2p','funder')),
  version            int not null,
  title_en           text not null,
  title_he           text not null,
  body_en            text not null,
  body_he            text not null,
  hash               text not null,                 -- sha256 of key + both bodies; stored on every consent
  material           boolean not null,              -- material change → re-accept sheet
  change_summary_en  text,
  change_summary_he  text,
  published_by       uuid not null,
  effective_at       timestamptz not null,
  published_at       timestamptz not null,
  primary key (doc_key, version)
);
create index on legal.document_version (doc_key, effective_at desc);

-- Consent is evidence: never updated or deleted.
create table legal.consent (
  id           uuid primary key,
  party_id     uuid not null,
  doc_key      text not null,
  version      int not null,
  hash         text not null,
  device_id    text not null,
  ip           inet not null,
  locale       text not null check (locale in ('en','he')),
  accepted_at  timestamptz not null,
  unique (party_id, doc_key, version),
  foreign key (doc_key, version) references legal.document_version(doc_key, version)
);
create index on legal.consent (party_id, accepted_at);

grant usage on schema legal to club_app;
grant select on legal.document_version to club_app;         -- publishing is a back-office action (club_migrator / admin tool)
grant select, insert on legal.consent to club_app;
