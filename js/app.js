import {
  getCurrentUser,
  getSupabase,
  getUserAvatar,
  getUserLabel,
  initAuth,
  isSignedIn,
  onAuthChange,
  signInWithGoogle,
  signOut,
} from "./auth.js";

const SPORT_LABELS = {
  boxing: "Boxing",
  mma: "MMA",
  kickboxing: "Kickboxing",
  "muay thai": "Muay Thai",
};

const SPORT_ORDER = ["boxing", "mma", "kickboxing", "muay thai"];

const RUN_TOLERANCE_MIN = 5;
const RUN_PICKS_SHOWN = 3;
const WATCHED_STORAGE_KEY = "bestFightsWatched";

const elements = {
  authBar: document.getElementById("auth-bar"),
  grid: document.getElementById("fight-grid"),
  stats: document.getElementById("stats"),
  resultsCount: document.getElementById("results-count"),
  emptyState: document.getElementById("empty-state"),
  runRecommendations: document.getElementById("run-recommendations"),
  watchedProgress: document.getElementById("watched-progress"),
  hideWatched: document.getElementById("hide-watched"),
  resetWatched: document.getElementById("reset-watched"),
  search: document.getElementById("search"),
  sport: document.getElementById("sport"),
  duration: document.getElementById("duration"),
  ending: document.getElementById("ending"),
  sort: document.getElementById("sort"),
  reset: document.getElementById("reset"),
  runTime: document.getElementById("run-time"),
  runFind: document.getElementById("run-find"),
  clearRun: document.getElementById("clear-run"),
  runRefresh: document.getElementById("run-refresh"),
  runPresets: document.querySelectorAll(".run-preset"),
};

let allFights = [];
let activeRunMinutes = null;
let runPickIds = new Set();
let runRefreshSeed = 0;
let currentRunRec = null;
let watchedIds = new Set();
let statFilter = { watched: "all" };

function loadLocalWatchedIds() {
  try {
    const raw = localStorage.getItem(WATCHED_STORAGE_KEY);
    if (!raw) return new Set();
    const ids = JSON.parse(raw);
    return new Set(Array.isArray(ids) ? ids : []);
  } catch {
    return new Set();
  }
}

function saveLocalWatchedIds() {
  localStorage.setItem(WATCHED_STORAGE_KEY, JSON.stringify([...watchedIds]));
}

function clearLocalWatchedIds() {
  localStorage.removeItem(WATCHED_STORAGE_KEY);
}

async function fetchRemoteWatchedIds() {
  const supabase = getSupabase();
  const user = getCurrentUser();
  if (!supabase || !user) return new Set();

  const { data, error } = await supabase.from("watched_fights").select("fight_id");
  if (error) throw error;
  return new Set((data || []).map((row) => row.fight_id));
}

async function mergeLocalWatchedIntoRemote() {
  const supabase = getSupabase();
  const user = getCurrentUser();
  if (!supabase || !user) return;

  const localIds = loadLocalWatchedIds();
  if (localIds.size === 0) return;

  const rows = [...localIds].map((fightId) => ({
    user_id: user.id,
    fight_id: fightId,
  }));

  const { error } = await supabase.from("watched_fights").upsert(rows, {
    onConflict: "user_id,fight_id",
    ignoreDuplicates: true,
  });
  if (error) throw error;
  clearLocalWatchedIds();
}

async function loadWatchedIds() {
  if (isSignedIn()) {
    await mergeLocalWatchedIntoRemote();
    watchedIds = await fetchRemoteWatchedIds();
    return;
  }
  watchedIds = loadLocalWatchedIds();
}

function isWatched(fightId) {
  return watchedIds.has(fightId);
}

async function toggleWatched(fightId) {
  const wasWatched = watchedIds.has(fightId);

  if (isSignedIn()) {
    const supabase = getSupabase();
    const user = getCurrentUser();
    if (!supabase || !user) return;

    if (wasWatched) {
      const { error } = await supabase
        .from("watched_fights")
        .delete()
        .eq("fight_id", fightId);
      if (error) throw error;
      watchedIds.delete(fightId);
    } else {
      const { error } = await supabase.from("watched_fights").insert({
        user_id: user.id,
        fight_id: fightId,
      });
      if (error) throw error;
      watchedIds.add(fightId);
    }
    return;
  }

  if (wasWatched) {
    watchedIds.delete(fightId);
  } else {
    watchedIds.add(fightId);
  }
  saveLocalWatchedIds();
}

async function clearAllWatched() {
  if (isSignedIn()) {
    const supabase = getSupabase();
    const user = getCurrentUser();
    if (!supabase || !user) return;

    const { error } = await supabase.from("watched_fights").delete().eq("user_id", user.id);
    if (error) throw error;
  }

  watchedIds = new Set();
  clearLocalWatchedIds();
}

function renderAuthBar() {
  if (!elements.authBar) return;

  if (isSignedIn()) {
    const user = getCurrentUser();
    const label = getUserLabel(user);
    const avatar = getUserAvatar(user);
    const avatarMarkup = avatar
      ? `<img class="auth-avatar" src="${escapeHtml(avatar)}" alt="" width="28" height="28">`
      : `<span class="auth-avatar auth-avatar-fallback" aria-hidden="true">${escapeHtml(label.charAt(0).toUpperCase())}</span>`;

    elements.authBar.innerHTML = `
      <div class="auth-signed-in">
        ${avatarMarkup}
        <span class="auth-name">${escapeHtml(label)}</span>
        <button type="button" class="btn-auth btn-sign-out touch-target" id="sign-out">Sign out</button>
      </div>
      <p class="auth-hint">Watched list saved to your account.</p>
    `;

    document.getElementById("sign-out")?.addEventListener("click", async () => {
      try {
        saveLocalWatchedIds();
        await signOut();
      } catch (err) {
        window.alert(`Could not sign out: ${err.message}`);
      }
    });
    return;
  }

  elements.authBar.innerHTML = `
    <button type="button" class="btn-auth btn-google touch-target" id="sign-in-google">
      <span class="btn-google-icon" aria-hidden="true">G</span>
      Sign in with Google
    </button>
    <p class="auth-hint">Sign in to remember watched fights across devices.</p>
  `;

  document.getElementById("sign-in-google")?.addEventListener("click", async () => {
    try {
      await signInWithGoogle();
    } catch (err) {
      window.alert(`Could not start Google sign-in: ${err.message}`);
    }
  });
}

function renderWatchedToggle(fightId) {
  const checked = isWatched(fightId);
  return `
    <label class="watched-control${checked ? " is-checked" : ""}">
      <input type="checkbox" class="watched-toggle" data-fight-id="${escapeHtml(fightId)}"${checked ? " checked" : ""}>
      Watched
    </label>
  `;
}

function compareWatched(a, b) {
  return Number(isWatched(a.id)) - Number(isWatched(b.id));
}

function poolForRecommendations(basePool) {
  const unwatched = basePool.filter((f) => !isWatched(f.id));
  return unwatched.length > 0 ? unwatched : basePool;
}

function youtubeSearch(query) {
  return `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
}

async function loadFights() {
  const response = await fetch("data/fights.json");
  if (!response.ok) throw new Error("Could not load fight data");
  const data = await response.json();
  allFights = data.fights.map((fight) => ({
    ...fight,
    watchUrl: fight.watchUrl || youtubeSearch(`${fight.event} ${fight.fighter1} ${fight.fighter2} full fight`),
  }));
  renderStats();
  render();
}

function isStatPillActive(filter) {
  if (filter === "all") {
    return statFilter.watched === "all" && elements.sport.value === "all";
  }
  if (filter === "watched" || filter === "unwatched") {
    return statFilter.watched === filter;
  }
  return elements.sport.value === filter;
}

function statPillButton(filter, count, label, options = {}) {
  const active = isStatPillActive(filter);
  const sportClass = options.sport ? ` stat-pill-${sportClassName(filter)}` : "";
  const title = options.title || `Filter: ${label}`;
  return `
    <button
      type="button"
      class="stat-pill${sportClass}${active ? " active" : ""}"
      data-stat-filter="${escapeHtml(filter)}"
      aria-pressed="${active}"
      title="${escapeHtml(title)}"
    >
      <strong>${count}</strong> ${escapeHtml(label)}
    </button>
  `;
}

function sportClassName(sport) {
  return sport === "muay thai" ? "muay-thai" : sport;
}

function syncHideWatchedCheckbox() {
  if (elements.hideWatched) {
    elements.hideWatched.checked = statFilter.watched === "unwatched";
  }
}

function applyStatFilter(filter) {
  if (filter === "all") {
    statFilter.watched = "all";
    elements.sport.value = "all";
  } else if (filter === "watched") {
    statFilter.watched = statFilter.watched === "watched" ? "all" : "watched";
  } else if (filter === "unwatched") {
    statFilter.watched = statFilter.watched === "unwatched" ? "all" : "unwatched";
  } else if (SPORT_ORDER.includes(filter)) {
    if (elements.sport.value === filter) {
      elements.sport.value = "all";
    } else {
      elements.sport.value = filter;
    }
  }
  syncHideWatchedCheckbox();
  render();
}

function renderStats() {
  const counts = allFights.reduce((acc, f) => {
    acc[f.sport] = (acc[f.sport] || 0) + 1;
    return acc;
  }, {});

  elements.stats.innerHTML = [
    statPillButton("all", allFights.length, "fights", { title: "Show all fights" }),
    statPillButton("watched", watchedIds.size, "watched", { title: "Show watched fights only" }),
    statPillButton("unwatched", allFights.length - watchedIds.size, "unwatched", {
      title: "Show unwatched fights only",
    }),
    ...SPORT_ORDER.filter((sport) => counts[sport]).map((sport) =>
      statPillButton(sport, counts[sport], SPORT_LABELS[sport], {
        sport: true,
        title: `Filter by ${SPORT_LABELS[sport]}`,
      })
    ),
  ].join("");

  if (elements.watchedProgress) {
    elements.watchedProgress.textContent =
      watchedIds.size === 0
        ? "Nothing marked watched yet."
        : `${watchedIds.size} watched · ${allFights.length - watchedIds.size} left to see`;
  }
}

function getBaseFilteredFights() {
  const query = elements.search.value.trim().toLowerCase();
  const sport = elements.sport.value;
  const ending = elements.ending.value;

  return allFights.filter((fight) => {
    if (sport !== "all" && fight.sport !== sport) return false;
    if (ending !== "all" && fight.endingCategory !== ending) return false;

    if (query) {
      const haystack = [
        fight.fighter1,
        fight.fighter2,
        fight.event,
        fight.ending,
        SPORT_LABELS[fight.sport],
        String(fight.year),
      ]
        .join(" ")
        .toLowerCase();
      if (!haystack.includes(query)) return false;
    }

    return true;
  });
}

function sortFights(fights, sort) {
  const sorted = [...fights];
  sorted.sort((a, b) => {
    let result = 0;
    switch (sort) {
      case "year-asc":
        result = a.year - b.year;
        break;
      case "year-desc":
        result = b.year - a.year;
        break;
      case "duration-asc":
        result = a.durationMinutes - b.durationMinutes;
        break;
      case "duration-desc":
        result = b.durationMinutes - a.durationMinutes;
        break;
      case "fighters":
        result = a.fighter1.localeCompare(b.fighter1);
        break;
      case "run-match":
        if (activeRunMinutes != null) {
          result =
            Math.abs(a.durationMinutes - activeRunMinutes) -
            Math.abs(b.durationMinutes - activeRunMinutes);
        }
        break;
      default:
        break;
    }
    return result !== 0 ? result : compareWatched(a, b);
  });
  return sorted;
}

function getFilteredFights() {
  const duration = elements.duration.value;
  const sort = activeRunMinutes != null ? "run-match" : elements.sort.value;

  let fights = getBaseFilteredFights().filter((fight) => {
    if (statFilter.watched === "unwatched" && isWatched(fight.id)) return false;
    if (statFilter.watched === "watched" && !isWatched(fight.id)) return false;
    if (duration === "short" && fight.durationMinutes >= 20) return false;
    if (duration === "medium" && (fight.durationMinutes < 20 || fight.durationMinutes > 35)) return false;
    if (duration === "long" && fight.durationMinutes <= 35) return false;
    return true;
  });

  if (activeRunMinutes != null) {
    const close = fights.filter(
      (f) => Math.abs(f.durationMinutes - activeRunMinutes) <= RUN_TOLERANCE_MIN
    );
    if (close.length > 0) {
      fights = close;
    } else if (runPickIds.size > 0) {
      fights = fights.filter((f) => runPickIds.has(f.id));
      if (fights.length === 0) {
        fights = getBaseFilteredFights();
      }
    }
  }

  return sortFights(fights, sort);
}

function formatMinutes(minutes) {
  if (minutes < 1) return "under 1 min";
  const rounded = Math.round(minutes * 10) / 10;
  return `${rounded} min`;
}

function fightLabel(fight) {
  return `${fight.fighter1} vs ${fight.fighter2}`;
}

function comboKey(fights) {
  return fights
    .map((f) => f.id)
    .sort()
    .join("-");
}

function seededShuffle(items, seed) {
  const arr = [...items];
  let state = seed + 1;
  for (let i = arr.length - 1; i > 0; i -= 1) {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    const j = state % (i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function pickRotated(candidates, count, seed) {
  if (candidates.length === 0) return [];
  const shuffled = seededShuffle(candidates, seed);
  if (shuffled.length <= count) return shuffled;
  const offset = (seed * count) % shuffled.length;
  const picked = [];
  for (let i = 0; i < count; i += 1) {
    picked.push(shuffled[(offset + i) % shuffled.length]);
  }
  return picked;
}

function findFightCombos(pool, targetMinutes) {
  const combos = [];
  const tolerance = RUN_TOLERANCE_MIN + 2;
  const n = pool.length;

  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
      const pair = [pool[i], pool[j]];
      const pairTotal = pair[0].durationMinutes + pair[1].durationMinutes;
      const pairDiff = Math.abs(pairTotal - targetMinutes);
      if (pairDiff <= tolerance && pairTotal <= targetMinutes + tolerance) {
        combos.push({ fights: pair, total: pairTotal, diff: pairDiff, size: 2 });
      }

      for (let k = j + 1; k < n; k += 1) {
        const triple = [pool[i], pool[j], pool[k]];
        const tripleTotal = triple.reduce((sum, f) => sum + f.durationMinutes, 0);
        const tripleDiff = Math.abs(tripleTotal - targetMinutes);
        if (tripleDiff <= tolerance && tripleTotal <= targetMinutes + tolerance) {
          combos.push({ fights: triple, total: tripleTotal, diff: tripleDiff, size: 3 });
        }
      }
    }
  }

  combos.sort((a, b) => {
    const unwatchedDiff =
      a.fights.filter((f) => isWatched(f.id)).length -
      b.fights.filter((f) => isWatched(f.id)).length;
    if (unwatchedDiff !== 0) return unwatchedDiff;
    return a.diff - b.diff || a.size - b.size;
  });
  const seen = new Set();
  return combos.filter((combo) => {
    const key = comboKey(combo.fights);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function pickMixedRunPicks(singlePool, comboPool, count, seed) {
  const picks = [];
  const usedKeys = new Set();

  const take = (list, subSeed) => {
    const available = list.filter((item) => !usedKeys.has(item.key));
    if (!available.length) return;
    const chosen = pickRotated(available, 1, seed + subSeed)[0];
    usedKeys.add(chosen.key);
    picks.push(chosen);
  };

  const singles = [...singlePool].sort((a, b) => a.score - b.score);
  const combos = [...comboPool].sort((a, b) => a.score - b.score);
  const combined = [...singles, ...combos].sort((a, b) => a.score - b.score);

  if (!combined.length) return [];

  // Best overall match first
  take(combined.slice(0, Math.min(8, combined.length)), 0);

  // Always include a single when one fits the run time
  if (picks.length < count && singles.length) {
    take(singles.slice(0, Math.min(8, singles.length)), 11);
  }

  // Always include a stack when one fits
  if (picks.length < count && combos.length) {
    take(combos.slice(0, Math.min(8, combos.length)), 29);
  }

  // Fill any remaining slots
  while (picks.length < count) {
    const remaining = combined.filter((item) => !usedKeys.has(item.key));
    if (!remaining.length) break;
    take(remaining.slice(0, Math.min(12, remaining.length)), 47 + picks.length);
  }

  return picks;
}

function getRunRecommendations(pool, targetMinutes, seed) {
  const singleCandidates = pool
    .map((fight) => {
      const rawDiff = Math.abs(fight.durationMinutes - targetMinutes);
      return {
        type: "single",
        fight,
        rawDiff,
        score: rawDiff + (isWatched(fight.id) ? 50 : 0),
        key: `s:${fight.id}`,
      };
    })
    .sort((a, b) => a.score - b.score);

  const comboCandidates = findFightCombos(pool, targetMinutes).map((combo) => ({
    type: "combo",
    fights: combo.fights,
    total: combo.total,
    rawDiff: combo.diff,
    score: combo.diff + combo.fights.filter((f) => isWatched(f.id)).length * 25,
    size: combo.size,
    key: `c:${comboKey(combo.fights)}`,
  }));

  const goodSingles = singleCandidates.filter((s) => s.rawDiff <= RUN_TOLERANCE_MIN + 3);
  const hasCloseSingles = goodSingles.length > 0;

  const singlePool = hasCloseSingles ? goodSingles : singleCandidates.slice(0, 12);
  const comboPool = comboCandidates;

  const picks = pickMixedRunPicks(singlePool, comboPool, RUN_PICKS_SHOWN, seed);

  return {
    picks,
    hasCloseSingles,
    totalComboOptions: comboCandidates.length,
  };
}

function renderStackRows(fights) {
  return fights
    .map(
      (fight, index) => `
        <div class="run-rec-stack-row">
          <span>${index + 1}. ${escapeHtml(fightLabel(fight))} <em>(${escapeHtml(fight.duration)})</em>${isWatched(fight.id) ? " · watched" : ""}</span>
          <a href="${escapeHtml(fight.watchUrl)}" target="_blank" rel="noopener noreferrer">Watch ↗</a>
        </div>
      `
    )
    .join("");
}

function renderRunPick(pick) {
  if (pick.type === "single") {
    const { fight, rawDiff } = pick;
    const offBy =
      rawDiff < 0.5
        ? "matches your run"
        : `${formatMinutes(rawDiff)} ${fight.durationMinutes > activeRunMinutes ? "over" : "under"}`;
    return `
      <div class="run-rec-item${isWatched(fight.id) ? " is-watched-rec" : ""}">
        <div class="run-rec-item-body">
          <div>
            <div class="run-rec-fighters">${escapeHtml(fightLabel(fight))}</div>
            <div class="run-rec-meta">${escapeHtml(fight.duration)} · ${escapeHtml(SPORT_LABELS[fight.sport])} · ${offBy}</div>
          </div>
          <a href="${escapeHtml(fight.watchUrl)}" target="_blank" rel="noopener noreferrer">Watch ↗</a>
        </div>
      </div>
    `;
  }

  const { fights, total, rawDiff, size } = pick;
  const offBy =
    rawDiff < 0.5
      ? "matches your run"
      : `${formatMinutes(rawDiff)} ${total > activeRunMinutes ? "over" : "under"}`;
  return `
    <div class="run-rec-item">
      <div style="flex: 1">
        <div class="run-rec-fighters">${size}-fight stack · ~${formatMinutes(total)}</div>
        <div class="run-rec-meta">${offBy} · watch in order</div>
        <div class="run-rec-stack-fights">${renderStackRows(fights)}</div>
      </div>
    </div>
  `;
}

function renderRunRecommendations() {
  if (activeRunMinutes == null) {
    elements.runRecommendations.classList.add("hidden");
    elements.runRecommendations.innerHTML = "";
    elements.clearRun.classList.add("hidden");
    elements.runRefresh.classList.add("hidden");
    runPickIds = new Set();
    currentRunRec = null;
    return;
  }

  elements.clearRun.classList.remove("hidden");
  elements.runRefresh.classList.remove("hidden");

  const pool = poolForRecommendations(getBaseFilteredFights());
  const allWatchedInFilter =
    getBaseFilteredFights().length > 0 &&
    getBaseFilteredFights().every((f) => isWatched(f.id));

  currentRunRec = {
    ...getRunRecommendations(pool, activeRunMinutes, runRefreshSeed),
    allWatchedInFilter,
  };

  runPickIds = new Set();
  currentRunRec.picks.forEach((pick) => {
    if (pick.type === "single") {
      runPickIds.add(pick.fight.id);
    } else {
      pick.fights.forEach((f) => runPickIds.add(f.id));
    }
  });

  const pickItems = currentRunRec.picks.map(renderRunPick).join("");

  elements.runRecommendations.innerHTML = `
    <div class="run-rec-header">
      <div>
        <h2 class="run-rec-heading">Your ${activeRunMinutes}-minute run</h2>
        <p class="run-rec-sub" style="margin: 0">
          ${
            currentRunRec.allWatchedInFilter
              ? "You’ve watched everything matching your filters — showing rewatches."
              : currentRunRec.hasCloseSingles
                ? `${RUN_PICKS_SHOWN} picks — singles and stacks within ~${RUN_TOLERANCE_MIN} min.`
                : "No exact single-fight match — stacks fill the gap, singles shown if close."
          }
        </p>
      </div>
      <button type="button" class="btn-run-refresh" id="run-refresh-inline" title="Show different fight picks">New picks ↻</button>
    </div>
    <div class="run-rec-section">
      <div class="run-rec-list">${pickItems || `<p class="run-rec-sub">No fights match your run time and filters.</p>`}</div>
    </div>
  `;

  document.getElementById("run-refresh-inline")?.addEventListener("click", refreshRunPicks);
  elements.runRecommendations.classList.remove("hidden");
}

function sportClass(sport) {
  return sport === "muay thai" ? "muay-thai" : sport;
}

function renderFightCard(fight) {
  const sportLabel = SPORT_LABELS[fight.sport] || fight.sport;
  const label = fight.watchLabel || "Watch";
  const isPick = runPickIds.has(fight.id);
  const watched = isWatched(fight.id);
  const pickBadge = isPick ? `<span class="run-pick-badge">Run pick</span>` : "";

  return `
    <article class="fight-card${isPick ? " run-pick" : ""}${watched ? " is-watched" : ""}" data-fight-id="${escapeHtml(fight.id)}">
      ${pickBadge}
      ${renderWatchedToggle(fight.id)}
      <div class="fight-card-header">
        <span class="sport-badge ${sportClass(fight.sport)}">${sportLabel}</span>
        <span class="fight-year">${fight.year}</span>
      </div>
      <h2 class="fighters">${escapeHtml(fight.fighter1)} vs ${escapeHtml(fight.fighter2)}</h2>
      <p class="event">${escapeHtml(fight.event)}</p>
      <dl class="meta-grid">
        <div class="meta-item">
          <dt>Duration</dt>
          <dd>${escapeHtml(fight.duration)}</dd>
        </div>
        <div class="meta-item">
          <dt>How it ends</dt>
          <dd>${escapeHtml(fight.ending)}</dd>
        </div>
      </dl>
      <a class="watch-link" href="${escapeHtml(fight.watchUrl)}" target="_blank" rel="noopener noreferrer">
        ${escapeHtml(label)} ↗
      </a>
    </article>
  `;
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

function render() {
  renderRunRecommendations();
  renderStats();
  const runMode = activeRunMinutes != null;

  if (runMode) {
    elements.resultsCount.classList.add("hidden");
    elements.grid.classList.add("hidden");
    elements.emptyState.classList.add("hidden");
    return;
  }

  const fights = getFilteredFights();
  elements.resultsCount.classList.remove("hidden");

  if (fights.length === allFights.length) {
    elements.resultsCount.textContent = `Showing all ${fights.length} fights`;
  } else {
    elements.resultsCount.textContent = `Showing ${fights.length} of ${allFights.length} fights`;
  }

  elements.grid.innerHTML = fights.map(renderFightCard).join("");
  elements.emptyState.classList.toggle("hidden", fights.length > 0);
  elements.grid.classList.toggle("hidden", fights.length === 0);
}

function updatePresetButtons() {
  elements.runPresets.forEach((btn) => {
    const mins = Number(btn.dataset.minutes);
    btn.classList.toggle("active", activeRunMinutes === mins);
  });
}

function applyRunTime(minutes) {
  if (!Number.isFinite(minutes) || minutes < 5 || minutes > 90) {
    return;
  }
  activeRunMinutes = Math.round(minutes);
  runRefreshSeed = 0;
  elements.runTime.value = String(activeRunMinutes);
  elements.duration.value = "all";
  updatePresetButtons();
  render();
}

function refreshRunPicks() {
  if (activeRunMinutes == null) return;
  runRefreshSeed += 1;
  render();
}

function clearRunTime() {
  activeRunMinutes = null;
  runRefreshSeed = 0;
  elements.runTime.value = "";
  updatePresetButtons();
  render();
}

function resetFilters() {
  elements.search.value = "";
  elements.sport.value = "all";
  elements.duration.value = "all";
  elements.ending.value = "all";
  elements.sort.value = "year-desc";
  statFilter.watched = "all";
  syncHideWatchedCheckbox();
  clearRunTime();
}

elements.search.addEventListener("input", render);
elements.sport.addEventListener("change", render);
elements.duration.addEventListener("change", render);
elements.ending.addEventListener("change", render);
elements.sort.addEventListener("change", render);
elements.reset.addEventListener("click", resetFilters);

elements.runFind.addEventListener("click", () => {
  applyRunTime(Number(elements.runTime.value));
});

elements.runTime.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    applyRunTime(Number(elements.runTime.value));
  }
});

elements.clearRun.addEventListener("click", clearRunTime);
elements.runRefresh.addEventListener("click", refreshRunPicks);

elements.runPresets.forEach((btn) => {
  btn.addEventListener("click", () => {
    applyRunTime(Number(btn.dataset.minutes));
  });
});

document.addEventListener("change", (e) => {
  if (!e.target.classList.contains("watched-toggle")) return;

  const fightId = e.target.dataset.fightId;
  toggleWatched(fightId)
    .then(() => render())
    .catch((err) => {
      e.target.checked = !e.target.checked;
      window.alert(`Could not update watched status: ${err.message}`);
    });
});

elements.hideWatched?.addEventListener("change", () => {
  statFilter.watched = elements.hideWatched.checked ? "unwatched" : "all";
  render();
});

elements.stats.addEventListener("click", (e) => {
  const pill = e.target.closest("[data-stat-filter]");
  if (!pill) return;
  applyStatFilter(pill.dataset.statFilter);
});

elements.resetWatched?.addEventListener("click", () => {
  if (watchedIds.size === 0) return;
  if (!window.confirm(`Clear all ${watchedIds.size} watched fights?`)) return;

  clearAllWatched()
    .then(() => render())
    .catch((err) => window.alert(`Could not clear watched list: ${err.message}`));
});

async function bootstrap() {
  try {
    await initAuth();
    renderAuthBar();
    onAuthChange(async () => {
      renderAuthBar();
      try {
        await loadWatchedIds();
      } catch (err) {
        console.error(err);
      }
      render();
    });

    await loadWatchedIds();
    await loadFights();
  } catch (err) {
    elements.grid.innerHTML = `<p class="empty-state">Failed to load: ${escapeHtml(err.message)}</p>`;
  }
}

bootstrap();
