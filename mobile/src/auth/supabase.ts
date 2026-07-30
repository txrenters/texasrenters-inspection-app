import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { sessionStorage } from './session-storage';

let client: SupabaseClient | undefined;

export function getSupabaseClient() {
  if (client) return client;
  const url = process.env.EXPO_PUBLIC_SUPABASE_URL?.trim();
  const anonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY?.trim();
  if (!url || !anonKey)
    throw new Error('API mode requires the public Supabase URL and anonymous key.');
  client = createClient(url, anonKey, {
    auth: {
      storage: sessionStorage,
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: false,
    },
  });
  return client;
}
