import { createClient } from '@supabase/supabase-js';
import { config } from './config.js';

// Cliente com service role: roda SO no servidor (container). Bypassa RLS.
// Nunca exponha esta chave no frontend.
export const supabase = createClient(
  config.supabase.url,
  config.supabase.serviceRoleKey,
  {
    auth: { persistSession: false, autoRefreshToken: false },
  },
);
