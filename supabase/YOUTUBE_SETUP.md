# YouTube Queue Setup

One-time configuration to enable **Queue on YouTube**.

## Google Cloud Console

Use the **same OAuth client** configured for Supabase Google sign-in.

1. Open [Google Cloud Console](https://console.cloud.google.com/) → your project.
2. **APIs & Services → Library** → enable **YouTube Data API v3**.
3. **OAuth consent screen** → add scope:
   `https://www.googleapis.com/auth/youtube.force-ssl`
4. Set **Application home page** to `https://entertainingfights.com/` and **Privacy policy** to `https://entertainingfights.com/privacy.html`. Add `entertainingfights.com` under **Authorized domains**.
5. If the app is in **Testing**, add your Google account as a test user.

## Supabase

1. Apply migrations (includes `user_youtube` table):
   ```bash
   supabase db push
   ```
2. Set edge function secrets (same Google OAuth client as Supabase sign-in):
   ```bash
   supabase secrets set GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
   supabase secrets set GOOGLE_CLIENT_SECRET=your-client-secret
   ```
3. Deploy the edge function:
   ```bash
   supabase functions deploy youtube-queue
   ```

The edge function stores each user's Google refresh token so queueing still works after the Supabase session refreshes and `provider_token` disappears from the browser session.

## Re-sign in

Sign out and sign in again so Google grants YouTube playlist access (`prompt: consent`).

## Verify

1. Set a run time → choose a pick → **Queue on YouTube**
2. Tap **Open in YouTube ↗**
3. In [YouTube Studio](https://studio.youtube.com/) → Playlists, confirm **Best Fights Run** exists (private)
