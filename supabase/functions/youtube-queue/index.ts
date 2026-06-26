import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const PLAYLIST_TITLE = "Best Fights Run";
const MAX_VIDEOS = 10;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

type Action = "register" | "sync" | "status";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function hexToBytes(hex: string): Uint8Array {
  const normalized = hex.trim();
  if (normalized.length % 2 !== 0) {
    throw new Error("Invalid encryption key length");
  }
  const bytes = new Uint8Array(normalized.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(normalized.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function importAesKey(hexKey: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", hexToBytes(hexKey), { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

async function encryptToken(plaintext: string, hexKey: string): Promise<string> {
  const key = await importAesKey(hexKey);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(plaintext)
  );
  return `${bytesToBase64(iv)}.${bytesToBase64(new Uint8Array(cipher))}`;
}

async function decryptToken(payload: string, hexKey: string): Promise<string> {
  const [ivB64, cipherB64] = payload.split(".");
  if (!ivB64 || !cipherB64) throw new Error("Invalid encrypted token format");
  const key = await importAesKey(hexKey);
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64ToBytes(ivB64) },
    key,
    base64ToBytes(cipherB64)
  );
  return new TextDecoder().decode(plain);
}

async function refreshGoogleAccessToken(refreshToken: string): Promise<string> {
  const clientId = Deno.env.get("GOOGLE_OAUTH_CLIENT_ID");
  const clientSecret = Deno.env.get("GOOGLE_OAUTH_CLIENT_SECRET");
  if (!clientId || !clientSecret) {
    throw new Error("YouTube OAuth is not configured on the server");
  }

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error_description || data.error || "Failed to refresh Google token");
  }
  if (!data.access_token) {
    throw new Error("No access token returned from Google");
  }
  return data.access_token;
}

async function youtubeFetch(
  accessToken: string,
  path: string,
  options: RequestInit = {}
): Promise<Response> {
  const url = path.startsWith("http") ? path : `https://www.googleapis.com/youtube/v3${path}`;
  return fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
}

async function createPlaylist(accessToken: string): Promise<string> {
  const response = await youtubeFetch(accessToken, "/playlists?part=snippet,status", {
    method: "POST",
    body: JSON.stringify({
      snippet: {
        title: PLAYLIST_TITLE,
        description: "Fight queue from Best Fights treadmill watchlist",
      },
      status: { privacyStatus: "private" },
    }),
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error?.message || "Failed to create YouTube playlist");
  }
  return data.id as string;
}

async function clearPlaylist(accessToken: string, playlistId: string) {
  let pageToken: string | undefined;
  do {
    const params = new URLSearchParams({
      part: "id",
      playlistId,
      maxResults: "50",
    });
    if (pageToken) params.set("pageToken", pageToken);

    const listResponse = await youtubeFetch(accessToken, `/playlistItems?${params}`);
    const listData = await listResponse.json();
    if (!listResponse.ok) {
      throw new Error(listData.error?.message || "Failed to list playlist items");
    }

    for (const item of listData.items || []) {
      const deleteResponse = await youtubeFetch(
        accessToken,
        `/playlistItems?id=${encodeURIComponent(item.id)}`,
        { method: "DELETE" }
      );
      if (!deleteResponse.ok && deleteResponse.status !== 204) {
        const deleteData = await deleteResponse.json().catch(() => ({}));
        throw new Error(deleteData.error?.message || "Failed to remove playlist item");
      }
    }

    pageToken = listData.nextPageToken;
  } while (pageToken);
}

async function addVideosToPlaylist(
  accessToken: string,
  playlistId: string,
  videoIds: string[]
) {
  for (const videoId of videoIds) {
    const response = await youtubeFetch(accessToken, "/playlistItems?part=snippet", {
      method: "POST",
      body: JSON.stringify({
        snippet: {
          playlistId,
          resourceId: { kind: "youtube#video", videoId },
        },
      }),
    });
    const data = await response.json();
    if (!response.ok) {
      const message = data.error?.message || "Failed to add video to playlist";
      if (data.error?.errors?.[0]?.reason === "videoNotFound") {
        throw new Error(`Video unavailable (${videoId}) — try another pick`);
      }
      throw new Error(message);
    }
  }
}

function buildOpenUrl(playlistId: string, firstVideoId: string) {
  return `https://www.youtube.com/watch?v=${firstVideoId}&list=${playlistId}`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const encryptionKey = Deno.env.get("YOUTUBE_TOKEN_ENCRYPTION_KEY");

    if (!supabaseUrl || !serviceRoleKey) {
      return jsonResponse({ error: "Supabase is not configured" }, 500);
    }
    if (!encryptionKey) {
      return jsonResponse({ error: "YouTube encryption is not configured" }, 500);
    }

    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return jsonResponse({ error: "Missing authorization" }, 401);
    }

    const jwt = authHeader.slice(7);
    const supabase = createClient(supabaseUrl, serviceRoleKey);
    const {
      data: { user },
      error: userError,
    } = await supabase.auth.getUser(jwt);

    if (userError || !user) {
      return jsonResponse({ error: "Invalid session" }, 401);
    }

    const body = await req.json();
    const action = body.action as Action;

    if (action === "status") {
      const { data } = await supabase
        .from("user_youtube")
        .select("playlist_id")
        .eq("user_id", user.id)
        .maybeSingle();

      return jsonResponse({
        ready: Boolean(data?.playlist_id),
        playlistId: data?.playlist_id ?? null,
      });
    }

    if (action === "register") {
      const refreshToken = body.refreshToken as string | undefined;
      if (!refreshToken) {
        return jsonResponse({ error: "Missing refresh token — sign in again with Google" }, 400);
      }

      const encrypted = await encryptToken(refreshToken, encryptionKey);
      const accessToken = await refreshGoogleAccessToken(refreshToken);

      const { data: existing } = await supabase
        .from("user_youtube")
        .select("playlist_id")
        .eq("user_id", user.id)
        .maybeSingle();

      let playlistId = existing?.playlist_id ?? null;
      if (!playlistId) {
        playlistId = await createPlaylist(accessToken);
      }

      const { error: upsertError } = await supabase.from("user_youtube").upsert(
        {
          user_id: user.id,
          playlist_id: playlistId,
          refresh_token_encrypted: encrypted,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "user_id" }
      );

      if (upsertError) {
        throw new Error(upsertError.message);
      }

      return jsonResponse({ playlistId, ready: true });
    }

    if (action === "sync") {
      const videoIds = body.videoIds as string[] | undefined;
      if (!Array.isArray(videoIds) || videoIds.length === 0) {
        return jsonResponse({ error: "No videos to queue" }, 400);
      }
      if (videoIds.length > MAX_VIDEOS) {
        return jsonResponse({ error: `Maximum ${MAX_VIDEOS} videos per queue` }, 400);
      }

      const { data: row, error: rowError } = await supabase
        .from("user_youtube")
        .select("playlist_id, refresh_token_encrypted")
        .eq("user_id", user.id)
        .maybeSingle();

      if (rowError) throw new Error(rowError.message);
      if (!row?.refresh_token_encrypted) {
        return jsonResponse(
          { error: "YouTube not connected — sign out and sign in again" },
          400
        );
      }

      const refreshToken = await decryptToken(row.refresh_token_encrypted, encryptionKey);
      const accessToken = await refreshGoogleAccessToken(refreshToken);

      let playlistId = row.playlist_id;
      if (!playlistId) {
        playlistId = await createPlaylist(accessToken);
        await supabase
          .from("user_youtube")
          .update({ playlist_id: playlistId, updated_at: new Date().toISOString() })
          .eq("user_id", user.id);
      }

      await clearPlaylist(accessToken, playlistId);
      await addVideosToPlaylist(accessToken, playlistId, videoIds);

      const firstVideoId = videoIds[0];
      return jsonResponse({
        playlistId,
        firstVideoId,
        openUrl: buildOpenUrl(playlistId, firstVideoId),
      });
    }

    return jsonResponse({ error: "Unknown action" }, 400);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unexpected error";
    console.error("youtube-queue error:", message);
    return jsonResponse({ error: message }, 500);
  }
});
