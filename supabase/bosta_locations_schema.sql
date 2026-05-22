-- Run in Supabase SQL editor (once). Stores Bosta cities & districts with same IDs as Bosta API.

create table if not exists public.bosta_cities (
  id text primary key,
  name text,
  name_ar text,
  code text,
  alias text,
  hub_id text,
  hub_name text,
  sector integer,
  pickup_availability boolean default true,
  drop_off_availability boolean default true,
  show_as_drop_off boolean default true,
  show_as_pickup boolean default true,
  raw_data jsonb,
  synced_at timestamptz default now()
);

create table if not exists public.bosta_districts (
  id text primary key,
  city_id text not null references public.bosta_cities (id) on delete cascade,
  zone_id text,
  zone_name text,
  zone_other_name text,
  district_name text,
  district_other_name text,
  pickup_availability boolean default true,
  drop_off_availability boolean default true,
  raw_data jsonb,
  synced_at timestamptz default now()
);

create index if not exists bosta_districts_city_id_idx on public.bosta_districts (city_id);
