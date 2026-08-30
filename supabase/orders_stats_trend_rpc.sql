-- تجميع /stats/trend جوّه Postgres بدل سحب كل الأوردرات للـ Node.
-- Run once in the Supabase SQL editor.

create index if not exists orders_created_at_status_idx
  on public.orders (created_at, status);

create or replace function public.orders_stats_trend(
  p_from timestamptz,
  p_to timestamptz,
  p_granularity text default 'day',
  p_status text default null,
  p_order_source text default null,
  p_order_type text default null,
  p_shipping_status text default null,
  p_utm_source text default null
)
returns table (
  bucket text,
  total_orders integer,
  shipped_orders integer,
  successful_orders integer,
  total numeric,
  total_product_units numeric
)
language sql
stable
as $$
  with bounds as (
    select (p_from at time zone 'Africa/Cairo')::date as from_d
  ),
  filtered as (
    select
      (o.created_at at time zone 'Africa/Cairo')::date as egypt_d,
      o.status,
      o.raw_data
    from public.orders o
    where o.created_at >= p_from
      and o.created_at <= p_to
      and (
        case
          when p_status is null or btrim(p_status) = '' then
            o.status in (
              'canceled',
              'new',
              'pending',
              'no_replay',
              'follow up',
              'repeater',
              'Confirmed',
              'Shipped'
            )
          when p_status = 'pending' then o.status in ('new', 'pending')
          else o.status = p_status
        end
      )
      and (
        p_order_source is null
        or o.raw_data->>'order_source' = p_order_source
        or o.raw_data->>'orderSource' = p_order_source
      )
      and (
        p_order_type is null
        or o.raw_data->>'order_type' = p_order_type
        or o.raw_data->>'orderType' = p_order_type
      )
      and (
        p_shipping_status is null
        or o.raw_data->>'shipping_status' = p_shipping_status
        or o.raw_data->>'shippingStatus' = p_shipping_status
      )
      and (
        p_utm_source is null
        or lower(coalesce(o.raw_data->>'utm_source', o.raw_data->>'utmSource', '')) = lower(p_utm_source)
      )
  ),
  bucketed as (
    select
      case
        when p_granularity = 'month' then to_char(egypt_d, 'YYYY-MM')
        when p_granularity = 'week' then to_char(
          (select from_d from bounds) + ((egypt_d - (select from_d from bounds)) / 7) * 7,
          'YYYY-MM-DD'
        )
        else to_char(egypt_d, 'YYYY-MM-DD')
      end as bucket,
      status,
      raw_data
    from filtered
  )
  select
    bucket,
    count(*)::int as total_orders,
    count(*) filter (where status = 'Shipped')::int as shipped_orders,
    count(*) filter (
      where status = 'Shipped'
        and (
          coalesce(raw_data->>'shipping_status', '') = 'delivered'
          or coalesce(raw_data->>'shippingStatus', '') = 'delivered'
        )
    )::int as successful_orders,
    coalesce(sum(
      coalesce(
        nullif(raw_data->>'total_cost', '')::numeric,
        nullif(raw_data->>'cost', '')::numeric,
        0
      )
    ), 0) as total,
    coalesce(sum(
      case
        when jsonb_typeof(coalesce(raw_data->'cart_items', raw_data->'cartItems')) = 'array'
        then (
          select coalesce(sum(coalesce(nullif(elem->>'quantity', '')::numeric, 0)), 0)
          from jsonb_array_elements(
            coalesce(raw_data->'cart_items', raw_data->'cartItems', '[]'::jsonb)
          ) elem
        )
        else 0
      end
    ), 0) as total_product_units
  from bucketed
  group by bucket
  order by bucket;
$$;

grant execute on function public.orders_stats_trend(
  timestamptz, timestamptz, text, text, text, text, text, text
) to service_role;

notify pgrst, 'reload schema';
