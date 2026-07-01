# Feedback Form Setup

The feedback page sends email to **gordon.lerman@gmail.com** via [Resend](https://resend.com).

## 1. Resend account

1. Sign up at [resend.com](https://resend.com) (free tier is enough).
2. Create an API key under **API Keys**.
3. For quick testing, Resend’s `onboarding@resend.dev` sender can deliver to the email you signed up with.

To send from your own domain later, verify a domain in Resend and set `FEEDBACK_FROM_EMAIL` (e.g. `Entertaining Fights <feedback@yourdomain.com>`).

## 2. Supabase secrets

```bash
supabase secrets set RESEND_API_KEY=re_xxxxxxxx
```

Optional overrides:

```bash
supabase secrets set FEEDBACK_TO_EMAIL=gordon.lerman@gmail.com
supabase secrets set FEEDBACK_FROM_EMAIL="Entertaining Fights <onboarding@resend.dev>"
```

## 3. Deploy the edge function

```bash
supabase functions deploy send-feedback --no-verify-jwt
```

`--no-verify-jwt` allows anonymous visitors to submit feedback without signing in.

## 4. Verify

1. Open `feedback.html` on your site.
2. Submit a test message.
3. Check gordon.lerman@gmail.com — **Reply** should go to the address the user entered.
