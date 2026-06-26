# YouTube Queue Setup

One-time configuration to enable **Queue on YouTube** (private playlist sync).

## 1. Google Cloud Console

Use the **same OAuth client** already configured for Supabase Google sign-in.

1. Open [Google Cloud Console](https://console.cloud.google.com/) → your project.
2. **APIs & Services → Library** → enable **YouTube Data API v3**.
3. **APIs & Services → OAuth consent screen**
   - Add scope: `https://www.googleapis.com/auth/youtube.force-ssl`
   - If the app is in Testing, add test users who will queue fights.
4. **APIs & Services → Credentials** → your OAuth 2.0 Web client
   - Note the **Client ID** and **Client secret** (needed for the edge function).

No redirect URI changes are required if Supabase Google auth already works.

## 2. Supabase Dashboard

1. **Authentication → Providers → Google** — leave enabled (scopes are requested from the app).
2. Apply the database migration:
   ```bash
   supabase db push
   ```
   Or run `supabase/migrations/*_create_user_youtube.sql` in the SQL editor.
3. Deploy the edge function:
   ```bash
   supabase functions deploy youtube-queue
   ```
4. Set edge function secrets:
   ```bash
   supabase secrets set \
     GOOGLE_OAUTH_CLIENT_ID="your-client-id" \
     GOOGLE_OAUTH_CLIENT_SECRET="your-client-secret" \
     YOUTUBE_TOKEN_ENCRYPTION_KEY="$(openssl rand -hex 32)"
   ```

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are provided automatically to edge functions.

## 3. Re-sign in

Existing users must sign out and sign in again so Google grants YouTube playlist access (`prompt: consent` + offline refresh token).

## 4. Verify

1. Sign in → auth bar shows **YouTube ready**.
2. Set a run time → pick a recommendation → **Queue on YouTube**.
3. Tap **Open in YouTube** — first fight plays; playlist continues in order.
4. In [YouTube Studio](https://studio.youtube.com/) → Playlists, confirm **Best Fights Run** exists (private).

## Quota

Each queue sync uses a small number of YouTube Data API units (list + delete + insert per video). Default daily quota (10,000 units) is plenty for personal treadmill use.
