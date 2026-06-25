import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.js";

let supabase = null;
let currentUser = null;
const authListeners = new Set();

export function getSupabase() {
  return supabase;
}

export function getCurrentUser() {
  return currentUser;
}

export function isSignedIn() {
  return currentUser != null;
}

export function onAuthChange(listener) {
  authListeners.add(listener);
  return () => authListeners.delete(listener);
}

function notifyAuthChange() {
  authListeners.forEach((listener) => listener(currentUser));
}

export async function initAuth() {
  supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
  });

  const {
    data: { session },
  } = await supabase.auth.getSession();
  currentUser = session?.user ?? null;

  supabase.auth.onAuthStateChange((_event, session) => {
    currentUser = session?.user ?? null;
    notifyAuthChange();
  });
}

export async function signInWithGoogle() {
  const { error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    options: {
      redirectTo: window.location.origin + window.location.pathname,
    },
  });
  if (error) throw error;
}

export async function signOut() {
  const { error } = await supabase.auth.signOut();
  if (error) throw error;
}

export function getUserLabel(user = currentUser) {
  if (!user) return "";
  return user.user_metadata?.full_name || user.email?.split("@")[0] || "Signed in";
}

export function getUserAvatar(user = currentUser) {
  return user?.user_metadata?.avatar_url || "";
}
