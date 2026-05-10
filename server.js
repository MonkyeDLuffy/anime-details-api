import express from "express";
import cors from "cors";
import axios from "axios";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;
const ANILIST = "https://graphql.anilist.co";
const JIKAN = "https://api.jikan.moe/v4";

app.use(cors());
app.use(express.json());

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

function stripHtml(html = "") {
  return String(html).replace(/<[^>]*>/g, "").replace(/\n/g, " ").trim();
}

function normalizeAnime(media) {
  if (!media) return null;

  return {
    id: media.id,
    malId: media.idMal || null,
    title: media.title?.english || media.title?.romaji || media.title?.native,
    poster: media.coverImage?.extraLarge,
    image: media.coverImage?.extraLarge,
    banner: media.bannerImage,
    description: stripHtml(media.description),
    type: media.format,
    episodes: media.episodes || media.nextAiringEpisode?.episode || "?",
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
    .filter((anime) => !anime.isAdult)
    .filter((anime) => {
      const genres = anime.genres || [];
      return !genres.some((g) => blocked.includes(g));
    })
    .map(normalizeAnime)
    .filter(Boolean);
}

async function getSupabaseCache(table, cacheKey) {
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
  if (!payload) return;

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

const anilistQueue = [];
let processingQueue = false;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function processQueue() {
  if (processingQueue) return;

  processingQueue = true;

  while (anilistQueue.length > 0) {
    const item = anilistQueue.shift();

    try {
      const response = await axios.post(
        ANILIST,
        {
          query: item.query,
          variables: item.variables,
        },
        {
          timeout: 30000,
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
          },
        }
      );

      item.resolve(response.data.data);
      await sleep(1200);
    } catch (error) {
      console.log("AniList Error:", error?.response?.status || error.message);
      item.reject(error);
    }
  }

  processingQueue = false;
}

async function anilist(query, variables = {}) {
  return new Promise((resolve, reject) => {
    anilistQueue.push({
      query,
      variables,
      resolve,
      reject,
    });

    processQueue();
  });
}

const TTL = {
  HOME: 1000 * 60 * 60 * 4,
  DETAILS: 1000 * 60 * 60 * 24,
  EPISODES: 1000 * 60 * 60 * 24,
  SEARCH: 1000 * 60 * 60 * 6,
  CHARACTERS: 1000 * 60 * 60 * 24,
  RECOMMENDATIONS: 1000 * 60 * 60 * 24,
  SEASONS: 1000 * 60 * 60 * 24,

  JIKAN_DETAILS: 1000 * 60 * 60 * 24 * 7,
  JIKAN_SEARCH: 1000 * 60 * 60 * 24,
};

const MEDIA_FIELDS = `
  id
  title {
    romaji
    english
    native
  }
  description
  bannerImage
  coverImage {
    extraLarge
    large
    medium
  }
  genres
  averageScore
  episodes
  status
  format
  season
  seasonYear
  isAdult
  idMal
  nextAiringEpisode {
    episode
  }
`;

const SAFE_FILTER = `
  isAdult: false,
  genre_not_in: ["Hentai", "Ecchi"]
`;

function cleanJikanAnime(anime) {
  if (!anime) return null;

  return {
    malId: anime.mal_id,
    url: anime.url,

    title: anime.title,
    titleEnglish: anime.title_english,
    titleJapanese: anime.title_japanese,
    titles: anime.titles || [],
    titleSynonyms: anime.title_synonyms || [],

    image:
      anime.images?.webp?.large_image_url ||
      anime.images?.jpg?.large_image_url ||
      anime.images?.webp?.image_url ||
      anime.images?.jpg?.image_url ||
      null,

    poster:
      anime.images?.webp?.large_image_url ||
      anime.images?.jpg?.large_image_url ||
      anime.images?.webp?.image_url ||
      anime.images?.jpg?.image_url ||
      null,

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
    source: anime.source,
    episodes: anime.episodes,
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

    synopsis: anime.synopsis,
    background: anime.background,
  };
}

app.get("/", (req, res) => {
  res.send("🔥 Anime API Running");
});

app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    uptime: process.uptime(),
    time: Date.now(),
  });
});

/* ===============================
   JIKAN PROXY ROUTES
================================ */

// Get Jikan anime by MAL ID
app.get("/api/jikan/anime/:malId", async (req, res) => {
  const malId = Number(req.params.malId);

  if (!malId) {
    return res.status(400).json({
      status: "error",
      error: "Invalid MAL ID",
    });
  }

  try {
    const cacheKey = `jikan-anime-${malId}`;
    const cached = await getSupabaseCache("anime_details", cacheKey);

    if (cached?.fresh) {
      return res.json({
        status: "ok",
        source: "cache",
        data: cached.data,
      });
    }

    const response = await axios.get(`${JIKAN}/anime/${malId}/full`, {
      timeout: 20000,
      headers: {
        Accept: "application/json",
      },
    });

    const cleaned = cleanJikanAnime(response.data?.data);

    if (!cleaned) {
      return res.status(404).json({
        status: "error",
        error: "Anime not found from Jikan",
      });
    }

    await setSupabaseCache(
      "anime_details",
      cacheKey,
      cleaned,
      TTL.JIKAN_DETAILS
    );

    res.json({
      status: "ok",
      source: "jikan",
      data: cleaned,
    });
  } catch (err) {
    console.error("Jikan anime error:", err?.response?.status || err.message);

    const fallback = await getSupabaseCache("anime_details", `jikan-anime-${malId}`);

    if (fallback?.data) {
      return res.json({
        status: "ok",
        source: "stale-cache",
        data: fallback.data,
      });
    }

    res.status(500).json({
      status: "error",
      error: "Failed to fetch Jikan anime",
      debug: err.message,
    });
  }
});

// Search Jikan by title
app.get("/api/jikan/search", async (req, res) => {
  const keyword = String(req.query.q || req.query.keyword || "").trim();

  if (!keyword) {
    return res.status(400).json({
      status: "error",
      error: "Missing search query. Use ?q=one piece",
    });
  }

  try {
    const cacheKey = `jikan-search-${keyword.toLowerCase()}`;
    // TEMP DISABLE CACHE
// const cached = await getSupabaseCache("search_cache", cacheKey);

// if (cached?.fresh) {
//   return res.json({
//     status: "ok",
//     source: "cache",
//     results: cached.data,
//   });
// }

    const response = await axios.get(`${JIKAN}/anime`, {
      params: {
        q: keyword,
        limit: 8,
        sfw: true,
      },
      timeout: 20000,
      headers: {
        Accept: "application/json",
      },
    });

    const results = (response.data?.data || [])
  .map(cleanJikanAnime)
  .filter(Boolean)
  .sort((a, b) => {
    const q = keyword.toLowerCase();

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

    await setSupabaseCache(
      "search_cache",
      cacheKey,
      results,
      TTL.JIKAN_SEARCH
    );

    res.json({
      status: "ok",
      source: "jikan",
      results,
    });
  } catch (err) {
    console.error("Jikan search error:", err?.response?.status || err.message);

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

    res.status(500).json({
      status: "error",
      error: "Failed to search Jikan",
      debug: err.message,
    });
  }
});

// AniList ID -> Jikan MAL details
app.get("/api/jikan/from-anilist/:id", async (req, res) => {
  const id = Number(req.params.id);

  if (!id) {
    return res.status(400).json({
      status: "error",
      error: "Invalid AniList ID",
    });
  }

  try {
    const cacheKey = `jikan-from-anilist-${id}`;
    const cached = await getSupabaseCache("anime_details", cacheKey);

    if (cached?.fresh) {
      return res.json({
        status: "ok",
        source: "cache",
        data: cached.data,
      });
    }

    const query = `
      query ($id: Int) {
        Media(id: $id, type: ANIME) {
          id
          idMal
          title {
            romaji
            english
            native
          }
        }
      }
    `;

    const data = await anilist(query, { id });
    const media = data?.Media;

    if (!media) {
      return res.status(404).json({
        status: "error",
        error: "AniList anime not found",
      });
    }

    let malId = media.idMal;

    if (!malId) {
      const fallbackTitle =
        media.title?.english || media.title?.romaji || media.title?.native;

      const searchResponse = await axios.get(`${JIKAN}/anime`, {
        params: {
          q: fallbackTitle,
          limit: 1,
          sfw: true,
        },
        timeout: 20000,
      });

      malId = searchResponse.data?.data?.[0]?.mal_id;
    }

    if (!malId) {
      return res.status(404).json({
        status: "error",
        error: "MAL ID not found",
      });
    }

    await sleep(450);

    const jikanResponse = await axios.get(`${JIKAN}/anime/${malId}/full`, {
      timeout: 20000,
      headers: {
        Accept: "application/json",
      },
    });

    const cleaned = cleanJikanAnime(jikanResponse.data?.data);

    await setSupabaseCache(
      "anime_details",
      cacheKey,
      cleaned,
      TTL.JIKAN_DETAILS
    );

    res.json({
      status: "ok",
      source: "jikan",
      anilistId: id,
      malId,
      data: cleaned,
    });
  } catch (err) {
    console.error(
      "Jikan from AniList error:",
      err?.response?.status || err.message
    );

    const fallback = await getSupabaseCache(
      "anime_details",
      `jikan-from-anilist-${id}`
    );

    if (fallback?.data) {
      return res.json({
        status: "ok",
        source: "stale-cache",
        data: fallback.data,
      });
    }

    res.status(500).json({
      status: "error",
      error: "Failed to fetch Jikan data from AniList ID",
      debug: err.message,
    });
  }
});

/* ===============================
   EXISTING ANILIST ROUTES
================================ */

app.get("/api/home", async (req, res) => {
  try {
    const cached = await getSupabaseCache("home_cache", "main");

    if (cached?.fresh) {
      console.log("✅ HOME CACHE HIT");
      return res.json(cached.data);
    }

    console.log("❌ FETCHING FRESH HOME");

    const query = `
      query {
        trending: Page(page: 1, perPage: 12) {
          media(
            sort: TRENDING_DESC,
            type: ANIME,
            ${SAFE_FILTER}
          ) {
            ${MEDIA_FIELDS}
          }
        }

        latest: Page(page: 1, perPage: 18) {
          media(
            sort: UPDATED_AT_DESC,
            type: ANIME,
            status_in: [RELEASING],
            ${SAFE_FILTER}
          ) {
            ${MEDIA_FIELDS}
          }
        }

        topAiring: Page(page: 1, perPage: 12) {
          media(
            sort: SCORE_DESC,
            type: ANIME,
            status: RELEASING,
            format_in: [TV, ONA],
            ${SAFE_FILTER}
          ) {
            ${MEDIA_FIELDS}
          }
        }

        mostFavorite: Page(page: 1, perPage: 12) {
          media(
            sort: FAVOURITES_DESC,
            type: ANIME,
            ${SAFE_FILTER}
          ) {
            ${MEDIA_FIELDS}
          }
        }

        latestCompleted: Page(page: 1, perPage: 12) {
          media(
            sort: END_DATE_DESC,
            type: ANIME,
            status: FINISHED,
            ${SAFE_FILTER}
          ) {
            ${MEDIA_FIELDS}
          }
        }
      }
    `;

    const result = await anilist(query);

    const response = {
      status: "ok",
      spotlight: safeAnimeList(result.trending.media).slice(0, 6),
      trending: safeAnimeList(result.trending.media),
      latest_episode: safeAnimeList(result.latest.media).slice(0, 12),
      top_airing: safeAnimeList(result.topAiring.media),
      most_favorite: safeAnimeList(result.mostFavorite.media),
      latest_completed: safeAnimeList(result.latestCompleted.media),
    };

    await setSupabaseCache("home_cache", "main", response, TTL.HOME);

    res.json(response);
  } catch (err) {
    console.error("Home error:", err.message);

    const fallback = await getSupabaseCache("home_cache", "main");

    if (fallback?.data) {
      return res.json(fallback.data);
    }

    res.status(500).json({
      status: "error",
      results: null,
    });
  }
});

app.get("/api/details/:id", async (req, res) => {
  const id = Number(req.params.id);

  try {
    const cached = await getSupabaseCache("anime_details", id);

    if (cached?.fresh) {
      return res.json(cached.data);
    }

    const query = `
      query ($id: Int) {
        Media(id: $id, type: ANIME) {
          ${MEDIA_FIELDS}
          popularity
          favourites
          studios {
            nodes {
              name
            }
          }
        }
      }
    `;

    const data = await anilist(query, { id });
    const media = data.Media;

    const anime = normalizeAnime(media);
    anime.studios = media.studios?.nodes?.map((s) => s.name) || [];
    anime.popularity = media.popularity || 0;
    anime.favorites = media.favourites || 0;

    await setSupabaseCache("anime_details", id, anime, TTL.DETAILS);

    res.json(anime);
  } catch (err) {
    console.error("Details error:", err.message);

    const fallback = await getSupabaseCache("anime_details", id);

    if (fallback?.data) {
      return res.json(fallback.data);
    }

    res.status(500).json({ title: "Anime" });
  }
});

app.get("/api/episodes/:id", async (req, res) => {
  const id = Number(req.params.id);

  try {
    const cached = await getSupabaseCache("anime_episodes", id);

    if (cached?.fresh) {
      return res.json(cached.data);
    }

    const query = `
      query ($id: Int) {
        Media(id: $id, type: ANIME) {
          id
          episodes
          status
          nextAiringEpisode {
            episode
          }
          title {
            romaji
            english
          }
        }
      }
    `;

    const data = await anilist(query, { id });
    const anime = data.Media;

    let totalEpisodes = 0;

    if (anime.status === "RELEASING" && anime.nextAiringEpisode?.episode) {
      totalEpisodes = anime.nextAiringEpisode.episode - 1;
    } else if (anime.episodes) {
      totalEpisodes = anime.episodes;
    }

    const episodes = Array.from({ length: totalEpisodes }, (_, index) => {
      const ep = index + 1;

      return {
        id: `${anime.id}-${ep}`,
        number: ep,
        episode: ep,
        episodeId: ep,
        title: `Episode ${ep}`,
        image: "",
        thumbnail: "",
        url: `/watch/${anime.id}?ep=${ep}`,
      };
    });

    const response = {
      status: "ok",
      results: episodes,
    };

    await setSupabaseCache("anime_episodes", id, response, TTL.EPISODES);

    res.json(response);
  } catch (err) {
    console.error("Episodes error:", err.message);

    const fallback = await getSupabaseCache("anime_episodes", id);

    if (fallback?.data) {
      return res.json(fallback.data);
    }

    res.json({
      status: "ok",
      results: [],
    });
  }
});

app.get("/api/characters/:id", async (req, res) => {
  const id = Number(req.params.id);

  try {
    const cached = await getSupabaseCache("anime_characters", id);

    if (cached?.fresh) {
      return res.json(cached.data);
    }

    const query = `
      query ($id: Int) {
        Media(id: $id, type: ANIME) {
          characters(page: 1, perPage: 20) {
            edges {
              role
              node {
                id
                name {
                  full
                }
                image {
                  large
                }
              }
              voiceActors(language: JAPANESE) {
                id
                name {
                  full
                }
                image {
                  large
                }
              }
            }
          }
        }
      }
    `;

    const data = await anilist(query, { id });

    const results = data.Media.characters.edges.map((edge) => ({
      role: edge.role,
      character: {
        id: edge.node.id,
        name: edge.node.name.full,
        image: edge.node.image?.large,
      },
      voiceActor: edge.voiceActors?.[0]
        ? {
            id: edge.voiceActors[0].id,
            name: edge.voiceActors[0].name.full,
            image: edge.voiceActors[0].image?.large,
          }
        : null,
    }));

    const response = {
      status: "ok",
      results,
    };

    await setSupabaseCache("anime_characters", id, response, TTL.CHARACTERS);

    res.json(response);
  } catch (err) {
    console.error("Characters error:", err.message);

    const fallback = await getSupabaseCache("anime_characters", id);

    if (fallback?.data) {
      return res.json(fallback.data);
    }

    res.json({
      status: "ok",
      results: [],
    });
  }
});

app.get("/api/recommendations/:id", async (req, res) => {
  const id = Number(req.params.id);

  try {
    const cached = await getSupabaseCache("anime_recommendations", id);

    if (cached?.fresh) {
      return res.json(cached.data);
    }

    const query = `
      query ($id: Int) {
        Media(id: $id, type: ANIME) {
          recommendations(page: 1, perPage: 12) {
            nodes {
              mediaRecommendation {
                ${MEDIA_FIELDS}
              }
            }
          }
        }
      }
    `;

    const data = await anilist(query, { id });

    const results = safeAnimeList(
      data.Media.recommendations.nodes.map((item) => item.mediaRecommendation)
    );

    const response = {
      status: "ok",
      results,
    };

    await setSupabaseCache(
      "anime_recommendations",
      id,
      response,
      TTL.RECOMMENDATIONS
    );

    res.json(response);
  } catch (err) {
    console.error("Recommendations error:", err.message);

    const fallback = await getSupabaseCache("anime_recommendations", id);

    if (fallback?.data) {
      return res.json(fallback.data);
    }

    res.json({
      status: "ok",
      results: [],
    });
  }
});

app.get("/api/search", async (req, res) => {
  const keyword = String(req.query.keyword || "").trim();

  if (!keyword) {
    return res.json({
      status: "ok",
      results: [],
    });
  }

  const searchKey = keyword.toLowerCase();

  try {
    const cached = await getSupabaseCache("search_cache", searchKey);

    if (cached?.fresh) {
      return res.json(cached.data);
    }

    const query = `
      query ($search: String) {
        Page(page: 1, perPage: 18) {
          media(
            search: $search,
            type: ANIME,
            ${SAFE_FILTER}
          ) {
            ${MEDIA_FIELDS}
          }
        }
      }
    `;

    const data = await anilist(query, { search: keyword });

    const response = {
      status: "ok",
      results: safeAnimeList(data.Page.media),
    };

    await setSupabaseCache("search_cache", searchKey, response, TTL.SEARCH);

    res.json(response);
  } catch (err) {
    console.error("Search error:", err.message);

    const fallback = await getSupabaseCache("search_cache", searchKey);

    if (fallback?.data) {
      return res.json(fallback.data);
    }

    res.json({
      status: "ok",
      results: [],
    });
  }
});

app.get("/api/seasons/:id", async (req, res) => {
  const id = Number(req.params.id);

  try {
    const cached = await getSupabaseCache("anime_seasons", id);

    if (cached?.fresh) {
      return res.json(cached.data);
    }

    const query = `
      query ($id: Int) {
        Media(id: $id, type: ANIME) {
          relations {
            edges {
              relationType
              node {
                ${MEDIA_FIELDS}
              }
            }
          }
        }
      }
    `;

    const data = await anilist(query, { id });

    const related = data.Media.relations.edges
      .filter((edge) => ["SEQUEL", "PREQUEL"].includes(edge.relationType))
      .map((edge) => edge.node);

    const response = {
      status: "ok",
      results: safeAnimeList(related),
    };

    await setSupabaseCache("anime_seasons", id, response, TTL.SEASONS);

    res.json(response);
  } catch (err) {
    console.error("Seasons error:", err.message);

    const fallback = await getSupabaseCache("anime_seasons", id);

    if (fallback?.data) {
      return res.json(fallback.data);
    }

    res.json({
      status: "ok",
      results: [],
    });
  }
});

app.get("/api/schedule", async (req, res) => {
  try {
    const date = req.query.date;

    if (!date) {
      return res.json({
        status: "ok",
        results: [],
      });
    }

    const query = `
      query ($page: Int, $airingAtGreater: Int, $airingAtLesser: Int) {
        Page(page: $page, perPage: 50) {
          airingSchedules(
            airingAt_greater: $airingAtGreater,
            airingAt_lesser: $airingAtLesser,
            sort: TIME
          ) {
            airingAt
            episode
            media {
              ${MEDIA_FIELDS}
            }
          }
        }
      }
    `;

    const start = Math.floor(
      new Date(`${date}T00:00:00+05:30`).getTime() / 1000
    );

    const end = Math.floor(
      new Date(`${date}T23:59:59+05:30`).getTime() / 1000
    );

    const data = await anilist(query, {
      page: 1,
      airingAtGreater: start,
      airingAtLesser: end,
    });

    const results = data.Page.airingSchedules
      .filter((item) => item.media && !item.media.isAdult)
      .filter((item) => {
        const genres = item.media.genres || [];
        return !genres.includes("Hentai") && !genres.includes("Ecchi");
      })
      .map((item) => {
        const anime = normalizeAnime(item.media);

        return {
          ...anime,
          airingAt: item.airingAt,
          time: new Date(item.airingAt * 1000).toLocaleTimeString("en-IN", {
            hour: "2-digit",
            minute: "2-digit",
            hour12: true,
          }),
          episode: item.episode,
          title: anime.title,
        };
      });

    res.json({
      status: "ok",
      results,
    });
  } catch (err) {
    console.error("Schedule error:", err.message);

    res.status(500).json({
      error: "Schedule failed",
      debug: err.message,
    });
  }
});

app.get("/api/top-search", async (req, res) => {
  try {
    const query = `
      query {
        Page(perPage: 10) {
          media(
            sort: TRENDING_DESC,
            type: ANIME,
            ${SAFE_FILTER}
          ) {
            ${MEDIA_FIELDS}
          }
        }
      }
    `;

    const data = await anilist(query);

    const results = safeAnimeList(data.Page.media).map((anime, index) => ({
      rank: index + 1,
      ...anime,
    }));

    res.json({
      status: "ok",
      results,
    });
  } catch (err) {
    console.error("Top search error:", err.message);

    res.status(500).json({
      error: "Top search failed",
      debug: err.message,
    });
  }
});

app.get("/api/category/:type", async (req, res) => {
  try {
    const type = req.params.type;
    const page = Number(req.query.page || 1);

    const sortMap = {
      "recently-added": "ID_DESC",
      "top-upcoming": "POPULARITY_DESC",
      "subbed-anime": "POPULARITY_DESC",
      "dubbed-anime": "POPULARITY_DESC",
      "most-popular": "POPULARITY_DESC",
      movies: "POPULARITY_DESC",
      "tv-series": "POPULARITY_DESC",
      ovas: "OVA",
      onas: "ONA",
      specials: "SPECIAL",
    };

    const formatMap = {
      movies: "MOVIE",
      "tv-series": "TV",
      ovas: "OVA",
      onas: "ONA",
      specials: "SPECIAL",
    };

    const query = `
      query ($page: Int, $sort: [MediaSort], $format: MediaFormat) {
        Page(page: $page, perPage: 24) {
          pageInfo {
            total
            currentPage
            lastPage
            hasNextPage
          }
          media(
            type: ANIME,
            sort: $sort,
            format: $format,
            ${SAFE_FILTER}
          ) {
            ${MEDIA_FIELDS}
          }
        }
      }
    `;

    const data = await anilist(query, {
      page,
      sort: sortMap[type] || "POPULARITY_DESC",
      format: formatMap[type] || null,
    });

    res.json({
      status: "ok",
      results: safeAnimeList(data.Page.media),
      paginationInfo: data.Page.pageInfo,
    });
  } catch (err) {
    console.error("Category error:", err.message);

    res.status(500).json({
      error: "Category failed",
      debug: err.message,
    });
  }
});

app.listen(PORT, () => {
  console.log(`🔥 Server running on http://localhost:${PORT}`);
});
