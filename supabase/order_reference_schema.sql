-- معرف الطلب التسلسلي (يبدأ 1001 من 24/5 بتوقيت مصر — يُضبط من الباكند)
-- Run once in Supabase SQL editor.

alter table public.orders
  add column if not exists order_reference integer;

create unique index if not exists orders_order_reference_unique_idx
  on public.orders (order_reference)
  where order_reference is not null;

create index if not exists orders_order_reference_created_idx
  on public.orders (created_at)
  where order_reference is not null;

notify pgrst, 'reload schema';
