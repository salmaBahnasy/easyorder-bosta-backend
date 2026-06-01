-- تكلفة الطلب اليومية: مصروفات + عدد الطلبات (محفوظة عند الإدخال)
-- Run once in Supabase SQL editor.

create table if not exists public.order_cost_daily (
  id uuid primary key default gen_random_uuid(),
  cost_date date not null,
  expense numeric(14, 2) not null default 0,
  total_orders integer not null default 0,
  shipped_orders integer not null default 0,
  successful_orders integer not null default 0,
  total_sales numeric(14, 2) not null default 0,
  shipped_sales numeric(14, 2) not null default 0,
  successful_sales numeric(14, 2) not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists order_cost_daily_cost_date_unique_idx
  on public.order_cost_daily (cost_date);

create index if not exists order_cost_daily_cost_date_range_idx
  on public.order_cost_daily (cost_date desc);

notify pgrst, 'reload schema';
