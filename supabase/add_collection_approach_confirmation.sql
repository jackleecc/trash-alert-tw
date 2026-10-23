-- Shared, versioned approach evidence for the protected Xizhi stop.
-- This migration is additive and safe to apply more than once.

CREATE TABLE IF NOT EXISTS public.collection_approach_state (
  date date NOT NULL,
  route_id text NOT NULL,
  stop_id text NOT NULL,
  car_id text NOT NULL,
  version bigint NOT NULL CHECK (version > 0),
  state jsonb NOT NULL CHECK (jsonb_typeof(state) = 'object'),
  updated_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (date, route_id, stop_id, car_id)
);

CREATE TABLE IF NOT EXISTS public.collection_approach_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  date date NOT NULL,
  route_id text NOT NULL,
  stop_id text NOT NULL,
  car_id text NOT NULL,
  observed_at timestamptz NOT NULL,
  sampled_at timestamptz,
  source text NOT NULL,
  timestamp_kind text NOT NULL,
  status text NOT NULL CHECK (status IN ('confirmed', 'pending', 'rejected')),
  reason text NOT NULL,
  details jsonb NOT NULL CHECK (jsonb_typeof(details) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS collection_approach_events_key_time_idx
  ON public.collection_approach_events (date, route_id, stop_id, car_id, observed_at DESC);

ALTER TABLE public.collection_approach_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.collection_approach_events ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.collection_approach_state FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.collection_approach_events FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.collection_approach_state FROM service_role;
REVOKE ALL ON TABLE public.collection_approach_events FROM service_role;
GRANT SELECT ON TABLE public.collection_approach_state TO service_role;
GRANT SELECT ON TABLE public.collection_approach_events TO service_role;
REVOKE ALL ON SEQUENCE public.collection_approach_events_id_seq FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.commit_collection_approach(
  p_key jsonb,
  p_expected_version bigint,
  p_state jsonb,
  p_event jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_date date;
  v_route_id text;
  v_stop_id text;
  v_car_id text;
  v_current_version bigint;
  v_next_version bigint;
  v_expires_at timestamptz;
BEGIN
  IF p_expected_version IS NULL OR p_expected_version < 0
     OR jsonb_typeof(p_key) IS DISTINCT FROM 'object'
     OR jsonb_typeof(p_state) IS DISTINCT FROM 'object'
     OR jsonb_typeof(p_event) IS DISTINCT FROM 'object'
     OR jsonb_typeof(p_key->'date') IS DISTINCT FROM 'string'
     OR jsonb_typeof(p_key->'routeId') IS DISTINCT FROM 'string'
     OR jsonb_typeof(p_key->'stopId') IS DISTINCT FROM 'string'
     OR jsonb_typeof(p_key->'carId') IS DISTINCT FROM 'string'
     OR jsonb_typeof(p_state->'expiresAt') IS DISTINCT FROM 'string'
     OR jsonb_typeof(p_event->'source') IS DISTINCT FROM 'string'
     OR jsonb_typeof(p_event->'timestampKind') IS DISTINCT FROM 'string'
     OR jsonb_typeof(p_event->'status') IS DISTINCT FROM 'string'
     OR jsonb_typeof(p_event->'reason') IS DISTINCT FROM 'string'
     OR NULLIF(p_key->>'date', '') IS NULL
     OR p_key->>'date' !~ '^\d{4}-\d{2}-\d{2}$'
     OR NULLIF(p_key->>'routeId', '') IS NULL
     OR NULLIF(p_key->>'stopId', '') IS NULL
     OR NULLIF(p_key->>'carId', '') IS NULL
     OR NULLIF(p_event->>'observedAt', '') IS NULL
     OR NULLIF(p_event->>'source', '') IS NULL
     OR NULLIF(p_event->>'timestampKind', '') IS NULL
     OR NULLIF(p_event->>'status', '') IS NULL
     OR NULLIF(p_event->>'reason', '') IS NULL THEN
    RETURN jsonb_build_object('applied', false, 'version', NULL);
  END IF;

  BEGIN
    v_date := (p_key->>'date')::date;
    v_expires_at := (p_state->>'expiresAt')::timestamptz;
  EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('applied', false, 'version', NULL);
  END;
  v_route_id := p_key->>'routeId';
  v_stop_id := p_key->>'stopId';
  v_car_id := p_key->>'carId';

  IF v_route_id <> '221010' OR v_stop_id <> '3' OR v_expires_at IS NULL
     OR jsonb_typeof(p_event->'observedAt') IS DISTINCT FROM 'string'
     OR (p_event->>'sampledAt' IS NOT NULL AND jsonb_typeof(p_event->'sampledAt') IS DISTINCT FROM 'string') THEN
    RETURN jsonb_build_object('applied', false, 'version', NULL);
  END IF;

  -- Serialize a key without inserting a placeholder row on a losing CAS.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_date::text || '|' || v_route_id || '|' || v_stop_id || '|' || v_car_id, 0)
  );

  SELECT s.version INTO v_current_version
  FROM public.collection_approach_state AS s
  WHERE s.date = v_date AND s.route_id = v_route_id
    AND s.stop_id = v_stop_id AND s.car_id = v_car_id;

  IF COALESCE(v_current_version, 0) <> p_expected_version THEN
    RETURN jsonb_build_object('applied', false, 'version', v_current_version);
  END IF;
  v_next_version := p_expected_version + 1;

  INSERT INTO public.collection_approach_state (date, route_id, stop_id, car_id, version, state, updated_at, expires_at)
  VALUES (v_date, v_route_id, v_stop_id, v_car_id, v_next_version, p_state, now(), v_expires_at)
  ON CONFLICT (date, route_id, stop_id, car_id) DO UPDATE
  SET version = EXCLUDED.version,
      state = EXCLUDED.state,
      updated_at = EXCLUDED.updated_at,
      expires_at = EXCLUDED.expires_at;

  INSERT INTO public.collection_approach_events
    (date, route_id, stop_id, car_id, observed_at, sampled_at, source, timestamp_kind, status, reason, details)
  VALUES
    (v_date, v_route_id, v_stop_id, v_car_id,
     (p_event->>'observedAt')::timestamptz,
     NULLIF(p_event->>'sampledAt', '')::timestamptz,
     p_event->>'source', p_event->>'timestampKind', p_event->>'status', p_event->>'reason', p_event);

  RETURN jsonb_build_object('applied', true, 'version', v_next_version);
END;
$function$;

REVOKE ALL ON FUNCTION public.commit_collection_approach(jsonb, bigint, jsonb, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.commit_collection_approach(jsonb, bigint, jsonb, jsonb) TO service_role;
