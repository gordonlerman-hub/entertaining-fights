-- Playlist-only mode: Google access token comes from the client session per request.
ALTER TABLE public.user_youtube
  ALTER COLUMN refresh_token_encrypted DROP NOT NULL;
