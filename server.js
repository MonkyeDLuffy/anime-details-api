import express from "express";
import cors from "cors";
import axios from "axios";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 10000;
const JIKAN = "https://api.jikan.moe/v4";

app.use(cors());
app.use(express.json());

const supabase =
  process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
    ? createClient(
        process.env.SUPABASE_URL,
        process.env.SUPABASE_SERVICE_ROLE_KEY
      )
    : null;

const TTL = {
  HOME: 1000 * 60 * 60 * 6,
  DETAILS: 1000 * 60 * 60 * 24 * 7,
  SEARCH: 1000 * 60 * 60 * 24,
  CATEGORY: 1000 * 60 * 60 * 12,
  EPISODES: 1000 * 60 * 60 * 24 * 7,
  SEASONS: 1000 * 60 * 60 * 24 * 7,
  RECOMMENDATIONS: 1000 * 60 * 60 * 24 * 7,
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getSupabaseCache(table, cacheKey) {
  if (!supabase) return null;

  const { data, error } = await supabase
    .from(table)
    .select("payload, ttl, updated_at")
    .eq("cache_key", String(cacheKey))
    .maybeSingle();

  if (error || !data) return null;

  const age = Date.now() - new Date(data.updated_at).getTime();
  const fresh = age < Number(data.ttl);

  return {
    fresh,
    data: data.payload,
  };
}

async function setSupabaseCache(table, cacheKey, payload, ttl) {
  if (!supabase || !payload) return;

  const { error } = await supabase.from(table).upsert({
    cache_key: String(cacheKey),
    payload,
    ttl,
    updated_at: new Date().toISOString(),
  });

  if (error) {
    console.error("Supabase save error:", table, error.message);
  } else {
    console.log("✅ SUPABASE SAVED:", table, cacheKey);
  }
}

function cleanTitle(anime) {
  return (
    anime?.title_english ||
    anime?.title ||
    anime?.title_japanese ||
    "Anime"
  );
}

function cleanJikanAnime(anime) {
  if (!anime) return null;

  const image =
    anime.images?.webp?.large_image_url ||
    anime.images?.jpg?.large_image_url ||
    anime.images?.webp?.image_url ||
    anime.images?.jpg?.image_url ||
    null;

  return {
    id: anime.mal_id,
    malId: anime.mal_id,
    anilistId: anime.mal_id,
    url: anime.url,

    title: cleanTitle(anime),
    name: cleanTitle(anime),
    titleEnglish: anime.title_english,
    titleJapanese: anime.title_japanese,
    titles: anime.titles || [],
    titleSynonyms: anime.title_synonyms || [],

    poster: image,
    image,
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

    type: anime.type || "TV",
    format: anime.type || "TV",
    source: anime.source,
    episodes: anime.episodes || null,
    totalEpisodes: anime.episodes || null,
    status: anime.status || "Unknown",
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

async function jikanGet(path, params = {}) {
  const response = await axios.get(`${JIKAN}${path}`, {
    params,
    timeout: 25000,
    headers: {
      Accept: "application/json",
    },
  });

  return response.data;
}

function sortSearchResults(results, keyword) {
  const q = keyword.toLowerCase();

  return results.sort((a, b) => {
    const aExact =
      a.title?.toLowerCase() === q || a.titleEnglish?.toLowerCase() === q;
    const bExact =
      b.title?.toLowerCase() === q || b.titleEnglish?.toLowerCase() === q;

    if (aExact && !bExact) return -1;
    if (!aExact && bExact) return 1;

    const aTv = a.type === "TV";
    const bTv = b.type === "TV";

    if (aTv && !bTv) return -1;
    if (!aTv && bTv) return 1;

    return (b.members || 0) - (a.members || 0);
  });
}

app.get("/", (req, res) => {
  res.send("🔥 OFFANIME Jikan API Running");
});

app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    source: "jikan-only",
    uptime: process.uptime(),
    time: Date.now(),
  });
});

/* HOME */
app.get("/api/home", async (req, res) => {
  try {
    const cached = await getSupabaseCache("home_cache", "jikan-home");

    if (cached?.fresh) {
      console.log("✅ HOME CACHE HIT");
      return res.json(cached.data);
    }

    const [top, airing, upcoming, movies] = await Promise.all([
      jikanGet("/top/anime", { limit: 12, filter: "bypopularity", sfw: true }),
      jikanGet("/top/anime", { limit: 12, filter: "airing", sfw: true }),
      jikanGet("/top/anime", { limit: 12, filter: "upcoming", sfw: true }),
      jikanGet("/anime", { limit: 12, type: "movie", order_by: "popularity", sort: "asc", sfw: true }),
    ]);

    const trending = (top.data || []).map(cleanJikanAnime).filter(Boolean);
    const topAiring = (airing.data || []).map(cleanJikanAnime).filter(Boolean);
    const topUpcoming = (upcoming.data || []).map(cleanJikanAnime).filter(Boolean);
    const movieList = (movies.data || []).map(cleanJikanAnime).filter(Boolean);

    const response = {
      status: "ok",
      source: "jikan",
      spotlight: trending.slice(0, 6),
      trending,
      latest_episode: topAiring,
      top_airing: topAiring,
      most_popular: trending,
      most_favorite: trending,
      latest_completed: movieList,
      top_upcoming: topUpcoming,
      recently_added: topAiring,
      genres: [],
    };

    await setSupabaseCache("home_cache", "jikan-home", response, TTL.HOME);

    res.json(response);
  } catch (err) {
    console.error("Home error:", err?.response?.status || err.message);

    const fallback = await getSupabaseCache("home_cache", "jikan-home");
    if (fallback?.data) return res.json(fallback.data);

    res.status(500).json({
      status: "error",
      error: "Home failed",
      debug: err.message,
    });
  }
});

/* DETAILS BY MAL ID */
app.get("/api/details/:id", async (req, res) => {
  const malId = Number(req.params.id);

  if (!malId) {
    return res.status(400).json({ status: "error", error: "Invalid anime ID" });
  }

  try {
    const cacheKey = `jikan-anime-${malId}`;
    const cached = await getSupabaseCache("anime_details", cacheKey);

    if (cached?.fresh) return res.json(cached.data);

    const json = await jikanGet(`/anime/${malId}/full`);
    const anime = cleanJikanAnime(json.data);

    if (!anime) {
      return res.status(404).json({ status: "error", error: "Anime not found" });
    }

    await setSupabaseCache("anime_details", cacheKey, anime, TTL.DETAILS);

    res.json(anime);
  } catch (err) {
    console.error("Details error:", err?.response?.status || err.message);

    const fallback = await getSupabaseCache("anime_details", `jikan-anime-${malId}`);
    if (fallback?.data) return res.json(fallback.data);

    res.status(404).json({
      status: "error",
      error: "Anime details not found",
      debug: err.message,
    });
  }
});

/* JIKAN DETAILS WRAPPER */
app.get("/api/jikan/anime/:malId", async (req, res) => {
  const malId = Number(req.params.malId);

  try {
    const cached = await getSupabaseCache("anime_details", `jikan-anime-${malId}`);

    if (cached?.fresh) {
      return res.json({
        status: "ok",
        source: "cache",
        data: cached.data,
      });
    }

    const json = await jikanGet(`/anime/${malId}/full`);
    const anime = cleanJikanAnime(json.data);

    await setSupabaseCache("anime_details", `jikan-anime-${malId}`, anime, TTL.DETAILS);

    res.json({
      status: "ok",
      source: "jikan",
      data: anime,
    });
  } catch (err) {
    res.status(404).json({
      status: "error",
      error: "Anime not found",
      debug: err.message,
    });
  }
});

/* OLD COMPAT ROUTE — NOW TREATS ID AS MAL ID */
app.get("/api/jikan/from-anilist/:id", async (req, res) => {
  const malId = Number(req.params.id);

  try {
    const json = await jikanGet(`/anime/${malId}/full`);
    const anime = cleanJikanAnime(json.data);

    res.json({
      status: "ok",
      source: "jikan",
      malId,
      data: anime,
    });
  } catch (err) {
    res.status(404).json({
      status: "error",
      error: "Anime not found",
      debug: err.message,
    });
  }
});

/* SEARCH */
app.get("/api/search", async (req, res) => {
  const keyword = String(req.query.keyword || req.query.q || "").trim();

  if (!keyword) {
    return res.json({ status: "ok", results: [] });
  }

  try {
    const cacheKey = `jikan-search-${keyword.toLowerCase()}`;
    const cached = await getSupabaseCache("search_cache", cacheKey);

    if (cached?.fresh) {
      return res.json({
        status: "ok",
        source: "cache",
        results: cached.data,
      });
    }

    const json = await jikanGet("/anime", {
      q: keyword,
      limit: 12,
      sfw: true,
    });

    const results = sortSearchResults(
      (json.data || []).map(cleanJikanAnime).filter(Boolean),
      keyword
    );

    await setSupabaseCache("search_cache", cacheKey, results, TTL.SEARCH);

    res.json({
      status: "ok",
      source: "jikan",
      results,
    });
  } catch (err) {
    console.error("Search error:", err?.response?.status || err.message);

    const fallback = await getSupabaseCache(
      "search_cache",
      `jikan-search-${keyword.toLowerCase()}`
    );

    if (fallback?.data) {
      return res.json({
        status: "ok",
        source: "stale-cache",
        results: fallback.data,
      });
    }

    res.json({ status: "ok", results: [] });
  }
});

app.get("/api/jikan/search", async (req, res) => {
  req.query.keyword = req.query.q || req.query.keyword;
  return app._router.handle(req, res);
});

/* EPISODES */
app.get("/api/episodes/:id", async (req, res) => {
  const malId = Number(req.params.id);

  try {
    const cacheKey = `jikan-episodes-${malId}`;
    const cached = await getSupabaseCache("anime_episodes", cacheKey);

    if (cached?.fresh) return res.json(cached.data);

    const json = await jikanGet(`/anime/${malId}/episodes`, { page: 1 });
    const total = json.pagination?.items?.total || 0;

    const episodes = Array.from({ length: total }, (_, index) => {
      const ep = index + 1;

      return {
        id: `${malId}-${ep}`,
        number: ep,
        episode: ep,
        episodeId: ep,
        title: `Episode ${ep}`,
        image: "",
        thumbnail: "",
        url: `/watch/${malId}?ep=${ep}`,
      };
    });

    const response = {
      status: "ok",
      results: episodes,
    };

    await setSupabaseCache("anime_episodes", cacheKey, response, TTL.EPISODES);

    res.json(response);
  } catch (err) {
    console.error("Episodes error:", err?.response?.status || err.message);

    res.json({
      status: "ok",
      results: [],
    });
  }
});

/* SEASONS / RELATIONS */
app.get("/api/seasons/:id", async (req, res) => {
  const malId = Number(req.params.id);

  try {
    const cacheKey = `jikan-relations-${malId}`;
    const cached = await getSupabaseCache("anime_seasons", cacheKey);

    if (cached?.fresh) return res.json(cached.data);

    const json = await jikanGet(`/anime/${malId}/relations`);

    const entries = [];

    for (const relation of json.data || []) {
      for (const entry of relation.entry || []) {
        if (entry.type === "anime" && entry.mal_id) {
          entries.push({
            id: entry.mal_id,
            malId: entry.mal_id,
            title: entry.name,
            name: entry.name,
            type: relation.relation,
            poster: "",
            image: "",
          });
        }
      }
    }

    const response = {
      status: "ok",
      results: entries,
    };

    await setSupabaseCache("anime_seasons", cacheKey, response, TTL.SEASONS);

    res.json(response);
  } catch (err) {
    console.error("Seasons error:", err?.response?.status || err.message);

    res.json({
      status: "ok",
      results: [],
    });
  }
});

/* RECOMMENDATIONS */
app.get("/api/recommendations/:id", async (req, res) => {
  const malId = Number(req.params.id);

  try {
    const cacheKey = `jikan-recommendations-${malId}`;
    const cached = await getSupabaseCache("anime_recommendations", cacheKey);

    if (cached?.fresh) return res.json(cached.data);

    const json = await jikanGet(`/anime/${malId}/recommendations`);

    const results = (json.data || []).slice(0, 12).map((item) => ({
      id: item.entry?.mal_id,
      malId: item.entry?.mal_id,
      title: item.entry?.title,
      name: item.entry?.title,
      poster: item.entry?.images?.webp?.large_image_url || item.entry?.images?.jpg?.large_image_url || item.entry?.images?.jpg?.image_url || "",
      image: item.entry?.images?.webp?.large_image_url || item.entry?.images?.jpg?.large_image_url || item.entry?.images?.jpg?.image_url || "",
      votes: item.votes,
    }));

    const response = {
      status: "ok",
      results,
    };

    await setSupabaseCache(
      "anime_recommendations",
      cacheKey,
      response,
      TTL.RECOMMENDATIONS
    );

    res.json(response);
  } catch (err) {
    console.error("Recommendations error:", err?.response?.status || err.message);

    res.json({
      status: "ok",
      results: [],
    });
  }
});

/* CATEGORY */
app.get("/api/category/:type", async (req, res) => {
  const type = req.params.type;
  const page = Number(req.query.page || 1);

  try {
    const cacheKey = `jikan-category-${type}-${page}`;
    const cached = await getSupabaseCache("search_cache", cacheKey);

    if (cached?.fresh) return res.json(cached.data);

    let params = {
      page,
      limit: 24,
      sfw: true,
      order_by: "popularity",
      sort: "asc",
    };

    if (type === "movies") params.type = "movie";
    if (type === "tv-series") params.type = "tv";
    if (type === "ovas") params.type = "ova";
    if (type === "onas") params.type = "ona";
    if (type === "specials") params.type = "special";

    const json = await jikanGet("/anime", params);

    const response = {
      status: "ok",
      results: (json.data || []).map(cleanJikanAnime).filter(Boolean),
      paginationInfo: {
        total: json.pagination?.items?.total || 0,
        currentPage: json.pagination?.current_page || page,
        lastPage: json.pagination?.last_visible_page || 1,
        hasNextPage: json.pagination?.has_next_page || false,
      },
    };

    await setSupabaseCache("search_cache", cacheKey, response, TTL.CATEGORY);

    res.json(response);
  } catch (err) {
    console.error("Category error:", err?.response?.status || err.message);

    res.status(500).json({
      status: "error",
      error: "Category failed",
      debug: err.message,
    });
  }
});

/* SCHEDULE - JIKAN DOES NOT PROVIDE LIVE EPISODE SCHEDULE LIKE ANILIST */
app.get("/api/schedule", (req, res) => {
  res.json({
    status: "ok",
    results: [],
  });
});

app.get("/api/top-search", async (req, res) => {
  try {
    const json = await jikanGet("/top/anime", {
      limit: 10,
      filter: "bypopularity",
      sfw: true,
    });

    const results = (json.data || []).map(cleanJikanAnime).map((anime, index) => ({
      rank: index + 1,
      ...anime,
    }));

    res.json({
      status: "ok",
      results,
    });
  } catch (err) {
    res.json({
      status: "ok",
      results: [],
    });
  }
});

app.listen(PORT, () => {
  console.log(`🔥 OFFANIME Jikan-only API running on port ${PORT}`);
});
