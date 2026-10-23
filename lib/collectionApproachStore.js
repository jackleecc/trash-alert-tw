import { supabase } from './supabaseClient.js';

export function createSupabaseCollectionApproachStore(client = supabase) {
  return {
    async read(key) {
      let query = client
        .from('collection_approach_state')
        .select('version, state')
        .eq('date', key.date)
        .eq('route_id', key.routeId)
        .eq('stop_id', key.stopId)
        .eq('car_id', key.carId);
      const { data, error } = await query.maybeSingle();
      if (error) throw error;
      if (!data) return null;
      const version = Number(data.version);
      if (!Number.isSafeInteger(version) || version < 1 || !data.state || typeof data.state !== 'object' || Array.isArray(data.state)) {
        throw new Error('collection approach store returned malformed state row');
      }
      return { version, state: data.state };
    },

    async commit({ key, expectedVersion, nextState, event }) {
      const { data, error } = await client.rpc('commit_collection_approach', {
        p_key: key,
        p_expected_version: expectedVersion,
        p_state: nextState,
        p_event: event,
      });
      if (error) throw error;
      return data;
    },
  };
}

export const supabaseCollectionApproachStore = createSupabaseCollectionApproachStore();
