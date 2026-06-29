const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const FEEDBACK_TO_EMAIL = "gordon.lerman@gmail.com";
const MAX_MESSAGE_LENGTH = 5000;

type FeedbackType = "general" | "bug";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function typeLabel(type: FeedbackType): string {
  return type === "bug" ? "Bug report" : "General feedback";
}

async function sendWithResend(
  apiKey: string,
  fromEmail: string,
  toEmail: string,
  subject: string,
  html: string,
  text: string,
  replyTo: string
) {
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: fromEmail,
      to: [toEmail],
      reply_to: replyTo,
      subject,
      html,
      text,
      headers: {
        "Reply-To": replyTo,
      },
    }),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message =
      typeof data.message === "string"
        ? data.message
        : typeof data.error === "string"
          ? data.error
          : "Failed to send email";
    throw new Error(message);
  }

  return data;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  try {
    const body = await req.json();
    const website = typeof body.website === "string" ? body.website.trim() : "";
    if (website) {
      return jsonResponse({ ok: true });
    }

    const type = body.type as FeedbackType;
    const email = typeof body.email === "string" ? body.email.trim() : "";
    const message = typeof body.message === "string" ? body.message.trim() : "";

    if (type !== "general" && type !== "bug") {
      return jsonResponse({ error: "Choose general feedback or a bug report" }, 400);
    }

    if (!email || !isValidEmail(email)) {
      return jsonResponse({ error: "A valid email address is required" }, 400);
    }

    if (!message) {
      return jsonResponse({ error: "Message is required" }, 400);
    }

    if (message.length > MAX_MESSAGE_LENGTH) {
      return jsonResponse({ error: `Message must be under ${MAX_MESSAGE_LENGTH} characters` }, 400);
    }

    const resendApiKey = Deno.env.get("RESEND_API_KEY");
    if (!resendApiKey) {
      return jsonResponse({ error: "Feedback email is not configured yet" }, 500);
    }

    const fromEmail = Deno.env.get("FEEDBACK_FROM_EMAIL") || "Best Fights <onboarding@resend.dev>";
    const toEmail = Deno.env.get("FEEDBACK_TO_EMAIL") || FEEDBACK_TO_EMAIL;
    const subject = `[Best Fights] ${typeLabel(type)} from ${email}`;
    const html = `
      <p><strong>Type:</strong> ${escapeHtml(typeLabel(type))}</p>
      <p><strong>From:</strong> <a href="mailto:${escapeHtml(email)}">${escapeHtml(email)}</a></p>
      <p><em>Hit Reply in your mail app to respond directly to this person.</em></p>
      <hr>
      <p style="white-space: pre-wrap;">${escapeHtml(message)}</p>
    `;
    const text = [
      `Type: ${typeLabel(type)}`,
      `From: ${email}`,
      "",
      "Reply to this email to respond directly to the sender.",
      "",
      message,
    ].join("\n");

    await sendWithResend(resendApiKey, fromEmail, toEmail, subject, html, text, email);

    return jsonResponse({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unexpected error";
    console.error("send-feedback error:", message);
    return jsonResponse({ error: message }, 500);
  }
});
