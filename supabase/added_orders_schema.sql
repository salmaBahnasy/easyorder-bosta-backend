-- جدول الطلبات المضافة يدوياً (منفصل عن orders)
-- Run once in Supabase SQL editor.

create table if not exists public.added_orders (
  id uuid primary key default gen_random_uuid(),
  added_by_employee_id text not null,
  added_by_name text,
  added_by_email text,
  customer_name text not null,
  phone text not null,
  products jsonb not null default '[]'::jsonb,
  total_cost numeric(12, 2) not null,
  created_at timestamptz not null default now()
);

create index if not exists added_orders_created_at_idx
  on public.added_orders (created_at desc);

create index if not exists added_orders_employee_idx
  on public.added_orders (added_by_employee_id);

notify pgrst, 'reload schema';
