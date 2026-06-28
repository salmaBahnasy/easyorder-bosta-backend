-- Bosta SKU mappings: product / variant / size → Bosta sku codes
-- Run once in Supabase SQL editor.

create table if not exists public.bosta_sku_mappings (
  id uuid primary key default gen_random_uuid(),
  mapping_type text not null check (mapping_type in ('product', 'variant', 'size')),
  entity_id text not null,
  product_id text,
  name text not null default '',
  size text,
  skus jsonb not null default '[]'::jsonb,
  sizes jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (mapping_type, entity_id)
);

create index if not exists bosta_sku_mappings_type_idx
  on public.bosta_sku_mappings (mapping_type);

create index if not exists bosta_sku_mappings_product_id_idx
  on public.bosta_sku_mappings (product_id)
  where product_id is not null;

create table if not exists public.bosta_unmapped_products (
  product_id text primary key,
  name text not null default '',
  reason text not null default '',
  updated_at timestamptz not null default now()
);

notify pgrst, 'reload schema';
