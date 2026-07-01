import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const DEFAULT_PLAYLIST_TITLE = "Best Fights Cardio";
const MAX_VIDEOS = 10;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

type Action = "register" | "sync" | "append" | "clear" | "status";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}


async function refreshGoogleAccessToken(refreshToken: string): Promise<string> {
  const clientId = Deno.env.get("GOOGLE_CLIENT_ID");
  const clientSecret = Deno.env.get("GOOGLE_CLIENT_SECRET");
  if (!clientId || !clientSecret) {
    throw new Error(
      "YouTube token refresh is not configured — sign out and sign in with Google again"
    );
  }

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
    }),
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(
      data.error_description ||
        data.error ||
        "Could not refresh YouTube access — sign out and sign in with Google again"
    );
  }
  if (typeof data.access_token !== "string" || !data.access_token.trim()) {
    throw new Error("Could not refresh YouTube access — sign out and sign in with Google again");
  }
  return data.access_token;
}

async function storeRefreshToken(
  supabase: ReturnType<typeof createClient>,
  userId: string,
  refreshToken: string
) {
  const { error } = await supabase.from("user_youtube").upsert(
    {
      user_id: userId,
      refresh_token_encrypted: refreshToken,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id" }
  );
  if (error) throw new Error(error.message);
}

async function resolveGoogleAccessToken(
  supabase: ReturnType<typeof createClient>,
  userId: string,
  body: Record<string, unknown>
): Promise<string> {
  const inlineAccess =
    typeof body.googleAccessToken === "string" ? body.googleAccessToken.trim() : "";
  if (inlineAccess) return inlineAccess;

  const inlineRefresh =
    typeof body.googleRefreshToken === "string" ? body.googleRefreshToken.trim() : "";
  if (inlineRefresh) {
    const accessToken = await refreshGoogleAccessToken(inlineRefresh);
    await storeRefreshToken(supabase, userId, inlineRefresh);
    return accessToken;
  }

  const { data } = await supabase
    .from("user_youtube")
    .select("refresh_token_encrypted")
    .eq("user_id", userId)
    .maybeSingle();

  const storedRefresh = data?.refresh_token_encrypted;
  if (typeof storedRefresh === "string" && storedRefresh.trim()) {
    return await refreshGoogleAccessToken(storedRefresh.trim());
  }

  throw new Error("Missing YouTube access — sign out and sign in with Google again");
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

async function updatePlaylist(
  accessToken: string,
  playlistId: string,
  title: string,
  description: string
) {
  const response = await youtubeFetch(accessToken, "/playlists?part=snippet", {
    method: "PUT",
    body: JSON.stringify({
      id: playlistId,
      snippet: {
        title: title.slice(0, 150),
        description: description.slice(0, 5000),
      },
    }),
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error?.message || "Failed to rename YouTube playlist");
  }
}

async function createPlaylist(
  accessToken: string,
  title: string,
  description: string
): Promise<string> {
  const response = await youtubeFetch(accessToken, "/playlists?part=snippet,status", {
    method: "POST",
    body: JSON.stringify({
      snippet: {
        title: title.slice(0, 150),
        description: description.slice(0, 5000),
      },
      status: { privacyStatus: "private" },
    }),
  });
  const data = await response.json();
  if (!response.ok) {
    const reason = data.error?.errors?.[0]?.reason;
    if (reason === "insufficientPermissions" || response.status === 403) {
      throw new Error(
        "YouTube permission denied — sign out, sign in again, and allow playlist access"
      );
    }
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

async function getPlaylistVideoIds(accessToken: string, playlistId: string): Promise<string[]> {
  const videoIds: string[] = [];
  let pageToken: string | undefined;

  do {
    const params = new URLSearchParams({
      part: "snippet",
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
      const videoId = item.snippet?.resourceId?.videoId;
      if (videoId) videoIds.push(videoId);
    }

    pageToken = listData.nextPageToken;
  } while (pageToken);

  return videoIds;
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

async function ensurePlaylistId(
  supabase: ReturnType<typeof createClient>,
  userId: string,
  accessToken: string,
  title = DEFAULT_PLAYLIST_TITLE,
  description = "Queued from Best Fights cardio watchlist",
  refreshToken?: string | null
): Promise<string> {
  const { data: existing } = await supabase
    .from("user_youtube")
    .select("playlist_id")
    .eq("user_id", userId)
    .maybeSingle();

  let playlistId = existing?.playlist_id ?? null;
  if (!playlistId) {
    playlistId = await createPlaylist(accessToken, title, description);
    const { error: upsertError } = await supabase.from("user_youtube").upsert(
      {
        user_id: userId,
        playlist_id: playlistId,
        ...(refreshToken ? { refresh_token_encrypted: refreshToken } : {}),
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id" }
    );
    if (upsertError) throw new Error(upsertError.message);
  }

  return playlistId;
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

    if (!supabaseUrl || !serviceRoleKey) {
      return jsonResponse({ error: "Supabase is not configured" }, 500);
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
      const accessToken = await resolveGoogleAccessToken(supabase, user.id, body);
      const refreshToken =
        typeof body.googleRefreshToken === "string" ? body.googleRefreshToken.trim() : "";
      if (refreshToken) {
        await storeRefreshToken(supabase, user.id, refreshToken);
      }
      const playlistId = await ensurePlaylistId(
        supabase,
        user.id,
        accessToken,
        DEFAULT_PLAYLIST_TITLE,
        "Queued from Best Fights cardio watchlist",
        refreshToken || null
      );
      return jsonResponse({ playlistId, ready: true });
    }

    if (action === "clear") {
      const accessToken = await resolveGoogleAccessToken(supabase, user.id, body);
      const { data } = await supabase
        .from("user_youtube")
        .select("playlist_id")
        .eq("user_id", user.id)
        .maybeSingle();

      if (data?.playlist_id) {
        await clearPlaylist(accessToken, data.playlist_id);
        await updatePlaylist(
          accessToken,
          data.playlist_id,
          DEFAULT_PLAYLIST_TITLE,
          "Queued from Best Fights"
        );
      }

      return jsonResponse({ cleared: true });
    }

    if (action === "append") {
      const videoIds = body.videoIds as string[] | undefined;
      if (!Array.isArray(videoIds) || videoIds.length === 0) {
        return jsonResponse({ error: "No videos to queue" }, 400);
      }

      const accessToken = await resolveGoogleAccessToken(supabase, user.id, body);
      const playlistTitle =
        typeof body.playlistTitle === "string" && body.playlistTitle.trim()
          ? body.playlistTitle.trim()
          : DEFAULT_PLAYLIST_TITLE;
      const playlistDescription =
        typeof body.playlistDescription === "string" && body.playlistDescription.trim()
          ? body.playlistDescription.trim()
          : "Queued from Best Fights";

      const refreshToken =
        typeof body.googleRefreshToken === "string" ? body.googleRefreshToken.trim() : "";
      if (refreshToken) {
        await storeRefreshToken(supabase, user.id, refreshToken);
      }

      const playlistId = await ensurePlaylistId(
        supabase,
        user.id,
        accessToken,
        playlistTitle,
        playlistDescription,
        refreshToken || null
      );

      const existingIds = await getPlaylistVideoIds(accessToken, playlistId);
      if (existingIds.length + videoIds.length > MAX_VIDEOS) {
        return jsonResponse(
          {
            error: `Queue full — maximum ${MAX_VIDEOS} videos (${existingIds.length} already queued)`,
          },
          400
        );
      }

      await updatePlaylist(accessToken, playlistId, playlistTitle, playlistDescription);
      await addVideosToPlaylist(accessToken, playlistId, videoIds);

      const allIds = [...existingIds, ...videoIds];
      const firstVideoId = allIds[0];
      return jsonResponse({
        playlistId,
        firstVideoId,
        openUrl: buildOpenUrl(playlistId, firstVideoId),
        playlistTitle,
        queueLength: allIds.length,
      });
    }

    if (action === "sync") {
      const videoIds = body.videoIds as string[] | undefined;
      if (!Array.isArray(videoIds) || videoIds.length === 0) {
        return jsonResponse({ error: "No videos to queue" }, 400);
      }
      if (videoIds.length > MAX_VIDEOS) {
        return jsonResponse({ error: `Maximum ${MAX_VIDEOS} videos per queue` }, 400);
      }

      const accessToken = await resolveGoogleAccessToken(supabase, user.id, body);
      const playlistTitle =
        typeof body.playlistTitle === "string" && body.playlistTitle.trim()
          ? body.playlistTitle.trim()
          : DEFAULT_PLAYLIST_TITLE;
      const playlistDescription =
        typeof body.playlistDescription === "string" && body.playlistDescription.trim()
          ? body.playlistDescription.trim()
          : "Queued from Best Fights cardio watchlist";

      const refreshToken =
        typeof body.googleRefreshToken === "string" ? body.googleRefreshToken.trim() : "";
      if (refreshToken) {
        await storeRefreshToken(supabase, user.id, refreshToken);
      }

      const playlistId = await ensurePlaylistId(
        supabase,
        user.id,
        accessToken,
        playlistTitle,
        playlistDescription,
        refreshToken || null
      );

      await updatePlaylist(accessToken, playlistId, playlistTitle, playlistDescription);
      await clearPlaylist(accessToken, playlistId);
      await addVideosToPlaylist(accessToken, playlistId, videoIds);

      const firstVideoId = videoIds[0];
      return jsonResponse({
        playlistId,
        firstVideoId,
        openUrl: buildOpenUrl(playlistId, firstVideoId),
        playlistTitle,
      });
    }

    return jsonResponse({ error: "Unknown action" }, 400);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unexpected error";
    console.error("youtube-queue error:", message);
    return jsonResponse({ error: message }, 500);
  }
});
