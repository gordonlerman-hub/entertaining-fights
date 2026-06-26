-- YouTube playlist credentials per authenticated user (server-side only via edge function)
CREATE TABLE IF NOT EXISTS public.user_youtube (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  playlist_id text,
  refresh_token_encrypted text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.user_youtube ENABLE ROW LEVEL SECURITY;

-- No client policies: only the service role (edge function) reads/writes this table.
