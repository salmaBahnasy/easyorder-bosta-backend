-- جدول الطلبات المضافة يدوياً (منفصل عن orders)
-- Run once in Supabase SQL editor (آمن إعادة التشغيل).

create table if not exists public.added_orders (
  id uuid primary key default gen_random_uuid(),
  added_by_employee_id text not null,
  added_by_name text,
  added_by_email text,
  customer_name text not null,
  phone text not null,
  products jsonb not null default '[]'::jsonb,
  products_names text,
  order_reference integer,
  total_cost numeric(12, 2) not null,
  created_at timestamptz not null default now()
);

alter table public.added_orders
  add column if not exists products_names text;

alter table public.added_orders
  add column if not exists order_reference integer;

create unique index if not exists added_orders_order_reference_unique_idx
  on public.added_orders (order_reference)
  where order_reference is not null;

-- أسماء المنتجات كنص للبحث (لا تستخدم ILIKE على jsonb)
update public.added_orders
set products_names = (
  select coalesce(string_agg(trim(coalesce(elem->>'name', '')), ' '), '')
  from jsonb_array_elements(products) as elem
)
where products_names is null or trim(products_names) = '';

create index if not exists added_orders_created_at_idx
  on public.added_orders (created_at desc);

create index if not exists added_orders_employee_idx
  on public.added_orders (added_by_employee_id);

notify pgrst, 'reload schema';
