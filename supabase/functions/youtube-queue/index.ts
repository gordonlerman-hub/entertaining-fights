import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const DEFAULT_PLAYLIST_TITLE = "Best Fights Run";
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

function requireGoogleAccessToken(body: Record<string, unknown>): string {
  const token = body.googleAccessToken;
  if (typeof token !== "string" || !token.trim()) {
    throw new Error("Missing YouTube access — sign out and sign in with Google again");
  }
  return token;
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
  description = "Queued from Best Fights treadmill watchlist"
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
      const accessToken = requireGoogleAccessToken(body);
      const playlistId = await ensurePlaylistId(supabase, user.id, accessToken);
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

      const accessToken = requireGoogleAccessToken(body);
      const playlistTitle =
        typeof body.playlistTitle === "string" && body.playlistTitle.trim()
          ? body.playlistTitle.trim()
          : DEFAULT_PLAYLIST_TITLE;
      const playlistDescription =
        typeof body.playlistDescription === "string" && body.playlistDescription.trim()
          ? body.playlistDescription.trim()
          : "Queued from Best Fights treadmill watchlist";

      const playlistId = await ensurePlaylistId(
        supabase,
        user.id,
        accessToken,
        playlistTitle,
        playlistDescription
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
