import { SUPABASE_ANON_KEY, SUPABASE_URL } from "./config.js";
import { getSupabase } from "./auth.js";

const FUNCTION_URL = `${SUPABASE_URL}/functions/v1/youtube-queue`;
const YT_ACCESS_KEY = "bf_youtube_provider_token";
const YT_REFRESH_KEY = "bf_youtube_provider_refresh_token";

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

const YOUTUBE_TITLE_MAX = 150;
const YOUTUBE_DESC_MAX = 5000;

function abbreviateFighter(name) {
  const parts = String(name).trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  const last = parts[parts.length - 1];
  if (last.length <= 3 && parts.length > 1) {
    return parts[parts.length - 2].replace(/\./g, "") || last;
  }
  return last;
}

function abbreviateMatchup(fight) {
  return `${abbreviateFighter(fight.fighter1)}/${abbreviateFighter(fight.fighter2)}`;
}

export function buildRunPlaylistTitle(runMinutes, fights) {
  const count = fights.length;
  const prefix = `${runMinutes}min · ${count} fight${count === 1 ? "" : "s"} · `;
  const matchups = fights.map(abbreviateMatchup).join(", ");
  const full = prefix + matchups;

  if (full.length <= YOUTUBE_TITLE_MAX) return full;

  const room = YOUTUBE_TITLE_MAX - prefix.length - 1;
  if (room < 8) return `${runMinutes}min · ${count} fight${count === 1 ? "" : "s"}`;
  return `${prefix}${matchups.slice(0, room)}…`;
}

export function buildRunPlaylistDescription(runMinutes, fights) {
  const lines = fights.map(
    (fight, index) =>
      `${index + 1}. ${fight.fighter1} vs ${fight.fighter2} (${fight.duration})`
  );
  const body = lines.join("\n");
  const header = `${runMinutes}-minute Best Fights cardio session · ${fights.length} in order\n\n`;
  const full = header + body;
  if (full.length <= YOUTUBE_DESC_MAX) return full;
  return full.slice(0, YOUTUBE_DESC_MAX - 1) + "…";
}

export function buildStackPlaylistTitle(fights) {
  const count = fights.length;
  const prefix = `${count} fight${count === 1 ? "" : "s"} · `;
  const matchups = fights.map(abbreviateMatchup).join(", ");
  const full = prefix + matchups;

  if (full.length <= YOUTUBE_TITLE_MAX) return full;

  const room = YOUTUBE_TITLE_MAX - prefix.length - 1;
  if (room < 8) return `${count} fight${count === 1 ? "" : "s"} queued`;
  return `${prefix}${matchups.slice(0, room)}…`;
}

export function buildStackPlaylistDescription(fights) {
  const lines = fights.map(
    (fight, index) =>
      `${index + 1}. ${fight.fighter1} vs ${fight.fighter2} (${fight.duration})`
  );
  const body = lines.join("\n");
  const header = `Best Fights watchlist · ${fights.length} in order\n\n`;
  const full = header + body;
  if (full.length <= YOUTUBE_DESC_MAX) return full;
  return full.slice(0, YOUTUBE_DESC_MAX - 1) + "…";
}

export function persistProviderTokens(session) {
  // Basic Google sign-in may include a provider_token without YouTube scope.
  // Only persist tokens from the YouTube consent flow (offline refresh token).
  if (!session?.provider_refresh_token) return;

  localStorage.setItem(YT_REFRESH_KEY, session.provider_refresh_token);
  if (session.provider_token) {
    localStorage.setItem(YT_ACCESS_KEY, session.provider_token);
  }
}

export function clearProviderTokens() {
  localStorage.removeItem(YT_ACCESS_KEY);
  localStorage.removeItem(YT_REFRESH_KEY);
}

async function getAuthedSession() {
  const supabase = getSupabase();
  if (!supabase) throw new Error("Auth is not initialized");

  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session?.access_token) {
    throw new Error("Sign in to queue fights on YouTube");
  }
  return session;
}

export function getGoogleCredentials(session) {
  const refreshToken =
    session?.provider_refresh_token || localStorage.getItem(YT_REFRESH_KEY) || null;
  const accessToken = session?.provider_token || localStorage.getItem(YT_ACCESS_KEY) || null;

  if (!refreshToken) {
    throw new Error("YouTube access not connected — queue a fight to grant playlist access");
  }

  return { accessToken, refreshToken };
}

export function hasYouTubeCredentials(session) {
  try {
    getGoogleCredentials(session);
    return true;
  } catch {
    return false;
  }
}

export function isYouTubeScopeError(message) {
  return /insufficient authentication scopes/i.test(message || "");
}

export function needsYouTubeConnect(message) {
  return (
    isYouTubeScopeError(message) ||
    /YouTube access not connected/i.test(message || "") ||
    /Missing YouTube access/i.test(message || "")
  );
}

function withGoogleCredentials(body, session) {
  const { accessToken, refreshToken } = getGoogleCredentials(session);
  return {
    ...body,
    ...(accessToken ? { googleAccessToken: accessToken } : {}),
    ...(refreshToken ? { googleRefreshToken: refreshToken } : {}),
  };
}

function withOptionalGoogleCredentials(body, session) {
  if (!hasYouTubeCredentials(session)) return body;
  return withGoogleCredentials(body, session);
}

async function callYouTubeFunction(body, { requireGoogle = true } = {}) {
  const session = await getAuthedSession();
  const payload = requireGoogle ? withOptionalGoogleCredentials(body, session) : body;

  const response = await fetch(FUNCTION_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${session.access_token}`,
      apikey: SUPABASE_ANON_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || `YouTube request failed (${response.status})`);
  }
  return data;
}

export async function fetchYouTubeStatus() {
  try {
    const data = await callYouTubeFunction({ action: "status" }, { requireGoogle: false });
    setYouTubeReady(Boolean(data.ready));
    return data;
  } catch {
    setYouTubeReady(false);
    return { ready: false, playlistId: null };
  }
}

export async function registerYouTube(session) {
  if (!hasYouTubeCredentials(session)) return fetchYouTubeStatus();

  const data = await callYouTubeFunction({
    action: "register",
  });
  setYouTubeReady(Boolean(data.ready));
  return data;
}

export async function syncYouTubeQueue(videoIds, { runMinutes, fights } = {}) {
  const payload = {
    action: "sync",
    videoIds,
  };

  if (runMinutes != null && Array.isArray(fights) && fights.length > 0) {
    payload.playlistTitle = buildRunPlaylistTitle(runMinutes, fights);
    payload.playlistDescription = buildRunPlaylistDescription(runMinutes, fights);
  } else if (Array.isArray(fights) && fights.length > 0) {
    payload.playlistTitle = buildStackPlaylistTitle(fights);
    payload.playlistDescription = buildStackPlaylistDescription(fights);
  }

  const data = await callYouTubeFunction(payload);
  setYouTubeReady(true);
  return data;
}

export async function appendToYouTubeQueue(videoIds, { fights } = {}) {
  const payload = {
    action: "append",
    videoIds,
  };

  if (Array.isArray(fights) && fights.length > 0) {
    payload.playlistTitle = buildStackPlaylistTitle(fights);
    payload.playlistDescription = buildStackPlaylistDescription(fights);
  }

  const data = await callYouTubeFunction(payload);
  setYouTubeReady(true);
  return data;
}

export async function clearYouTubeQueue() {
  const data = await callYouTubeFunction({
    action: "clear",
  });
  return data;
}
