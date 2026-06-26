import { SUPABASE_ANON_KEY, SUPABASE_URL } from "./config.js";
import { getSupabase } from "./auth.js";

const FUNCTION_URL = `${SUPABASE_URL}/functions/v1/youtube-queue`;

let youtubeReady = false;
const readyListeners = new Set();

export function isYouTubeReady() {
  return youtubeReady;
}

export function onYouTubeReadyChange(listener) {
  readyListeners.add(listener);
  listener(youtubeReady);
  return () => readyListeners.delete(listener);
}

function notifyReadyChange() {
  readyListeners.forEach((listener) => listener(youtubeReady));
}

export function setYouTubeReady(ready) {
  youtubeReady = ready;
  notifyReadyChange();
}

export function extractYouTubeVideoId(url) {
  if (!url || typeof url !== "string") return null;
  if (url.includes("youtube.com/results") || url.includes("/results?")) return null;

  try {
    const parsed = new URL(url);
    if (parsed.hostname === "youtu.be") {
      const id = parsed.pathname.slice(1).split("/")[0];
      return id && id.length === 11 ? id : null;
    }
    if (parsed.pathname.startsWith("/embed/")) {
      const id = parsed.pathname.split("/")[2];
      return id && id.length === 11 ? id : null;
    }
    const v = parsed.searchParams.get("v");
    if (v && v.length === 11) return v;
  } catch {
    // fall through to regex
  }

  const match = url.match(/(?:v=|\/embed\/|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
  return match?.[1] ?? null;
}

export function fightsToVideoIds(fights) {
  const missing = [];
  const videoIds = [];

  for (const fight of fights) {
    const id = extractYouTubeVideoId(fight.watchUrl);
    if (!id) {
      missing.push(fight);
    } else {
      videoIds.push(id);
    }
  }

  return { videoIds, missing };
}

async function callYouTubeFunction(body) {
  const supabase = getSupabase();
  if (!supabase) throw new Error("Auth is not initialized");

  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session?.access_token) {
    throw new Error("Sign in to queue fights on YouTube");
  }

  const response = await fetch(FUNCTION_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${session.access_token}`,
      apikey: SUPABASE_ANON_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || `YouTube request failed (${response.status})`);
  }
  return data;
}

export async function fetchYouTubeStatus() {
  try {
    const data = await callYouTubeFunction({ action: "status" });
    setYouTubeReady(Boolean(data.ready));
    return data;
  } catch {
    setYouTubeReady(false);
    return { ready: false, playlistId: null };
  }
}

export async function registerYouTube(session) {
  const refreshToken = session?.provider_refresh_token;
  if (!refreshToken) return fetchYouTubeStatus();

  const data = await callYouTubeFunction({
    action: "register",
    refreshToken,
  });
  setYouTubeReady(Boolean(data.ready));
  return data;
}

export async function syncYouTubeQueue(videoIds) {
  const data = await callYouTubeFunction({ action: "sync", videoIds });
  setYouTubeReady(true);
  return data;
}
