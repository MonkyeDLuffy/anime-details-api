// server.js
import express from "express";
import cors from "cors";
import axios from "axios";
import http from "http";
import https from "https";
import dotenv from "dotenv";
import { LRUCache } from "lru-cache";
import { createClient } from "@supabase/supabase-js";
import WebSocket from "ws";

/* ===============================================================
   WEBSOCKET POLYFILL (Node < 22 compatibility fix)
   ---------------------------------------------------------------
   Newer @supabase/supabase-js (via @supabase/realtime-js) throws
   at startup on Node < 22 because it expects a native global
   `WebSocket`. This host runs Node 20, which does not expose one.
   We register the `ws` implementation as the global WebSocket so
   the Supabase client constructs successfully. This API only uses
   Supabase for DB caching (never realtime), so this is safe.
================================================================ */
if (typeof globalThis.WebSocket === "undefined") {
  globalThis.WebSocket = WebSocket;
}

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

const ANILIST = "https://graphql.anilist.co";
const JIKAN = "https://api.jikan.moe/v4";
const MEGAPLAY = "https://megaplay.buzz";
const ANIKOTO = "https://anikotoapi.site";
const TMDB = "https://api.themoviedb.org/3";
const TMDB_IMAGE = "https://image.tmdb.org/t/p/original";

app.use(cors());
app.use(express.json());

/* ===============================
   HTTP KEEP-ALIVE (reuse sockets)
================================ */
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 50 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 50 });
axios.defaults.httpAgent = httpAgent;
axios.defaults.httpsAgent = httpsAgent;

/* ===============================
   SUPABASE
   NOTE: @supabase/supabase-js is pinned to a Node-20-compatible version
   in package.json. Newer versions (2.95+) require native WebSocket support
   (Node 22+) and crash on startup. This API only uses the database for
   caching (never realtime), so we also disable session persistence and
   realtime to keep the server-side client lightweight and safe.
================================ */
const supabase =
  process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
    ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
        auth: {
          persistSession: false,
          autoRefreshToken: false,
        },
        global: {
          headers: { "X-Client-Info": "anime-details-api" },
        },
      })
    : null;

/* ===============================
   TTL CONFIG  (ms)
================================ */
const TTL = {
  HOME: 1000 * 60 * 60 * 4,           // 4h
  DETAILS: 1000 * 60 * 60 * 24,        // 1d
  SEARCH: 1000 * 60 * 60 * 6,          // 6h
  CHARACTERS: 1000 * 60 * 60 * 24,
  RECOMMENDATIONS: 1000 * 60 * 60 * 24,
  SEASONS: 1000 * 60 * 60 * 24,
  EPISODES: 1000 * 60 * 60 * 6,        // <-- was MISSING in your code
  EPISODES_AIRING: 1000 * 60 * 30,     // 30m for airing shows
  JIKAN_DETAILS: 1000 * 60 * 60 * 24 * 7,
  JIKAN_SEARCH: 1000 * 60 * 60 * 24,
  ID_MAP: 1000 * 60 * 60 * 24 * 30,
  STREAM: 1000 * 60 * 60 * 24 * 7,
  ANIKOTO_MAP: 1000 * 60 * 60 * 24 * 30,
  SCHEDULE: 1000 * 60 * 60 * 6,
  TMDB: 1000 * 60 * 60 * 24 * 7,
};

/* ===============================
   IN-MEMORY LRU CACHE (Layer 1)
   Sits in front of Supabase so 99% of reads never hit the DB.
================================ */
const memCache = new LRUCache({
  max: 5000,                 // up to 5k entries
  ttl: 1000 * 60 * 60 * 2,   // default 2h, individual sets override
  allowStale: true,          // return stale while we refresh
  updateAgeOnGet: false,
});

function memGet(key) {
  return memCache.get(key);
}
function memSet(key, value, ttl) {
  if (value === undefined || value === null) return;
  memCache.set(key, value, { ttl });
}

/* ===============================
   REQUEST COALESCING
   If 100 users ask for the same cold key at once,
   we only fetch ONCE and everyone awaits the same Promise.
================================ */
const inflight = new Map();
function coalesce(key, factory) {
  if (inflight.has(key)) return inflight.get(key);
  const p = Promise.resolve()
    .then(factory)
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

/* ===============================
   GRAPHQL FIELDS
================================ */
const MEDIA_FIELDS = `
  id idMal
  title { romaji english native }
  description bannerImage
  coverImage { extraLarge large medium }
  genres averageScore episodes status format season seasonYear isAdult
  nextAiringEpisode { episode }
`;

const SAFE_FILTER = `isAdult: false, genre_not_in: ["Hentai", "Ecchi"]`;

/* ===============================
   UTILS
================================ */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stripHtml = (h = "") => String(h).replace(/<[^>]*>/g, "").replace(/\n/g, " ").trim();

function normalizeAnime(media) {
  if (!media) return null;
  const cover =
    media.coverImage?.extraLarge ||
    media.coverImage?.large ||
    media.coverImage?.medium ||
    null;
  const title =
    media.title?.english || media.title?.romaji || media.title?.native || "Anime";
  return {
    id: media.id,
    anilistId: media.id,
    malId: media.idMal || null,
    title,
    name: title,
    poster: cover,
    image: cover,
    banner: media.bannerImage || cover,
    bannerImage: media.bannerImage || cover,
    description: stripHtml(media.description) || "No description available.",
    synopsis: stripHtml(media.description) || "No description available.",
    type: media.format,
    format: media.format,
    episodes: media.episodes || media.nextAiringEpisode?.episode || "?",
    totalEpisodes: media.episodes || media.nextAiringEpisode?.episode || "?",
    status: media.status,
    year: media.seasonYear,
    season: media.season,
    score: media.averageScore ? media.averageScore / 10 : null,
    genres: media.genres || [],
  };
}

function safeAnimeList(list = []) {
  const blocked = ["Hentai", "Ecchi"];
  return list
    .filter(Boolean)
    .filter((a) => !a.isAdult)
    .filter((a) => !(a.genres || []).some((g) => blocked.includes(g)))
    .map(normalizeAnime)
    .filter(Boolean);
}

function cleanJikanAnime(anime) {
  if (!anime) return null;
  const image =
    anime.images?.webp?.large_image_url ||
    anime.images?.jpg?.large_image_url ||
    anime.images?.webp?.image_url ||
    anime.images?.jpg?.image_url ||
    null;
  const title =
    anime.title_english || anime.title || anime.title_japanese || "Anime";
  return {
    malId: anime.mal_id,
    id: anime.mal_id,
    url: anime.url,
    title,
    name: title,
    titleEnglish: anime.title_english,
    titleJapanese: anime.title_japanese,
    titles: anime.titles || [],
    titleSynonyms: anime.title_synonyms || [],
    image,
    poster: image,
    banner: image,
    bannerImage: image,
    trailer: {
      youtubeId: anime.trailer?.youtube_id || null,
      url: anime.trailer?.url || null,
      embedUrl: anime.trailer?.embed_url || null,
      image:
        anime.trailer?.images?.maximum_image_url ||
        anime.trailer?.images?.large_image_url ||
        anime.trailer?.images?.medium_image_url ||
        null,
    },
    type: anime.type,
    format: anime.type,
    source: anime.source,
    episodes: anime.episodes,
    totalEpisodes: anime.episodes,
    status: anime.status,
    airing: anime.airing,
    score: anime.score,
    scoredBy: anime.scored_by,
    rank: anime.rank,
    popularity: anime.popularity,
    members: anime.members,
    favorites: anime.favorites,
    duration: anime.duration,
    rating: anime.rating,
    season: anime.season,
    year: anime.year,
    aired: {
      from: anime.aired?.from || null,
      to: anime.aired?.to || null,
      string: anime.aired?.string || null,
    },
    broadcast: {
      day: anime.broadcast?.day || null,
      time: anime.broadcast?.time || null,
      timezone: anime.broadcast?.timezone || null,
      string: anime.broadcast?.string || null,
    },
    studios: anime.studios?.map((s) => s.name) || [],
    producers: anime.producers?.map((p) => p.name) || [],
    licensors: anime.licensors?.map((l) => l.name) || [],
    genres: anime.genres?.map((g) => g.name) || [],
    explicitGenres: anime.explicit_genres?.map((g) => g.name) || [],
    themes: anime.themes?.map((t) => t.name) || [],
    demographics: anime.demographics?.map((d) => d.name) || [],
    description: anime.synopsis || "No description available.",
    synopsis: anime.synopsis || "No description available.",
    background: anime.background,
  };
}

/* ===============================================================
   JIKAN FALLBACK HELPERS  (used when AniList is down / returns 403)
   ---------------------------------------------------------------
   These produce the SAME shape the frontend already consumes so the
   anime section keeps working with MyAnimeList (Jikan) data while
   AniList is unavailable. Frontend routes use AniList IDs, so we map
   AniList <-> MAL both ways using Jikan itself.
================================================================ */

// Map a MAL id -> AniList id using Jikan's external links (no AniList call)
async function malToAnilistViaJikan(malId) {
  try {
    const data = await jikanGet(`/anime/${malId}/external`);
    const links = data?.data || [];
    for (const l of links) {
      const name = String(l?.name || "").toLowerCase();
      const url = String(l?.url || "");
      if (name.includes("anilist")) {
        const m = url.match(/anime\/(\d+)/);
        if (m) return Number(m[1]);
      }
    }
  } catch {
    /* ignore */
  }
  return null;
}

// Given a frontend-facing id (usually AniList id), find the MAL entry.
// We try Jikan search using a title if provided, else assume the id may be MAL.
async function resolveMalId(idOrAnilist, titleHint = "") {
  // Cached AniList->MAL map?
  const mapKey = `anilist-mal-${idOrAnilist}`;
  const cachedMap = await cacheGet("search_cache", mapKey);
  if (cachedMap?.data) return cachedMap.data;

  // 1) Try treating it as a MAL id directly (Jikan will 404 if wrong)
  try {
    const direct = await jikanGet(`/anime/${idOrAnilist}`);
    if (direct?.data?.mal_id) {
      await cacheSet("search_cache", mapKey, direct.data.mal_id, TTL.ID_MAP);
      return direct.data.mal_id;
    }
  } catch {
    /* not a MAL id, continue */
  }

  // 2) Fall back to searching by title hint
  if (titleHint) {
    try {
      const s = await jikanGet("/anime", { q: titleHint, limit: 1 });
      const hit = s?.data?.[0];
      if (hit?.mal_id) {
        await cacheSet("search_cache", mapKey, hit.mal_id, TTL.ID_MAP);
        return hit.mal_id;
      }
    } catch {
      /* ignore */
    }
  }
  return null;
}

// Full anime details built purely from Jikan
async function getAnimeDetailsViaJikan(idOrAnilist) {
  const malId = await resolveMalId(idOrAnilist);
  if (!malId) return null;
  try {
    const j = await jikanGet(`/anime/${malId}/full`);
    const base = cleanJikanAnime(j?.data);
    if (!base) return null;

    // Best-effort relations from Jikan
    let relations = [];
    try {
      const rel = await jikanGet(`/anime/${malId}/relations`);
      relations = (rel?.data || []).flatMap((group) =>
        (group.entry || [])
          .filter((e) => e.type === "anime")
          .map((e) => ({
            relationType: group.relation,
            node: {
              id: e.mal_id,
              malId: e.mal_id,
              title: { romaji: e.name, english: e.name },
              coverImage: { large: null },
            },
          }))
      );
    } catch {
      /* ignore */
    }

    return {
      ...base,
      // keep the id the frontend asked for so links stay stable
      id: idOrAnilist,
      anilistId: idOrAnilist,
      malId: base.malId,
      relations,
      ranking: base.rank ? [{ rank: base.rank, type: "RATED", allTime: true }] : [],
      studios: base.studios || [],
      _source: "jikan-fallback",
    };
  } catch (err) {
    console.log("Jikan details fallback failed:", err?.response?.status || err.message);
    return null;
  }
}

// Category browsing purely from Jikan (top/seasonal/search based)
async function getCategoryViaJikan(type, page = 1, genre = "") {
  const perPage = 24;
  let path = "/top/anime";
  let params = { page, limit: perPage };

  const filterMap = {
    "top-airing": { path: "/top/anime", params: { filter: "airing" } },
    "most-popular": { path: "/top/anime", params: { filter: "bypopularity" } },
    "most-favorite": { path: "/top/anime", params: { filter: "favorite" } },
    "top-upcoming": { path: "/top/anime", params: { filter: "upcoming" } },
    "latest-completed": { path: "/top/anime", params: {} },
    "recently-added": { path: "/seasons/now", params: {} },
    "recently-updated": { path: "/seasons/now", params: {} },
    movies: { path: "/top/anime", params: { type: "movie" } },
    "tv-series": { path: "/top/anime", params: { type: "tv" } },
    ovas: { path: "/top/anime", params: { type: "ova" } },
    onas: { path: "/top/anime", params: { type: "ona" } },
    specials: { path: "/top/anime", params: { type: "special" } },
  };

  if (type === "genre" && genre) {
    // Map genre name -> MAL genre id via Jikan genres endpoint
    path = "/anime";
    params = { q: "", order_by: "popularity", sort: "asc", page, limit: perPage };
    try {
      const genresList = await jikanGet("/genres/anime");
      const g = (genresList?.data || []).find(
        (x) => String(x.name).toLowerCase() === genre.toLowerCase()
      );
      if (g?.mal_id) params.genres = g.mal_id;
    } catch {
      /* ignore */
    }
  } else if (filterMap[type]) {
    path = filterMap[type].path;
    params = { page, limit: perPage, ...filterMap[type].params };
  }

  try {
    const data = await jikanGet(path, params);
    const list = data?.data || [];
    // Convert to normalized shape and map MAL->AniList ids where possible
    const results = await Promise.all(
      list.map(async (a) => {
        const cleaned = cleanJikanAnime(a);
        if (!cleaned) return null;
        // keep MAL id as id fallback; frontend can still open via details
        return { ...cleaned, id: cleaned.malId, anilistId: cleaned.malId };
      })
    );
    const pag = data?.pagination || {};
    return {
      category: type,
      genre: type === "genre" ? genre : undefined,
      page,
      results: results.filter(Boolean),
      paginationInfo: {
        total: pag?.items?.total || results.length,
        currentPage: pag?.current_page || page,
        lastPage: pag?.last_visible_page || page,
        hasNextPage: !!pag?.has_next_page,
      },
      _source: "jikan-fallback",
    };
  } catch (err) {
    console.log("Jikan category fallback failed:", err?.response?.status || err.message);
    return {
      category: type,
      genre: type === "genre" ? genre : undefined,
      page,
      results: [],
      paginationInfo: { total: 0, currentPage: page, lastPage: 1, hasNextPage: false },
      _source: "jikan-fallback-empty",
    };
  }
}

/* ===============================
   TWO-LAYER CACHE (memory -> supabase)
================================ */
async function cacheGet(table, key) {
  // Layer 1: memory
  const m = memGet(`${table}:${key}`);
  if (m) return { fresh: true, data: m, layer: "memory" };

  // Layer 2: supabase
  if (!supabase) return null;
  const { data, error } = await supabase
    .from(table)
    .select("payload, ttl, updated_at")
    .eq("cache_key", String(key))
    .maybeSingle();
  if (error || !data) return null;

  const age = Date.now() - new Date(data.updated_at).getTime();
  const fresh = age < Number(data.ttl);

  // Promote to memory
  if (fresh) memSet(`${table}:${key}`, data.payload, Math.min(Number(data.ttl), 1000 * 60 * 60 * 2));

  return { fresh, data: data.payload, layer: "supabase" };
}

async function cacheSet(table, key, payload, ttl) {
  if (!payload) return;
  // Never cache empty results — prevents "poisoned" empty cache during outages
  if (Array.isArray(payload) && payload.length === 0) return;
  if (Array.isArray(payload?.results) && payload.results.length === 0) return;
  memSet(`${table}:${key}`, payload, Math.min(ttl, 1000 * 60 * 60 * 2));
  if (!supabase) return;
  const { error } = await supabase.from(table).upsert({
    cache_key: String(key),
    payload,
    ttl,
    updated_at: new Date().toISOString(),
  });
  if (error) console.error("Supabase save error:", table, error.message);
}

async function cacheDelete(table, key) {
  memCache.delete(`${table}:${key}`);
  if (!supabase) return;
  await supabase.from(table).delete().eq("cache_key", String(key));
}

/* ===============================
   ANILIST  --  PARALLEL + RATE LIMITED
   AniList allows ~90 req/min normal, 30/min degraded.
   We use a token bucket: 1 token per 750ms, burst of 5.
================================ */
const ANILIST_INTERVAL = 750; // ms between tokens (~80/min, safe)
const ANILIST_BURST = 5;
let anilistTokens = ANILIST_BURST;
let anilistLastRefill = Date.now();

async function takeAnilistToken() {
  while (true) {
    const now = Date.now();
    const elapsed = now - anilistLastRefill;
    const refill = Math.floor(elapsed / ANILIST_INTERVAL);
    if (refill > 0) {
      anilistTokens = Math.min(ANILIST_BURST, anilistTokens + refill);
      anilistLastRefill = now;
    }
    if (anilistTokens > 0) {
      anilistTokens--;
      return;
    }
    await sleep(80);
  }
}

/* ===============================================================
   ANILIST OUTAGE CIRCUIT-BREAKER
   ---------------------------------------------------------------
   AniList periodically disables its public API (returns HTTP 403 with
   an "API has been temporarily disabled" message). When that happens we
   flip a breaker so we stop hammering the dead endpoint and immediately
   fall back to Jikan. The breaker auto-resets after a cooldown so the
   site heals itself once AniList comes back online.
================================================================ */
let anilistDownUntil = 0;
const ANILIST_COOLDOWN_MS = 1000 * 60 * 10; // 10 minutes

function markAnilistDown() {
  anilistDownUntil = Date.now() + ANILIST_COOLDOWN_MS;
  console.log("⚠️  AniList marked DOWN — falling back to Jikan for", ANILIST_COOLDOWN_MS / 60000, "min");
}
function isAnilistDown() {
  return Date.now() < anilistDownUntil;
}

async function anilist(query, variables = {}, retries = 3) {
  // Short-circuit if AniList is known to be down (avoids slow retries)
  if (isAnilistDown()) {
    const e = new Error("AniList API temporarily unavailable (circuit open)");
    e.anilistDown = true;
    throw e;
  }

  await takeAnilistToken();
  try {
    const res = await axios.post(
      ANILIST,
      { query, variables },
      {
        timeout: 30000,
        headers: { "Content-Type": "application/json", Accept: "application/json" },
      }
    );
    // AniList can return 200 with a GraphQL-level error, or the disabled msg
    if (res.data?.errors?.length) {
      const msg = res.data.errors[0]?.message || "";
      if (/disabled|unavailable|maintenance/i.test(msg)) {
        markAnilistDown();
        const e = new Error("AniList API disabled: " + msg);
        e.anilistDown = true;
        throw e;
      }
    }
    return res.data?.data;
  } catch (err) {
    if (err.anilistDown) throw err;
    const status = err?.response?.status;
    const bodyMsg =
      err?.response?.data?.errors?.[0]?.message ||
      (typeof err?.response?.data === "string" ? err.response.data : "");

    // 403 = AniList disabled their API globally -> open the breaker
    if (status === 403 || /disabled|temporarily/i.test(bodyMsg)) {
      markAnilistDown();
      const e = new Error("AniList API disabled (403)");
      e.anilistDown = true;
      throw e;
    }
    if (status === 429 && retries > 0) {
      const retryAfter = Number(err.response.headers["retry-after"]) || 5;
      console.log(`AniList 429, waiting ${retryAfter}s`);
      await sleep(retryAfter * 1000);
      return anilist(query, variables, retries - 1);
    }
    if ((status >= 500 || !status) && retries > 0) {
      await sleep(800);
      return anilist(query, variables, retries - 1);
    }
    console.log("AniList Error:", status || err.message);
    throw err;
  }
}

/* ===============================
   JIKAN  --  3 req/sec rate limit
================================ */
const JIKAN_INTERVAL = 350; // ~3 req/sec
let jikanLast = 0;

async function jikanGet(path, params = {}, retries = 2) {
  const now = Date.now();
  const wait = Math.max(0, jikanLast + JIKAN_INTERVAL - now);
  if (wait > 0) await sleep(wait);
  jikanLast = Date.now();
  try {
    const res = await axios.get(`${JIKAN}${path}`, {
      params,
      timeout: 25000,
      headers: { Accept: "application/json" },
    });
    return res.data;
  } catch (err) {
    const status = err?.response?.status;
    if (status === 429 && retries > 0) {
      await sleep(2000);
      return jikanGet(path, params, retries - 1);
    }
    throw err;
  }
}

/* ===============================
   MAL <-> ANILIST
================================ */
async function convertMalToAniList(malId) {
  const key = `mal-anilist-${malId}`;
  const cached = await cacheGet("search_cache", key);
  if (cached?.fresh) return cached.data;

  return coalesce(`mal2anilist:${malId}`, async () => {
    try {
      const data = await anilist(
        `query ($idMal: Int) { Media(idMal: $idMal, type: ANIME) { id } }`,
        { idMal: Number(malId) }
      );
      const id = data?.Media?.id || null;
      if (id) await cacheSet("search_cache", key, id, TTL.ID_MAP);
      return id;
    } catch {
      // AniList down -> resolve the AniList id via Jikan's external links
      const id = await malToAnilistViaJikan(malId);
      if (id) await cacheSet("search_cache", key, id, TTL.ID_MAP);
      return id;
    }
  });
}

/* ===============================
   SEARCH
================================ */
async function searchAniList(keyword) {
  try {
    const data = await anilist(
      `query ($search: String) {
        Page(page: 1, perPage: 25) {
          media(search: $search, type: ANIME, sort: POPULARITY_DESC, ${SAFE_FILTER}) {
            ${MEDIA_FIELDS}
          }
        }
      }`,
      { search: keyword }
    );
    const list = safeAnimeList(data?.Page?.media || []);
    if (list.length) return list;
    // AniList returned nothing -> try Jikan
    return await searchJikan(keyword);
  } catch (err) {
    console.log("AniList search failed:", err?.response?.status || err.message, "-> Jikan fallback");
    return await searchJikan(keyword);
  }
}

async function searchJikan(keyword) {
  try {
    const data = await jikanGet("/anime", { q: keyword, limit: 25 });
    const cleaned = (data?.data || []).map(cleanJikanAnime).filter(Boolean);

    // Parallelize MAL->AniList conversions
    const final = await Promise.all(
      cleaned.map(async (a) => {
        const anilistId = a.malId ? await convertMalToAniList(a.malId) : null;
        return { ...a, anilistId: anilistId || a.malId, id: anilistId || a.malId };
      })
    );
    return final;
  } catch (err) {
    console.log("Jikan search failed:", err?.response?.status || err.message);
    return [];
  }
}

/* ===============================
   ANIME DETAILS
================================ */
async function getAnimeDetails(anilistId) {
  const key = `anime-details-${anilistId}`;
  const cached = await cacheGet("anime_details", key);
  if (cached?.fresh) return cached.data;

  return coalesce(`details:${anilistId}`, async () => {
    try {
      const data = await anilist(
        `query ($id: Int) {
          Media(id: $id, type: ANIME) {
            ${MEDIA_FIELDS}
            trailer { id site thumbnail }
            rankings { rank type allTime }
            studios(isMain: true) { nodes { name } }
            relations {
              edges {
                relationType
                node { id title { romaji english } coverImage { large } }
              }
            }
          }
        }`,
        { id: Number(anilistId) }
      );
      const media = data?.Media;
      if (!media) return null;

      // Jikan extras (best-effort, don't block details)
      let jikan = null;
      if (media.idMal) {
        try {
          const j = await jikanGet(`/anime/${media.idMal}/full`);
          jikan = cleanJikanAnime(j?.data);
        } catch {
          /* ignore */
        }
      }

      const normalized = normalizeAnime(media);
      const finalData = {
        ...normalized,
        malId: media.idMal,
        trailer: jikan?.trailer || media.trailer || null,
        studios:
          jikan?.studios || media.studios?.nodes?.map((s) => s.name) || [],
        relations: media.relations?.edges || [],
        ranking: media.rankings || [],
        popularity: jikan?.popularity || null,
        members: jikan?.members || null,
        favorites: jikan?.favorites || null,
        broadcast: jikan?.broadcast || null,
        duration: jikan?.duration || null,
        rating: jikan?.rating || null,
        source: jikan?.source || null,
      };

      await cacheSet("anime_details", key, finalData, TTL.DETAILS);
      return finalData;
    } catch (err) {
      console.log("Details error:", err?.response?.status || err.message);
      // Serve stale cache first if available
      if (cached?.data) return cached.data;
      // Otherwise fall back to Jikan (works when AniList is down)
      const jikanData = await getAnimeDetailsViaJikan(anilistId);
      if (jikanData) {
        await cacheSet("anime_details", key, jikanData, TTL.DETAILS);
        return jikanData;
      }
      return null;
    }
  });
}

async function getAniListAiredEpisodeCount(anilistId) {
  try {
    const data = await anilist(
      `query ($id: Int) {
        Media(id: $id, type: ANIME) {
          episodes status nextAiringEpisode { episode }
        }
      }`,
      { id: Number(anilistId) }
    );
    const media = data?.Media;
    if (!media) return 0;
    if (media.nextAiringEpisode?.episode)
      return Math.max(0, Number(media.nextAiringEpisode.episode) - 1);
    return Number(media.episodes || 0);
  } catch {
    return 0;
  }
}

/* ===============================
   EPISODES  --  PARALLEL Jikan pages
================================ */
async function getAnimeEpisodes(anilistId, forceRefresh = false) {
  const key = `anime-episodes-${anilistId}`;
  const details = await getAnimeDetails(anilistId);
  if (!details?.malId) return [];

  const isAiring = /airing|releasing/i.test(details.status || "");
  const episodeTTL = isAiring ? TTL.EPISODES_AIRING : TTL.EPISODES;

  if (!forceRefresh) {
    const cached = await cacheGet("anime_episodes", key);
    if (cached?.fresh) return cached.data;
  }

  return coalesce(`episodes:${anilistId}`, async () => {
    try {
      // Probe page 1 to learn total pages
      const first = await jikanGet(`/anime/${details.malId}/episodes`, { page: 1 });
      const lastPage = Math.min(Number(first?.pagination?.last_visible_page || 1), 80);
      const all = [...(first?.data || [])];

      // Fetch remaining pages in parallel batches of 3 (Jikan = 3 req/sec)
      const pages = [];
      for (let p = 2; p <= lastPage; p++) pages.push(p);

      const batchSize = 3;
      for (let i = 0; i < pages.length; i += batchSize) {
        const batch = pages.slice(i, i + batchSize);
        const results = await Promise.all(
          batch.map((p) =>
            jikanGet(`/anime/${details.malId}/episodes`, { page: p })
              .then((r) => r?.data || [])
              .catch(() => [])
          )
        );
        results.forEach((eps) => all.push(...eps));
      }

      let final = all
        .map((ep, idx) => {
          const n = Number(ep.mal_id) || idx + 1;
          return {
            id: n,
            number: n,
            episodeId: n,
            episodeNumber: n,
            title: ep.title || ep.title_japanese || `Episode ${n}`,
            description: ep.synopsis || "",
            image:
              ep.images?.jpg?.image_url || ep.images?.webp?.image_url || null,
            aired: ep.aired || null,
            filler: Boolean(ep.filler),
            recap: Boolean(ep.recap),
            score: ep.score || null,
          };
        })
        .filter((e) => e.number)
        .sort((a, b) => a.number - b.number);

      // Fill gaps with AniList aired count
      const aired = await getAniListAiredEpisodeCount(anilistId);
      if (aired > final.length) {
        for (let n = final.length + 1; n <= aired; n++) {
          final.push({
            id: n,
            number: n,
            episodeId: n,
            episodeNumber: n,
            title: `Episode ${n}`,
            description: "",
            image: null,
            aired: null,
            filler: false,
            recap: false,
            score: null,
          });
        }
      }
      final.sort((a, b) => a.number - b.number);

      await cacheSet("anime_episodes", key, final, episodeTTL);
      return final;
    } catch (err) {
      console.log("getAnimeEpisodes error:", err?.response?.status || err.message);
      return [];
    }
  });
}

/* ===============================
   HOME  (with stale-while-revalidate)
================================ */
let homeRefreshInFlight = false;

async function fetchFreshHome() {
  const query = `
    query {
      trending: Page(page: 1, perPage: 12) {
        media(type: ANIME, sort: TRENDING_DESC, ${SAFE_FILTER}) { ${MEDIA_FIELDS} }
      }
      popular: Page(page: 1, perPage: 12) {
        media(type: ANIME, sort: POPULARITY_DESC, ${SAFE_FILTER}) { ${MEDIA_FIELDS} }
      }
      airing: Page(page: 1, perPage: 12) {
        media(type: ANIME, status: RELEASING, sort: POPULARITY_DESC, ${SAFE_FILTER}) { ${MEDIA_FIELDS} }
      }
      latest: Page(page: 1, perPage: 20) {
        media(type: ANIME, sort: START_DATE_DESC, ${SAFE_FILTER}) { ${MEDIA_FIELDS} }
      }
      completed: Page(page: 1, perPage: 12) {
        media(type: ANIME, status: FINISHED, sort: END_DATE_DESC, ${SAFE_FILTER}) { ${MEDIA_FIELDS} }
      }
      favorite: Page(page: 1, perPage: 12) {
        media(type: ANIME, sort: FAVOURITES_DESC, ${SAFE_FILTER}) { ${MEDIA_FIELDS} }
      }
      upcoming: Page(page: 1, perPage: 12) {
        media(type: ANIME, status: NOT_YET_RELEASED, sort: POPULARITY_DESC, ${SAFE_FILTER}) { ${MEDIA_FIELDS} }
      }
    }
  `;
  let data;
  try {
    data = await anilist(query);
  } catch (err) {
    console.log("Home AniList failed:", err.message, "-> Jikan fallback");
    return await fetchFreshHomeViaJikan();
  }
  const out = {
    spotlights: safeAnimeList(data?.trending?.media || []),
    trending: safeAnimeList(data?.trending?.media || []),
    top_airing: safeAnimeList(data?.airing?.media || []),
    most_popular: safeAnimeList(data?.popular?.media || []),
    latest_episode: safeAnimeList(data?.latest?.media || []),
    recently_added: safeAnimeList(data?.latest?.media || []),
    latest_completed: safeAnimeList(data?.completed?.media || []),
    most_favorite: safeAnimeList(data?.favorite?.media || []),
    top_upcoming: safeAnimeList(data?.upcoming?.media || []),
    todaySchedule: [],
    genres: [],
    topten: [],
  };
  // If AniList responded but with empty data, still fall back to Jikan
  if (!out.trending.length && !out.most_popular.length) {
    return await fetchFreshHomeViaJikan();
  }
  await cacheSet("home_cache", "home-main", out, TTL.HOME);
  return out;
}

// Build the home payload entirely from Jikan (AniList-down fallback)
async function fetchFreshHomeViaJikan() {
  const mapList = (arr = []) =>
    (arr || [])
      .map(cleanJikanAnime)
      .filter(Boolean)
      .map((a) => ({ ...a, id: a.malId, anilistId: a.malId }));

  // Sequential-ish to respect Jikan's 3 req/sec limit (jikanGet self-throttles)
  const [airing, popular, upcoming, favorite, seasonNow, top] = await Promise.all([
    jikanGet("/top/anime", { filter: "airing", limit: 12 }).then((d) => d?.data).catch(() => []),
    jikanGet("/top/anime", { filter: "bypopularity", limit: 12 }).then((d) => d?.data).catch(() => []),
    jikanGet("/top/anime", { filter: "upcoming", limit: 12 }).then((d) => d?.data).catch(() => []),
    jikanGet("/top/anime", { filter: "favorite", limit: 12 }).then((d) => d?.data).catch(() => []),
    jikanGet("/seasons/now", { limit: 20 }).then((d) => d?.data).catch(() => []),
    jikanGet("/top/anime", { limit: 12 }).then((d) => d?.data).catch(() => []),
  ]);

  const trending = mapList(seasonNow).length ? mapList(seasonNow) : mapList(top);
  const out = {
    spotlights: trending.slice(0, 12),
    trending,
    top_airing: mapList(airing),
    most_popular: mapList(popular),
    latest_episode: mapList(seasonNow),
    recently_added: mapList(seasonNow),
    latest_completed: mapList(top),
    most_favorite: mapList(favorite),
    top_upcoming: mapList(upcoming),
    todaySchedule: [],
    genres: [],
    topten: mapList(top).slice(0, 10),
    _source: "jikan-fallback",
  };
  await cacheSet("home_cache", "home-main", out, TTL.HOME);
  return out;
}

async function getHomeData() {
  // Memory hit
  const mem = memGet("home_cache:home-main");
  if (mem) return mem;

  // Supabase hit (any freshness)
  if (supabase) {
    const { data } = await supabase
      .from("home_cache")
      .select("payload, ttl, updated_at")
      .eq("cache_key", "home-main")
      .maybeSingle();

    if (data?.payload) {
      const age = Date.now() - new Date(data.updated_at).getTime();
      const fresh = age < Number(data.ttl);
      memSet("home_cache:home-main", data.payload, 1000 * 60 * 30);

      // Stale-while-revalidate
      if (!fresh && !homeRefreshInFlight) {
        homeRefreshInFlight = true;
        fetchFreshHome()
          .catch((e) => console.log("home bg refresh failed:", e.message))
          .finally(() => (homeRefreshInFlight = false));
      }
      return data.payload;
    }
  }

  // Cold fetch (coalesced)
  return coalesce("home:fetch", async () => {
    try {
      return await fetchFreshHome();
    } catch (err) {
      console.log("Home error:", err?.response?.status || err.message);
      return {
        spotlights: [], trending: [], top_airing: [], most_popular: [],
        latest_episode: [], recently_added: [], latest_completed: [],
        most_favorite: [], top_upcoming: [], todaySchedule: [], genres: [], topten: [],
      };
    }
  });
}

/* ===============================
   TMDB  --  PARALLEL season fetch
================================ */
function normalizeTmdbText(value = "") {
  return String(value)
    .toLowerCase()
    .replace(/season\s*\d+/gi, "")
    .replace(/\d+(st|nd|rd|th)?\s*season/gi, "")
    .replace(/part\s*\d+/gi, "")
    .replace(/cour\s*\d+/gi, "")
    .replace(/[^a-z0-9]/g, "");
}

function yearDistance(tmdbDate, animeYear) {
  if (!tmdbDate || !animeYear) return 99;
  const y = Number(String(tmdbDate).slice(0, 4));
  return Math.abs(y - Number(animeYear));
}

function isLikelyAnimeTmdbShow(item, details) {
  const name = String(item.name || item.title || "").toLowerCase();
  const original = String(item.original_name || "").toLowerCase();
  if (!item?.id) return false;
  if (item.media_type && item.media_type !== "tv") return false;
  const bad = ["live action", "live-action", "behind the scenes", "making of", "specials", "documentary"];
  if (bad.some((w) => name.includes(w) || original.includes(w))) return false;
  const animeYear = details.year || details.seasonYear;
  const diff = yearDistance(item.first_air_date, animeYear);
  if (item.original_language === "ja") return true;
  if (diff <= 1) return true;
  return false;
}

function scoreTmdbCandidate(item, details, targetTitle) {
  let score = 0;
  const tmdbName = normalizeTmdbText(item.name);
  const tmdbOriginal = normalizeTmdbText(item.original_name);
  const target = normalizeTmdbText(targetTitle);
  if (tmdbName === target) score += 80;
  if (tmdbOriginal === target) score += 80;
  if (tmdbName.includes(target) || target.includes(tmdbName)) score += 35;
  if (tmdbOriginal.includes(target) || target.includes(tmdbOriginal)) score += 35;
  if (item.original_language === "ja") score += 60;
  const animeYear = details.year || details.seasonYear;
  const diff = yearDistance(item.first_air_date, animeYear);
  if (diff === 0) score += 35;
  else if (diff === 1) score += 20;
  else if (diff <= 3) score += 8;
  else score -= 25;
  score += Number(item.popularity || 0) / 10;
  return score;
}

async function getTmdbAnimeData(anilistId, forceRefresh = false) {
  const cacheKey = `tmdb-anime-${anilistId}`;
  if (!forceRefresh) {
    const cached = await cacheGet("search_cache", cacheKey);
    if (cached?.fresh) return cached.data;
  }

  return coalesce(`tmdb:${anilistId}`, async () => {
    try {
      const details = await getAnimeDetails(anilistId);
      if (!details || !process.env.TMDB_API_KEY) return null;

      const title = details.title || details.name || "Anime";

      const simple = (v = "") => String(v).toLowerCase().replace(/[^a-z0-9]/g, "");
      const normalize = (v = "") => String(v).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
      const titleMatchScore = (a = "", b = "") => {
        const x = simple(a), y = simple(b);
        if (!x || !y) return 0;
        if (x === y) return 100;
        if (x.includes(y) || y.includes(x)) return 70;
        const ax = new Set(normalize(a).split(" ").filter(Boolean));
        const by = new Set(normalize(b).split(" ").filter(Boolean));
        let same = 0;
        for (const w of ax) if (by.has(w)) same++;
        return same * 12;
      };

      const extractSeasonNumber = (value = "") => {
        const text = String(value).toLowerCase();
        const words = { first:1, second:2, third:3, fourth:4, fifth:5, sixth:6, seventh:7, eighth:8, ninth:9, tenth:10 };
        for (const [w, n] of Object.entries(words)) if (text.includes(`${w} season`)) return n;
        const m = text.match(/season\s*(\d+)/i) || text.match(/(\d+)(st|nd|rd|th)?\s*season/i) || text.match(/\bs(\d+)\b/i);
        return m?.[1] ? Number(m[1]) : null;
      };

      const cleanBaseTitle = (value = "") =>
        String(value)
          .replace(/season\s*\d+/gi, "")
          .replace(/\d+(st|nd|rd|th)?\s*season/gi, "")
          .replace(/\b(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\s+season\b/gi, "")
          .replace(/\s+part\s+\d+/gi, "")
          .replace(/\s+cour\s+\d+/gi, "")
          .replace(/[:\-–—]+$/g, "")
          .trim();

      const rawTitles = [
        details.title, details.name, details.titleEnglish, details.englishTitle,
        details.romajiTitle, details.titleRomaji, details.nativeTitle, details.titleNative,
      ].filter(Boolean);

      const wantedSeason = rawTitles.map(extractSeasonNumber).find(Boolean) || null;
      const searchTitles = [...new Set([...rawTitles.map(cleanBaseTitle), ...rawTitles].filter(Boolean))];

      // Run all TMDB title searches in parallel
      const searches = await Promise.all(
        searchTitles.map((t) =>
          axios
            .get(`${TMDB}/search/tv`, {
              params: { api_key: process.env.TMDB_API_KEY, query: t },
              timeout: 15000,
            })
            .then((r) => ({ t, results: r.data?.results || [] }))
            .catch(() => ({ t, results: [] }))
        )
      );

      let bestShow = null;
      let bestScore = -999;
      for (const { t, results } of searches) {
        for (const item of results) {
          if (!isLikelyAnimeTmdbShow(item, details)) continue;
          let score = scoreTmdbCandidate(item, details, t);
          score += titleMatchScore(item.name, t);
          score += titleMatchScore(item.original_name, t);
          if (item.original_language === "ja") score += 50;
          if (score > bestScore) { bestScore = score; bestShow = item; }
        }
      }

      if (!bestShow?.id) {
        const empty = {
          tmdbId: null, imdbId: null, title, logo: null,
          seasonNumber: wantedSeason || null, episodes: [],
          warning: "TMDB show not found.",
        };
        await cacheSet("search_cache", cacheKey, empty, TTL.TMDB);
        return empty;
      }

      const tv = await axios.get(`${TMDB}/tv/${bestShow.id}`, {
        params: {
          api_key: process.env.TMDB_API_KEY,
          append_to_response: "images,external_ids",
          include_image_language: "en,null,ja",
        },
        timeout: 20000,
      });
      const tvData = tv.data;

      const logo =
        tvData?.images?.logos?.find((x) => x.iso_639_1 === "en") ||
        tvData?.images?.logos?.find((x) => x.iso_639_1 === "ja") ||
        tvData?.images?.logos?.find((x) => !x.iso_639_1) ||
        tvData?.images?.logos?.[0];

      // PARALLEL: Jikan episodes + TMDB seasons
      const seasons = (tvData?.seasons || [])
        .filter((s) => Number(s.season_number) > 0)
        .sort((a, b) => Number(a.season_number) - Number(b.season_number));

      const [localEpisodes, allTmdbEpsArrays] = await Promise.all([
        // local episodes (parallel pages)
        (async () => {
          if (!details.malId) return [];
          try {
            const first = await jikanGet(`/anime/${details.malId}/episodes`, { page: 1 });
            const last = Math.min(Number(first?.pagination?.last_visible_page || 1), 80);
            const collected = [...(first?.data || [])];
            const pages = [];
            for (let p = 2; p <= last; p++) pages.push(p);
            const batch = 3;
            for (let i = 0; i < pages.length; i += batch) {
              const slice = pages.slice(i, i + batch);
              const results = await Promise.all(
                slice.map((p) =>
                  jikanGet(`/anime/${details.malId}/episodes`, { page: p })
                    .then((r) => r?.data || [])
                    .catch(() => [])
                )
              );
              results.forEach((eps) => collected.push(...eps));
            }
            return collected;
          } catch {
            return [];
          }
        })(),
        // TMDB seasons in PARALLEL (was sequential before)
        Promise.all(
          seasons.map((s) =>
            axios
              .get(`${TMDB}/tv/${bestShow.id}/season/${s.season_number}`, {
                params: { api_key: process.env.TMDB_API_KEY },
                timeout: 20000,
              })
              .then((r) =>
                (r.data?.episodes || []).map((ep) => ({
                  ...ep,
                  realSeasonNumber: Number(s.season_number),
                }))
              )
              .catch(() => [])
          )
        ),
      ]);

      let allTmdbEpisodes = allTmdbEpsArrays
        .flat()
        .filter((ep) => ep?.episode_number)
        .sort((a, b) => {
          const dA = new Date(a.air_date || "1900-01-01").getTime();
          const dB = new Date(b.air_date || "1900-01-01").getTime();
          if (dA !== dB) return dA - dB;
          return Number(a.episode_number) - Number(b.episode_number);
        });

      const isLong =
        allTmdbEpisodes.length >= 100 ||
        Number(details.episodes || details.totalEpisodes || 0) >= 100;

      let startIndex = 0;
      let matchScore = null;
      if (!isLong) {
        let bestStart = -999;
        const localTitles = localEpisodes
          .map((ep) => ep.title || ep.title_japanese)
          .filter(Boolean);
        const localCount =
          localEpisodes.length ||
          Number(details.episodes || details.totalEpisodes || 0) ||
          1;
        const maxStart = Math.max(0, allTmdbEpisodes.length - localCount);
        for (let i = 0; i <= maxStart; i++) {
          let score = 0;
          const limit = Math.min(localTitles.length, localCount, 12);
          for (let j = 0; j < limit; j++) {
            const lt = localTitles[j];
            const tt = allTmdbEpisodes[i + j]?.name;
            if (lt && tt) score += titleMatchScore(lt, tt);
          }
          const animeYear = Number(details.year || details.seasonYear || 0);
          const firstYear = Number(String(allTmdbEpisodes[i]?.air_date || "").slice(0, 4));
          if (animeYear && firstYear) {
            const diff = Math.abs(animeYear - firstYear);
            if (diff === 0) score += 150;
            else if (diff === 1) score += 80;
            else if (diff <= 2) score += 30;
            else score -= 50;
          }
          if (score > bestStart) { bestStart = score; startIndex = i; }
        }
        matchScore = bestStart;
      }

      // Re:ZERO Season 4 manual fix
      if (Number(anilistId) === 189046) {
        const idx = allTmdbEpisodes.findIndex(
          (ep) => Number(ep.realSeasonNumber) === 1 && Number(ep.episode_number) === 67
        );
        if (idx !== -1) startIndex = idx;
      }

      const totalCount = isLong
        ? allTmdbEpisodes.length
        : localEpisodes.length ||
          Number(details.episodes || details.totalEpisodes || 0) ||
          allTmdbEpisodes.length;

      const selected = allTmdbEpisodes.slice(startIndex, startIndex + totalCount);

      const episodes = selected.map((tmdbEp, i) => {
        const localEp = localEpisodes[i];
        const epNumber = isLong
          ? i + 1
          : Number(localEp?.mal_id) ||
            Number(localEp?.episodeNumber) ||
            Number(localEp?.number) ||
            i + 1;
        return {
          episodeNumber: epNumber,
          seasonNumber: wantedSeason || null,
          tmdbSeasonNumber: tmdbEp?.realSeasonNumber || null,
          tmdbEpisodeNumber: tmdbEp?.episode_number || null,
          title:
            localEp?.title || localEp?.title_japanese || tmdbEp?.name || `Episode ${epNumber}`,
          tmdbTitle: tmdbEp?.name || null,
          image: tmdbEp?.still_path ? `${TMDB_IMAGE}${tmdbEp.still_path}` : null,
          overview: tmdbEp?.overview || localEp?.synopsis || "",
          airDate: tmdbEp?.air_date || localEp?.aired || null,
        };
      });

      const finalData = {
        tmdbId: bestShow.id,
        imdbId: tvData?.external_ids?.imdb_id || null,
        title,
        tmdbTitle: tvData?.name || bestShow.name || null,
        logo: logo?.file_path ? `${TMDB_IMAGE}${logo.file_path}` : null,
        seasonNumber: wantedSeason || null,
        tmdbSeasonNumber: episodes[0]?.tmdbSeasonNumber || null,
        tmdbStartEpisode: episodes[0]?.tmdbEpisodeNumber || null,
        matchScore,
        totalReturned: episodes.length,
        episodes,
      };

      await cacheSet("search_cache", cacheKey, finalData, TTL.TMDB);
      return finalData;
    } catch (err) {
      console.log("TMDB error:", err.message);
      return null;
    }
  });
}

/* ===============================
   STREAM RESOLVERS
================================ */
async function searchAnikotoSeries(title) {
  // Minimal stub since the original code referenced it but didn't define it;
  // we cache and look it up by title.
  const key = `anikoto-search-${title.toLowerCase()}`;
  const cached = await cacheGet("search_cache", key);
  if (cached?.fresh) return cached.data;

  try {
    const res = await axios.get(`${ANIKOTO}/search`, {
      params: { q: title },
      timeout: 15000,
    });
    const item = res.data?.results?.[0] || res.data?.[0] || null;
    if (item) await cacheSet("search_cache", key, item, TTL.ANIKOTO_MAP);
    return item;
  } catch {
    return null;
  }
}

async function resolveAnikoto(animeTitle, episode, lang = "sub") {
  try {
    const series = await searchAnikotoSeries(animeTitle);
    if (!series?.id) return null;
    const res = await axios.get(`${ANIKOTO}/series/${series.id}`, { timeout: 20000 });
    const eps = res.data?.episodes || [];
    const found = eps.find((ep) => Number(ep.number) === Number(episode));
    if (!found?.embed_id) return null;
    return {
      source: "anikoto",
      success: true,
      embed: `${MEGAPLAY}/stream/s-2/${found.embed_id}/${lang}`,
      episodeData: found,
    };
  } catch (err) {
    console.log("Anikoto resolve fail:", err.message);
    return null;
  }
}

async function resolveStream(anilistId, ep, lang = "sub") {
  const key = `stream-${anilistId}-${ep}-${lang}`;
  const cached = await cacheGet("stream_cache", key);
  if (cached?.fresh) return cached.data;

  return coalesce(`stream:${key}`, async () => {
    try {
      const details = await getAnimeDetails(anilistId);
      if (!details?.title) return { success: false, reason: "anime-details-not-found" };

      const anikoto = await resolveAnikoto(details.title, ep, lang);
      if (anikoto?.success) {
        await cacheSet("stream_cache", key, anikoto, TTL.STREAM);
        return anikoto;
      }
      return {
        success: false,
        reason: "anikoto-not-mapped",
        title: details.title,
        anilistId,
        episode: ep,
        lang,
      };
    } catch (err) {
      console.log("Resolve stream error:", err.message);
      return { success: false, reason: "resolver-crashed", error: err.message };
    }
  });
}

/* ===============================
   ROUTES
================================ */
app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    mode: "smart-hybrid-anilist-jikan-megaplay-anikoto",
    uptime: process.uptime(),
    memCacheSize: memCache.size,
    inflightCount: inflight.size,
    time: Date.now(),
  });
});

app.get("/api/home", async (req, res) => {
  try {
    res.json(await getHomeData());
  } catch (err) {
    res.status(500).json({ status: "error", error: "Home failed", debug: err.message });
  }
});

app.get("/api/search", async (req, res) => {
  const keyword = String(req.query.keyword || req.query.q || "").trim();
  if (!keyword) return res.json({ status: "ok", source: "empty", results: [] });

  const cacheKey = `search-${keyword.toLowerCase()}`;
  try {
    const cached = await cacheGet("search_cache", cacheKey);
    if (cached?.fresh && Array.isArray(cached.data) && cached.data.length > 0) {
      return res.json({ status: "ok", source: `cache-${cached.layer}`, results: cached.data });
    }
    const results = await coalesce(`search:${cacheKey}`, async () => {
      let r = await searchAniList(keyword);
      if (!r.length) r = await searchJikan(keyword);
      await cacheSet("search_cache", cacheKey, r, TTL.SEARCH);
      return r;
    });
    res.json({ status: "ok", source: results.length ? "smart-search" : "empty", results });
  } catch (err) {
    console.log("Search error:", err?.response?.status || err.message);
    const fallback = await cacheGet("search_cache", cacheKey);
    if (fallback?.data) return res.json({ status: "ok", source: "stale-cache", results: fallback.data });
    res.json({ status: "ok", source: "failed", results: [] });
  }
});

app.get("/api/details/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ status: "error", error: "Invalid anime ID" });
  const data = await getAnimeDetails(id);
  if (!data) return res.status(404).json({ status: "error", error: "Anime not found" });
  res.json(data);
});

app.get("/api/smart/details/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ status: "error", error: "Invalid anime ID" });
  const data = await getAnimeDetails(id);
  if (!data) return res.status(404).json({ status: "error", error: "Anime not found" });
  res.json({ status: "ok", source: "smart-hybrid", data });
});

app.get("/api/episodes/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ status: "error", results: [] });
  const forceRefresh =
    String(req.query.refresh || "").toLowerCase() === "true" ||
    String(req.query.force || "").toLowerCase() === "true";
  if (forceRefresh) await cacheDelete("anime_episodes", `anime-episodes-${id}`);
  const episodes = await getAnimeEpisodes(id, forceRefresh);
  res.json({ status: "ok", forceRefresh, total: episodes.length, results: episodes });
});

app.get("/api/stream/resolve/:id", async (req, res) => {
  const id = Number(req.params.id);
  const ep = Number(req.query.ep || 1);
  const lang = String(req.query.lang || "sub").toLowerCase() === "dub" ? "dub" : "sub";
  if (!id || !ep) return res.status(400).json({ status: "error", error: "Missing anime ID or episode" });
  try {
    const stream = await resolveStream(id, ep, lang);
    if (!stream?.success) return res.status(404).json({ status: "error", error: "Stream not found", ...stream });
    res.json({ status: "ok", ...stream, url: stream.embed, provider: stream.source });
  } catch (err) {
    res.status(500).json({ status: "error", error: "Stream resolve failed", debug: err.message });
  }
});

app.get("/api/jikan/anime/:malId", async (req, res) => {
  const malId = Number(req.params.malId);
  if (!malId) return res.status(400).json({ status: "error", error: "Invalid MAL ID" });
  try {
    const data = await jikanGet(`/anime/${malId}/full`);
    res.json({ status: "ok", source: "jikan", data: cleanJikanAnime(data?.data) });
  } catch (err) {
    res.status(500).json({ status: "error", error: "Jikan anime failed", debug: err.message });
  }
});

app.get("/api/jikan/from-anilist/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ status: "error", error: "Invalid AniList ID" });
  try {
    const details = await getAnimeDetails(id);
    if (!details?.malId) return res.status(404).json({ status: "error", error: "MAL ID not found" });
    const data = await jikanGet(`/anime/${details.malId}/full`);
    res.json({
      status: "ok",
      source: "jikan-from-anilist",
      anilistId: id,
      malId: details.malId,
      data: cleanJikanAnime(data?.data),
    });
  } catch (err) {
    res.status(500).json({ status: "error", error: "Jikan from AniList failed", debug: err.message });
  }
});

app.get("/api/recommendations/:id", async (req, res) => {
  const id = Number(req.params.id);
  try {
    const key = `recommendations-${id}`;
    const cached = await cacheGet("anime_recommendations", key);
    if (cached?.fresh) return res.json({ status: "ok", results: cached.data });

    const results = await coalesce(`recs:${id}`, async () => {
      const data = await anilist(
        `query ($id: Int) {
          Media(id: $id, type: ANIME) {
            recommendations(page: 1, perPage: 12) {
              nodes { mediaRecommendation { ${MEDIA_FIELDS} } }
            }
          }
        }`,
        { id }
      );
      const r = safeAnimeList(
        data?.Media?.recommendations?.nodes?.map((i) => i.mediaRecommendation) || []
      );
      await cacheSet("anime_recommendations", key, r, TTL.RECOMMENDATIONS);
      return r;
    });
    res.json({ status: "ok", results });
  } catch {
    res.json({ status: "ok", results: [] });
  }
});

app.get("/api/seasons/:id", async (req, res) => {
  const id = Number(req.params.id);
  try {
    const key = `seasons-${id}`;
    const cached = await cacheGet("anime_seasons", key);
    if (cached?.fresh) return res.json({ status: "ok", results: cached.data });

    const results = await coalesce(`seasons:${id}`, async () => {
      const data = await anilist(
        `query ($id: Int) {
          Media(id: $id, type: ANIME) {
            relations { edges { relationType node { ${MEDIA_FIELDS} } } }
          }
        }`,
        { id }
      );
      const r = safeAnimeList(
        data?.Media?.relations?.edges
          ?.filter((e) => ["SEQUEL", "PREQUEL", "SIDE_STORY", "SPIN_OFF"].includes(e.relationType))
          ?.map((e) => e.node) || []
      );
      await cacheSet("anime_seasons", key, r, TTL.SEASONS);
      return r;
    });
    res.json({ status: "ok", results });
  } catch {
    res.json({ status: "ok", results: [] });
  }
});

app.get("/api/category/:type", async (req, res) => {
  const type = String(req.params.type || "").trim();
  const page = Math.max(1, Number(req.query.page || 1));
  const genre = String(req.query.genre || "").trim();
  const cacheKey = `category-${type}-${genre || "_"}-${page}`;

  try {
    const cached = await cacheGet("search_cache", cacheKey);
    if (cached?.fresh && Array.isArray(cached.data?.results) && cached.data.results.length > 0) {
      return res.json({ status: "ok", source: "cache", ...cached.data });
    }

    const payload = await coalesce(`category:${cacheKey}`, async () => {
      const sortMap = {
        "recently-added": "START_DATE_DESC",
        "recently-updated": "UPDATED_AT_DESC",
        "most-popular": "POPULARITY_DESC",
        movies: "POPULARITY_DESC",
        "tv-series": "POPULARITY_DESC",
        ovas: "POPULARITY_DESC",
        onas: "POPULARITY_DESC",
        specials: "POPULARITY_DESC",
      };
      const formatMap = {
        movies: "MOVIE", "tv-series": "TV", ovas: "OVA", onas: "ONA", specials: "SPECIAL",
      };

      let query;
      let variables = { page };

      if (type === "genre") {
        if (!genre) {
          return {
            category: "genre", genre: "", page, results: [],
            paginationInfo: { total: 0, currentPage: page, lastPage: 1, hasNextPage: false },
          };
        }
        query = `
          query ($page: Int, $genre: String) {
            Page(page: $page, perPage: 24) {
              pageInfo { total currentPage lastPage hasNextPage }
              media(type: ANIME, genre: $genre, sort: POPULARITY_DESC, isAdult: false) { ${MEDIA_FIELDS} }
            }
          }`;
        variables = { page, genre };
      } else if (type === "top-airing") {
        query = `
          query ($page: Int) {
            Page(page: $page, perPage: 24) {
              pageInfo { total currentPage lastPage hasNextPage }
              media(type: ANIME, status: RELEASING, sort: POPULARITY_DESC, isAdult: false) { ${MEDIA_FIELDS} }
            }
          }`;
      } else if (type === "top-upcoming") {
        query = `
          query ($page: Int) {
            Page(page: $page, perPage: 24) {
              pageInfo { total currentPage lastPage hasNextPage }
              media(type: ANIME, status: NOT_YET_RELEASED, sort: POPULARITY_DESC, isAdult: false) { ${MEDIA_FIELDS} }
            }
          }`;
      } else if (type === "most-favorite") {
        query = `
          query ($page: Int) {
            Page(page: $page, perPage: 24) {
              pageInfo { total currentPage lastPage hasNextPage }
              media(type: ANIME, sort: FAVOURITES_DESC, isAdult: false) { ${MEDIA_FIELDS} }
            }
          }`;
      } else if (type === "latest-completed") {
        query = `
          query ($page: Int) {
            Page(page: $page, perPage: 24) {
              pageInfo { total currentPage lastPage hasNextPage }
              media(type: ANIME, status: FINISHED, sort: END_DATE_DESC, isAdult: false) { ${MEDIA_FIELDS} }
            }
          }`;
      } else {
        query = `
          query ($page: Int, $sort: [MediaSort], $format: MediaFormat) {
            Page(page: $page, perPage: 24) {
              pageInfo { total currentPage lastPage hasNextPage }
              media(type: ANIME, sort: $sort, format: $format, isAdult: false) { ${MEDIA_FIELDS} }
            }
          }`;
        variables = { page, sort: sortMap[type] || "POPULARITY_DESC", format: formatMap[type] || null };
      }

      let results = [];
      let pageInfo = null;
      try {
        const data = await anilist(query, variables);
        results = safeAnimeList(data?.Page?.media || []);
        pageInfo = data?.Page?.pageInfo || null;
      } catch (err) {
        // AniList failed/down -> use Jikan category fallback
        console.log("Category AniList failed:", err.message, "-> Jikan fallback");
        const jk = await getCategoryViaJikan(type, page, genre);
        if (jk.results.length) {
          await cacheSet("search_cache", cacheKey, jk, TTL.SEARCH);
          return jk;
        }
      }

      const out = {
        category: type,
        genre: type === "genre" ? genre : undefined,
        page,
        results,
        paginationInfo: pageInfo || {
          total: results.length, currentPage: page, lastPage: page, hasNextPage: results.length >= 24,
        },
      };
      if (results.length) await cacheSet("search_cache", cacheKey, out, TTL.SEARCH);
      return out;
    });

    res.json({ status: "ok", ...payload });
  } catch (err) {
    // Last-resort: try Jikan directly so the section never returns 500
    try {
      const jk = await getCategoryViaJikan(type, page, genre);
      return res.json({ status: "ok", source: "jikan-fallback", ...jk });
    } catch {
      res.status(500).json({ status: "error", error: "Category failed", debug: err.message, results: [] });
    }
  }
});

app.get("/api/top-search", async (req, res) => {
  try {
    const cached = await cacheGet("search_cache", "top-search");
    if (cached?.fresh) return res.json({ status: "ok", results: cached.data });

    const results = await coalesce("top-search", async () => {
      const data = await anilist(`
        query {
          Page(page: 1, perPage: 10) {
            media(type: ANIME, sort: TRENDING_DESC, ${SAFE_FILTER}) { ${MEDIA_FIELDS} }
          }
        }
      `);
      const r = safeAnimeList(data?.Page?.media || []).map((a, i) => ({ rank: i + 1, ...a }));
      await cacheSet("search_cache", "top-search", r, TTL.HOME);
      return r;
    });
    res.json({ status: "ok", results });
  } catch {
    res.json({ status: "ok", results: [] });
  }
});

app.get("/api/schedule", async (req, res) => {
  const date = String(req.query.date || "").trim();
  if (!date) return res.json({ status: "ok", results: [] });

  const cacheKey = `schedule-${date}`;
  try {
    const cached = await cacheGet("schedule_cache", cacheKey);
    if (cached?.fresh) return res.json({ status: "ok", source: "cache", date, results: cached.data });

    const results = await coalesce(`schedule:${date}`, async () => {
      const start = Math.floor(new Date(`${date}T00:00:00Z`).getTime() / 1000);
      const end = Math.floor(new Date(`${date}T23:59:59Z`).getTime() / 1000);
      const data = await anilist(
        `query ($start: Int, $end: Int) {
          Page(page: 1, perPage: 50) {
            airingSchedules(airingAt_greater: $start, airingAt_lesser: $end, sort: TIME) {
              id episode airingAt
              media {
                id idMal
                title { romaji english native }
                coverImage { large extraLarge }
                bannerImage format episodes isAdult genres
              }
            }
          }
        }`,
        { start, end }
      );
      const list =
        data?.Page?.airingSchedules
          ?.filter((i) => i?.media && !i.media.isAdult)
          ?.filter((i) => {
            const g = i.media.genres || [];
            return !g.includes("Hentai") && !g.includes("Ecchi");
          })
          ?.map((i) => {
            const m = i.media;
            const t = m.title?.english || m.title?.romaji || m.title?.native || "Anime";
            return {
              id: m.id, anilistId: m.id, malId: m.idMal, title: t, name: t,
              episode: i.episode, airingAt: i.airingAt,
              time: new Date(i.airingAt * 1000).toLocaleTimeString("en-IN", {
                hour: "2-digit", minute: "2-digit", hour12: true,
              }),
              image: m.coverImage?.extraLarge || m.coverImage?.large,
              poster: m.coverImage?.extraLarge || m.coverImage?.large,
              banner: m.bannerImage || m.coverImage?.extraLarge,
              type: m.format || "TV",
              episodes: m.episodes || "?",
            };
          }) || [];
      await cacheSet("schedule_cache", cacheKey, list, TTL.SCHEDULE);
      return list;
    });
    res.json({ status: "ok", source: "anilist", date, results });
  } catch (err) {
    console.log("Schedule error:", err?.response?.status || err.message);
    const fallback = await cacheGet("schedule_cache", cacheKey);
    if (fallback?.data) return res.json({ status: "ok", source: "stale-cache", date, results: fallback.data });
    res.json({ status: "ok", source: "failed", date, results: [] });
  }
});

app.get("/api/tmdb/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ status: "error", data: null });
  const forceRefresh =
    String(req.query.refresh || "").toLowerCase() === "true" ||
    String(req.query.force || "").toLowerCase() === "true";
  if (forceRefresh) await cacheDelete("search_cache", `tmdb-anime-${id}`);
  const data = await getTmdbAnimeData(id, forceRefresh);
  res.json({ status: "ok", forceRefresh, data });
});

/* ===============================
   GLOBAL ERROR GUARDS
================================ */
process.on("unhandledRejection", (err) => {
  console.error("UNHANDLED REJECTION:", err?.message || err);
});
process.on("uncaughtException", (err) => {
  console.error("UNCAUGHT EXCEPTION:", err?.message || err);
});

app.listen(PORT, () => {
  console.log(`🔥 OFFANIME Smart Hybrid API running on http://localhost:${PORT}`);
});
