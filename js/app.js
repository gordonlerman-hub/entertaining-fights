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
import {
  fightsToVideoIds,
  isYouTubeReady,
  onYouTubeReadyChange,
  syncYouTubeQueue,
} from "./youtube.js";

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
const PREFER_UNWATCHED_KEY = "bestFightsPreferUnwatched";
const MOBILE_LAYOUT_MQ = window.matchMedia("(max-width: 900px)");

const elements = {
  authBar: document.getElementById("auth-bar"),
  sidebar: document.getElementById("sidebar"),
  mobileRunToggle: document.getElementById("mobile-run-toggle"),
  mobileRunLabel: document.getElementById("mobile-run-label"),
  mobileClearRun: document.getElementById("mobile-clear-run"),
  mobileFiltersToggle: document.getElementById("mobile-filters-toggle"),
  mobileFilterBadge: document.getElementById("mobile-filter-badge"),
  grid: document.getElementById("fight-grid"),
  stats: document.getElementById("stats"),
  resultsCount: document.getElementById("results-count"),
  emptyState: document.getElementById("empty-state"),
  runRecommendations: document.getElementById("run-recommendations"),
  watchedProgress: document.getElementById("watched-progress"),
  hideWatched: document.getElementById("hide-watched"),
  resetWatched: document.getElementById("reset-watched"),
  fighterSearch: document.getElementById("fighter-search"),
  fighterSuggestions: document.getElementById("fighter-suggestions"),
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
let allFighters = [];
let selectedFighter = null;
let suggestionHighlight = -1;
let activeRunMinutes = null;
let runPickIds = new Set();
let runRefreshSeed = 0;
let currentRunRec = null;
let sessionPicks = null;
let watchedIds = new Set();
let statFilter = { watched: "unwatched" };
/** @type {Map<string, { status: string, openUrl?: string, error?: string }>} */
const queueState = new Map();

function isMobileLayout() {
  return MOBILE_LAYOUT_MQ.matches;
}

function setMobilePanel(panel) {
  if (!elements.sidebar) return;

  if (!isMobileLayout()) {
    elements.sidebar.classList.remove("is-run-open", "is-filters-open");
    return;
  }

  const runOpen = panel === "run";
  const filtersOpen = panel === "filters";

  elements.sidebar.classList.toggle("is-run-open", runOpen);
  elements.sidebar.classList.toggle("is-filters-open", filtersOpen);

  elements.mobileRunToggle?.setAttribute("aria-expanded", String(runOpen));
  elements.mobileFiltersToggle?.setAttribute("aria-expanded", String(filtersOpen));
  elements.mobileRunToggle?.classList.toggle("is-open", runOpen);
  elements.mobileFiltersToggle?.classList.toggle("is-open", filtersOpen);

  if (runOpen) {
    document.getElementById("run-time-panel")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  } else if (filtersOpen) {
    document.getElementById("filters-drawer")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }
}

function toggleMobileRunPanel() {
  if (!isMobileLayout()) return;
  const willOpen = !elements.sidebar?.classList.contains("is-run-open");
  setMobilePanel(willOpen ? "run" : null);
}

function toggleMobileFiltersPanel() {
  if (!isMobileLayout()) return;
  const willOpen = !elements.sidebar?.classList.contains("is-filters-open");
  setMobilePanel(willOpen ? "filters" : null);
}

function countActiveFilters() {
  let count = 0;
  if (elements.fighterSearch.value.trim()) count += 1;
  if (elements.sport.value !== "all") count += 1;
  if (elements.duration.value !== "all") count += 1;
  if (elements.ending.value !== "all") count += 1;
  if (elements.sort.value !== "year-desc") count += 1;
  if (statFilter.watched === "watched") count += 1;
  return count;
}

function updateMobileToolbar() {
  if (!elements.mobileRunToggle) return;

  const activeFilters = countActiveFilters();
  const runLabel =
    activeRunMinutes != null
      ? isMobileLayout()
        ? `${activeRunMinutes} min`
        : `${activeRunMinutes} min session`
      : "Session";

  if (elements.mobileRunLabel) {
    elements.mobileRunLabel.textContent = runLabel;
  }

  elements.mobileRunToggle.classList.toggle("has-active-run", activeRunMinutes != null);
  elements.mobileClearRun?.classList.toggle("hidden", activeRunMinutes == null);

  if (elements.mobileFilterBadge) {
    elements.mobileFilterBadge.classList.toggle("hidden", activeFilters === 0);
    elements.mobileFilterBadge.textContent = activeFilters > 9 ? "9+" : String(activeFilters);
    elements.mobileFilterBadge.setAttribute(
      "aria-label",
      activeFilters === 0 ? "No active filters" : `${activeFilters} active filters`
    );
  }

  elements.mobileFiltersToggle?.classList.toggle("is-active", activeFilters > 0);
}

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

async function markFightsWatched(fightIds) {
  const toMark = fightIds.filter((id) => !isWatched(id));
  if (toMark.length === 0) return;

  if (isSignedIn()) {
    const supabase = getSupabase();
    const user = getCurrentUser();
    if (!supabase || !user) return;

    const rows = toMark.map((fightId) => ({
      user_id: user.id,
      fight_id: fightId,
    }));
    const { error } = await supabase.from("watched_fights").upsert(rows, {
      onConflict: "user_id,fight_id",
      ignoreDuplicates: true,
    });
    if (error) throw error;
    toMark.forEach((id) => watchedIds.add(id));
    return;
  }

  toMark.forEach((id) => watchedIds.add(id));
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
    const youtubeBadge = isYouTubeReady()
      ? `<span class="auth-youtube-badge" title="YouTube playlist ready">YouTube ready</span>`
      : "";
    const avatarMarkup = avatar
      ? `<img class="auth-avatar" src="${escapeHtml(avatar)}" alt="" width="28" height="28">`
      : `<span class="auth-avatar auth-avatar-fallback" aria-hidden="true">${escapeHtml(label.charAt(0).toUpperCase())}</span>`;

    elements.authBar.innerHTML = `
      <div class="auth-signed-in">
        ${avatarMarkup}
        <div class="auth-user-meta">
          <span class="auth-name">${escapeHtml(label)}</span>
          ${youtubeBadge}
        </div>
        <button type="button" class="btn-auth btn-sign-out touch-target" id="sign-out">Sign out</button>
      </div>
      <p class="auth-hint auth-hint--desktop">Watched list synced · queue cardio picks to YouTube.</p>
      <p class="auth-hint auth-hint--mobile">Sync watched · queue to YouTube.</p>
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
    <button type="button" class="btn-auth btn-google touch-target" id="sign-in-google" aria-label="Sign in with Google">
      <span class="btn-google-icon" aria-hidden="true">G</span>
      <span class="btn-google-label btn-google-label--long">Sign in with Google</span>
      <span class="btn-google-label btn-google-label--short">Sign in</span>
    </button>
    <p class="auth-hint auth-hint--desktop">Sign in with Google to sync watched fights and queue cardio picks on YouTube.</p>
    <p class="auth-hint auth-hint--mobile">Sign in to sync watched fights and queue on YouTube.</p>
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

function loadPreferUnwatched() {
  try {
    const raw = localStorage.getItem(PREFER_UNWATCHED_KEY);
    if (raw === null) return true;
    return raw === "true";
  } catch {
    return true;
  }
}

function savePreferUnwatched(prefer) {
  try {
    localStorage.setItem(PREFER_UNWATCHED_KEY, String(prefer));
  } catch {
    // ignore
  }
}

function prefersUnwatchedOnly() {
  return statFilter.watched === "unwatched";
}

function applyUnwatchedPreference(prefer) {
  statFilter.watched = prefer ? "unwatched" : "all";
  savePreferUnwatched(prefer);
  syncHideWatchedCheckbox();
}

function compareWatched(a, b) {
  return Number(isWatched(a.id)) - Number(isWatched(b.id));
}

function poolForRecommendations(basePool) {
  if (!prefersUnwatchedOnly()) return basePool;
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
  buildFighterList();
  renderStats();
  render();
}

function buildFighterList() {
  const names = new Set();
  allFights.forEach((fight) => {
    names.add(fight.fighter1);
    names.add(fight.fighter2);
  });
  allFighters = [...names].sort((a, b) => a.localeCompare(b));
}

function getFighterSuggestions(query) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return allFighters.filter((name) => name.toLowerCase().includes(q)).slice(0, 10);
}

function hideFighterSuggestions() {
  elements.fighterSuggestions.classList.add("hidden");
  elements.fighterSearch.setAttribute("aria-expanded", "false");
  suggestionHighlight = -1;
}

function renderFighterSuggestions(query) {
  const suggestions = getFighterSuggestions(query);
  const list = elements.fighterSuggestions;

  if (!query.trim() || suggestions.length === 0) {
    hideFighterSuggestions();
    return;
  }

  list.innerHTML = suggestions
    .map(
      (name, index) => `
        <li
          role="option"
          data-fighter="${escapeHtml(name)}"
          aria-selected="${index === suggestionHighlight}"
          class="${index === suggestionHighlight ? "is-highlighted" : ""}"
        >${escapeHtml(name)}</li>
      `
    )
    .join("");

  list.classList.remove("hidden");
  elements.fighterSearch.setAttribute("aria-expanded", "true");
}

function selectFighter(name) {
  selectedFighter = name;
  elements.fighterSearch.value = name;
  hideFighterSuggestions();
  render();
}

function fightMatchesFighterQuery(fight, query) {
  if (!query) return true;

  if (selectedFighter && selectedFighter.toLowerCase() === query) {
    return fight.fighter1 === selectedFighter || fight.fighter2 === selectedFighter;
  }

  const matchF1 = fight.fighter1.toLowerCase().includes(query);
  const matchF2 = fight.fighter2.toLowerCase().includes(query);
  return matchF1 || matchF2;
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
    savePreferUnwatched(false);
    elements.sport.value = "all";
  } else if (filter === "watched") {
    statFilter.watched = statFilter.watched === "watched" ? "all" : "watched";
    if (statFilter.watched === "all") savePreferUnwatched(false);
  } else if (filter === "unwatched") {
    const next = statFilter.watched === "unwatched" ? "all" : "unwatched";
    statFilter.watched = next;
    savePreferUnwatched(next === "unwatched");
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
  const query = elements.fighterSearch.value.trim().toLowerCase();
  const sport = elements.sport.value;
  const ending = elements.ending.value;

  return allFights.filter((fight) => {
    if (sport !== "all" && fight.sport !== sport) return false;
    if (ending !== "all" && fight.endingCategory !== ending) return false;
    if (!fightMatchesFighterQuery(fight, query)) return false;
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

function sportLabel(sport) {
  return SPORT_LABELS[sport] || sport;
}

function renderRunFightDetails(fight) {
  const label = sportLabel(fight.sport);
  return `
    <div class="run-rec-fight-details">
      <span class="sport-badge ${sportClass(fight.sport)}">${escapeHtml(label)}</span>
      <dl class="meta-grid run-rec-meta-grid">
        <div class="meta-item">
          <dt>Duration</dt>
          <dd>${escapeHtml(fight.duration)}</dd>
        </div>
        <div class="meta-item">
          <dt>How it ends</dt>
          <dd>${escapeHtml(fight.ending)}</dd>
        </div>
      </dl>
    </div>
  `;
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
        <div class="run-rec-stack-row${isWatched(fight.id) ? " is-watched-rec" : ""}">
          <span class="run-rec-stack-row-main">
            <span class="run-rec-stack-fighters">${index + 1}. ${escapeHtml(fightLabel(fight))}</span>
            <span class="run-rec-stack-detail">
              <span class="sport-badge ${sportClass(fight.sport)}">${escapeHtml(sportLabel(fight.sport))}</span>
              ${escapeHtml(fight.ending)} · ${escapeHtml(fight.duration)}
            </span>
          </span>
          <div class="run-rec-stack-row-actions">
            <a href="${escapeHtml(fight.watchUrl)}" target="_blank" rel="noopener noreferrer">Watch ↗</a>
            ${renderWatchedToggle(fight.id)}
          </div>
        </div>
      `
    )
    .join("");
}

function getFightsFromPick(pick) {
  return pick.type === "single" ? [pick.fight] : pick.fights;
}

function renderQueueActions(pick) {
  const pickKey = pick.key;
  const state = queueState.get(pickKey);
  const signedIn = isSignedIn();
  const pickFights = getFightsFromPick(pick);
  const hasUnwatched = pickFights.some((f) => !isWatched(f.id));

  if (state?.status === "success" && state.openUrl) {
    const queuedLabel = state.playlistTitle
      ? `Queued as “${escapeHtml(state.playlistTitle)}”`
      : "Queued — tap to start your workout";
    const markWatchedBtn = hasUnwatched
      ? `<button type="button" class="btn-mark-watched touch-target" data-mark-watched-pick-key="${escapeHtml(pickKey)}">Mark as watched</button>`
      : "";
    return `
      <a class="btn-youtube-open" href="${escapeHtml(state.openUrl)}" target="_blank" rel="noopener noreferrer">Open in YouTube ↗</a>
      ${markWatchedBtn}
      <span class="run-rec-queue-success">${queuedLabel}</span>
    `;
  }

  if (state?.status === "loading") {
    return `<button type="button" class="btn-youtube-queue" disabled>Queuing…</button>`;
  }

  const title = !signedIn
    ? "Sign in to queue on YouTube"
    : !isYouTubeReady()
      ? "Setting up YouTube — try again in a moment"
      : "Save these fights to your YouTube playlist in order";

  let errorMarkup = "";
  if (state?.status === "error" && state.error) {
    errorMarkup = `<p class="run-rec-queue-error" role="alert">${escapeHtml(state.error)}</p>`;
  }

  return `
    <button
      type="button"
      class="btn-youtube-queue touch-target"
      data-queue-pick-key="${escapeHtml(pickKey)}"
      title="${escapeHtml(title)}"
    >Queue on YouTube</button>
    ${errorMarkup}
  `;
}

function renderRunPick(pick) {
  const queueActions = renderQueueActions(pick);

  if (pick.type === "single") {
    const { fight, rawDiff } = pick;
    const offBy =
      rawDiff < 0.5
        ? "matches your session"
        : `${formatMinutes(rawDiff)} ${fight.durationMinutes > activeRunMinutes ? "over" : "under"}`;
    return `
      <div class="run-rec-item${isWatched(fight.id) ? " is-watched-rec" : ""}" data-pick-key="${escapeHtml(pick.key)}">
        <div class="run-rec-item-main">
          <div class="run-rec-fighters">${escapeHtml(fightLabel(fight))}</div>
          <div class="run-rec-meta">${escapeHtml(offBy)}</div>
          ${renderRunFightDetails(fight)}
        </div>
        <div class="run-rec-actions-row">
          <a href="${escapeHtml(fight.watchUrl)}" target="_blank" rel="noopener noreferrer">Watch ↗</a>
          ${renderWatchedToggle(fight.id)}
          ${queueActions}
        </div>
      </div>
    `;
  }

  const { fights, total, rawDiff, size } = pick;
  const offBy =
    rawDiff < 0.5
      ? "matches your session"
      : `${formatMinutes(rawDiff)} ${total > activeRunMinutes ? "over" : "under"}`;
  return `
    <div class="run-rec-item" data-pick-key="${escapeHtml(pick.key)}">
      <div class="run-rec-item-main">
        <div class="run-rec-fighters">${size}-fight stack · ~${formatMinutes(total)}</div>
        <div class="run-rec-meta">${offBy} · watch in order</div>
        <div class="run-rec-stack-fights">${renderStackRows(fights)}</div>
      </div>
      <div class="run-rec-actions-row run-rec-actions-row--stack">
        ${queueActions}
      </div>
    </div>
  `;
}

async function markPickAsWatched(pickKey) {
  if (!currentRunRec?.picks) return;
  const pick = currentRunRec.picks.find((p) => p.key === pickKey);
  if (!pick) return;

  const fightIds = getFightsFromPick(pick).map((f) => f.id);
  await markFightsWatched(fightIds);
}

async function queuePickOnYouTube(pickKey) {
  if (!currentRunRec?.picks) return;
  const pick = currentRunRec.picks.find((p) => p.key === pickKey);
  if (!pick) return;

  if (!isSignedIn()) {
    try {
      await signInWithGoogle();
    } catch (err) {
      window.alert(`Could not start Google sign-in: ${err.message}`);
    }
    return;
  }

  const fights = getFightsFromPick(pick);
  const { videoIds, missing } = fightsToVideoIds(fights);

  if (missing.length > 0) {
    queueState.set(pickKey, {
      status: "error",
      error: "This pick includes a search-only link — choose a fight with a direct YouTube URL.",
    });
    renderRunRecommendations();
    return;
  }

  queueState.set(pickKey, { status: "loading" });
  renderRunRecommendations();

  try {
    const result = await syncYouTubeQueue(videoIds, {
      runMinutes: activeRunMinutes,
      fights,
    });
    queueState.set(pickKey, {
      status: "success",
      openUrl: result.openUrl,
      playlistTitle: result.playlistTitle,
    });
  } catch (err) {
    queueState.set(pickKey, {
      status: "error",
      error: err.message || "Could not queue on YouTube — try again.",
    });
  }

  renderRunRecommendations();
}

function syncRunPickIdsFromPicks(picks) {
  runPickIds = new Set();
  picks.forEach((pick) => {
    if (pick.type === "single") {
      runPickIds.add(pick.fight.id);
    } else {
      pick.fights.forEach((f) => runPickIds.add(f.id));
    }
  });
}

function computeRunRecommendations() {
  const basePool = getBaseFilteredFights();
  const pool = poolForRecommendations(basePool);
  const allWatchedInFilter =
    prefersUnwatchedOnly() &&
    basePool.length > 0 &&
    basePool.every((f) => isWatched(f.id));

  currentRunRec = {
    ...getRunRecommendations(pool, activeRunMinutes, runRefreshSeed),
    allWatchedInFilter,
  };
  sessionPicks = currentRunRec.picks;
  syncRunPickIdsFromPicks(sessionPicks);
}

function renderRunRecommendations({ regenerate = false } = {}) {
  if (activeRunMinutes == null) {
    elements.runRecommendations.classList.add("hidden");
    elements.runRecommendations.innerHTML = "";
    elements.clearRun.classList.add("hidden");
    elements.runRefresh.classList.add("hidden");
    runPickIds = new Set();
    currentRunRec = null;
    sessionPicks = null;
    queueState.clear();
    return;
  }

  elements.clearRun.classList.remove("hidden");
  elements.runRefresh.classList.remove("hidden");

  if (regenerate || !sessionPicks?.length) {
    computeRunRecommendations();
  } else {
    currentRunRec = { ...currentRunRec, picks: sessionPicks };
    syncRunPickIdsFromPicks(sessionPicks);
  }

  const pickItems = currentRunRec.picks.map(renderRunPick).join("");

  elements.runRecommendations.innerHTML = `
    <div class="run-rec-header">
      <div>
        <h2 class="run-rec-heading">Your ${activeRunMinutes}-minute session</h2>
        <p class="run-rec-sub" style="margin: 0">
          ${
            currentRunRec.allWatchedInFilter
              ? "You’ve watched everything matching your filters — showing rewatches."
              : currentRunRec.hasCloseSingles
                ? `${RUN_PICKS_SHOWN} picks within ~${RUN_TOLERANCE_MIN} min — choose one, then tap Queue on YouTube.`
                : "Stacks fill the gap — choose one pick, then tap Queue on YouTube."
          }
        </p>
      </div>
      <div class="run-rec-actions">
        <button type="button" class="btn-clear-run" id="run-clear-inline">Clear session</button>
        <button type="button" class="btn-run-refresh" id="run-refresh-inline" title="Show different fight picks">New picks ↻</button>
      </div>
    </div>
    <div class="run-rec-section">
      <div class="run-rec-list">${pickItems || `<p class="run-rec-sub">No fights match your session time and filters.</p>`}</div>
    </div>
  `;

  document.getElementById("run-refresh-inline")?.addEventListener("click", refreshRunPicks);
  document.getElementById("run-clear-inline")?.addEventListener("click", clearRunTime);

  elements.runRecommendations.querySelectorAll("[data-queue-pick-key]").forEach((btn) => {
    btn.addEventListener("click", () => {
      queuePickOnYouTube(btn.dataset.queuePickKey);
    });
  });

  elements.runRecommendations.querySelectorAll("[data-mark-watched-pick-key]").forEach((btn) => {
    btn.addEventListener("click", () => {
      markPickAsWatched(btn.dataset.markWatchedPickKey)
        .then(() => refreshAfterWatchedChange())
        .catch((err) => {
          window.alert(`Could not mark as watched: ${err.message}`);
        });
    });
  });

  elements.runRecommendations.classList.remove("hidden");
}

function sportClass(sport) {
  return sport === "muay thai" ? "muay-thai" : sport;
}

function renderFightCard(fight) {
  const sport = sportLabel(fight.sport);
  const watchLabel = fight.watchLabel || "Watch";
  const isPick = runPickIds.has(fight.id);
  const watched = isWatched(fight.id);
  const pickBadge = isPick ? `<span class="run-pick-badge">Session pick</span>` : "";

  return `
    <article class="fight-card${isPick ? " run-pick" : ""}${watched ? " is-watched" : ""}" data-fight-id="${escapeHtml(fight.id)}">
      ${pickBadge}
      ${renderWatchedToggle(fight.id)}
      <div class="fight-card-header">
        <span class="sport-badge ${sportClass(fight.sport)}">${escapeHtml(sport)}</span>
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
        ${escapeHtml(watchLabel)} ↗
      </a>
    </article>
  `;
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

function refreshAfterWatchedChange() {
  renderStats();
  updateMobileToolbar();
  if (activeRunMinutes != null) {
    renderRunRecommendations();
    elements.resultsCount.classList.add("hidden");
    elements.grid.classList.add("hidden");
    elements.emptyState.classList.add("hidden");
    return;
  }
  render();
}

function render({ regenerateRunPicks = false } = {}) {
  renderRunRecommendations({ regenerate: regenerateRunPicks });
  renderStats();
  updateMobileToolbar();
  const runMode = activeRunMinutes != null;

  if (runMode) {
    elements.resultsCount.classList.add("hidden");
    elements.grid.classList.add("hidden");
    elements.emptyState.classList.add("hidden");
    return;
  }

  const fights = getFilteredFights();
  elements.resultsCount.classList.remove("hidden");

  const fighterQuery = elements.fighterSearch.value.trim();
  if (fighterQuery) {
    const label = selectedFighter || fighterQuery;
    elements.resultsCount.textContent =
      fights.length === 1
        ? `1 fight with ${label}`
        : `${fights.length} fights with ${label}`;
  } else if (fights.length === allFights.length) {
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

  if (isMobileLayout()) {
    setMobilePanel(null);
  }

  render({ regenerateRunPicks: true });

  if (isMobileLayout() && !elements.runRecommendations.classList.contains("hidden")) {
    elements.runRecommendations.scrollIntoView({ behavior: "smooth", block: "start" });
  }
}

function refreshRunPicks() {
  if (activeRunMinutes == null) return;
  runRefreshSeed += 1;
  queueState.clear();
  render({ regenerateRunPicks: true });
}

function clearRunTime() {
  activeRunMinutes = null;
  runRefreshSeed = 0;
  elements.runTime.value = "";
  updatePresetButtons();
  if (isMobileLayout()) {
    setMobilePanel(null);
  }
  render();
}

function resetFilters() {
  elements.fighterSearch.value = "";
  selectedFighter = null;
  hideFighterSuggestions();
  elements.sport.value = "all";
  elements.duration.value = "all";
  elements.ending.value = "all";
  elements.sort.value = "year-desc";
  applyUnwatchedPreference(true);
  clearRunTime();
}

document.getElementById("brand-home")?.addEventListener("click", (e) => {
  e.preventDefault();
  window.location.reload();
});

elements.fighterSearch.addEventListener("input", () => {
  if (selectedFighter && elements.fighterSearch.value.trim() !== selectedFighter) {
    selectedFighter = null;
  }
  suggestionHighlight = -1;
  renderFighterSuggestions(elements.fighterSearch.value);
  render();
});

elements.fighterSearch.addEventListener("focus", () => {
  renderFighterSuggestions(elements.fighterSearch.value);
});

elements.fighterSearch.addEventListener("keydown", (e) => {
  const suggestions = getFighterSuggestions(elements.fighterSearch.value);
  if (suggestions.length === 0) return;

  if (e.key === "ArrowDown") {
    e.preventDefault();
    suggestionHighlight = Math.min(suggestionHighlight + 1, suggestions.length - 1);
    renderFighterSuggestions(elements.fighterSearch.value);
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    suggestionHighlight = Math.max(suggestionHighlight - 1, 0);
    renderFighterSuggestions(elements.fighterSearch.value);
  } else if (e.key === "Enter" && suggestionHighlight >= 0) {
    e.preventDefault();
    selectFighter(suggestions[suggestionHighlight]);
  } else if (e.key === "Escape") {
    hideFighterSuggestions();
  }
});

elements.fighterSuggestions.addEventListener("mousedown", (e) => {
  const option = e.target.closest("[data-fighter]");
  if (!option) return;
  e.preventDefault();
  selectFighter(option.dataset.fighter);
});

document.addEventListener("click", (e) => {
  if (!e.target.closest(".fighter-search-wrap")) {
    hideFighterSuggestions();
  }
});

elements.sport.addEventListener("change", render);
elements.duration.addEventListener("change", render);
elements.ending.addEventListener("change", render);
elements.sort.addEventListener("change", render);
elements.reset.addEventListener("click", resetFilters);

elements.mobileRunToggle?.addEventListener("click", toggleMobileRunPanel);
elements.mobileClearRun?.addEventListener("click", clearRunTime);
elements.mobileFiltersToggle?.addEventListener("click", toggleMobileFiltersPanel);

MOBILE_LAYOUT_MQ.addEventListener("change", () => {
  if (!isMobileLayout()) {
    setMobilePanel(null);
  }
  updateMobileToolbar();
  render();
});

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
    .then(() => refreshAfterWatchedChange())
    .catch((err) => {
      e.target.checked = !e.target.checked;
      window.alert(`Could not update watched status: ${err.message}`);
    });
});

elements.hideWatched?.addEventListener("change", () => {
  applyUnwatchedPreference(elements.hideWatched.checked);
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
    .then(() => refreshAfterWatchedChange())
    .catch((err) => window.alert(`Could not clear watched list: ${err.message}`));
});

async function bootstrap() {
  try {
    applyUnwatchedPreference(loadPreferUnwatched());
    await initAuth();
    renderAuthBar();
    onYouTubeReadyChange(() => renderAuthBar());
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
