import express from "express";
import cors from "cors";
import axios from "axios";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;
const ANILIST = "https://graphql.anilist.co";

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
  nextAiringEpisode {
    episode
  }
`;

const SAFE_FILTER = `
  isAdult: false,
  genre_not_in: ["Hentai", "Ecchi"]
`;

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
          idMal
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
          coverImage {
            medium
            large
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

    const image = anime.coverImage?.large || anime.coverImage?.medium || "";

    const episodes = Array.from({ length: totalEpisodes }, (_, index) => {
      const ep = index + 1;

      return {
        id: `${anime.id}-${ep}`,
        number: ep,
        episodeId: ep,
        title: `Episode ${ep}`,
        image,
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
      ovas: "POPULARITY_DESC",
      onas: "POPULARITY_DESC",
      specials: "POPULARITY_DESC",
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
