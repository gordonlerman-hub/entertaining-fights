import { SUPABASE_ANON_KEY, SUPABASE_URL } from "./config.js";
import { getCurrentUser, initAuth, onAuthChange } from "./auth.js";

const FUNCTION_URL = `${SUPABASE_URL}/functions/v1/send-feedback`;

const form = document.getElementById("feedback-form");
const emailInput = document.getElementById("feedback-email");
const messageInput = document.getElementById("feedback-message");
const statusEl = document.getElementById("feedback-status");
const submitBtn = document.getElementById("feedback-submit");

function prefillEmail() {
  const user = getCurrentUser();
  if (user?.email && !emailInput.value.trim()) {
    emailInput.value = user.email;
  }
}

function setStatus(message, type = "info") {
  statusEl.textContent = message;
  statusEl.classList.remove("hidden", "feedback-status--error", "feedback-status--success");
  if (type === "error") statusEl.classList.add("feedback-status--error");
  if (type === "success") statusEl.classList.add("feedback-status--success");
}

function clearStatus() {
  statusEl.textContent = "";
  statusEl.classList.add("hidden");
  statusEl.classList.remove("feedback-status--error", "feedback-status--success");
}

async function sendFeedback(payload) {
  const response = await fetch(FUNCTION_URL, {
    method: "POST",
    headers: {
      apikey: SUPABASE_ANON_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || `Request failed (${response.status})`);
  }
  return data;
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  clearStatus();

  const formData = new FormData(form);
  const type = formData.get("type");
  const email = String(formData.get("email") || "").trim();
  const message = String(formData.get("message") || "").trim();
  const website = String(formData.get("website") || "").trim();

  if (website) return;

  if (!email || !emailInput.checkValidity()) {
    setStatus("Please enter a valid email address.", "error");
    emailInput.focus();
    return;
  }

  if (!message) {
    setStatus("Please write a message before sending.", "error");
    messageInput.focus();
    return;
  }

  submitBtn.disabled = true;
  submitBtn.textContent = "Sending…";

  try {
    await sendFeedback({ type, email, message });
    form.reset();
    prefillEmail();
    setStatus("Thanks — your feedback was sent. I'll get back to you by email if needed.", "success");
  } catch (err) {
    console.error(err);
    setStatus(err.message || "Something went wrong. Please try again.", "error");
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = "Send feedback";
  }
});

async function bootstrap() {
  try {
    await initAuth();
    prefillEmail();
    onAuthChange(() => prefillEmail());
  } catch (err) {
    console.error(err);
  }
}

bootstrap();
