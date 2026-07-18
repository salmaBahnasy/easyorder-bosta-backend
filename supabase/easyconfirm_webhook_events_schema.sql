-- EasyConfirm webhook idempotency + audit trail
-- Run once in Supabase SQL Editor.

create table if not exists public.easyconfirm_webhook_events (
  event_id text primary key,
  event_type text,
  order_id text,
  confirmation_status text,
  received_at timestamptz not null default now(),
  payload jsonb
);

create index if not exists easyconfirm_webhook_events_order_id_idx
  on public.easyconfirm_webhook_events (order_id);

create index if not exists easyconfirm_webhook_events_received_at_idx
  on public.easyconfirm_webhook_events (received_at desc);

comment on table public.easyconfirm_webhook_events is
  'Idempotent log of EasyConfirm webhook deliveries (event_id unique).';
