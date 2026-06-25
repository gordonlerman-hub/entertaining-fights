-- Watched fights synced per authenticated user
CREATE TABLE IF NOT EXISTS public.watched_fights (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  fight_id text NOT NULL,
  watched_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, fight_id)
);

ALTER TABLE public.watched_fights ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own watched fights"
  ON public.watched_fights
  FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own watched fights"
  ON public.watched_fights
  FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete own watched fights"
  ON public.watched_fights
  FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS watched_fights_user_id_idx ON public.watched_fights (user_id);
