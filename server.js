import express from "express";
import cors from "cors";
import axios from "axios";
import dotenv from "dotenv";
dotenv.config();
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const app = express();
const PORT = 5000;

app.use(cors());
app.use(express.json());


app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    uptime: process.uptime(),
    time: Date.now(),
  });
});

const ANILIST = "https://graphql.anilist.co";

function stripHtml(html = "") {
  return String(html).replace(/<[^>]*>/g, "").replace(/\n/g, " ").trim();
}

function normalizeAnime(media) {
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
    genres: media.genres,
  };
}

const cache = new Map();

async function getOrSetCache(key, ttl, fetchFunction) {
  const now = Date.now();
  const cached = cache.get(key);

  if (cached && cached.expiry > now) {
    console.log("✅ CACHE HIT:", key);
    return cached.data;
  }

  try {
    console.log("❌ CACHE MISS:", key);

    const freshData = await fetchFunction();

    if (freshData) {
  cache.set(key, {
    data: freshData,
    expiry: now + ttl,
  });
}

    return freshData;
  } catch (error) {
    console.error("Cache fetch error:", error.message);

    if (cached?.data) {
      console.log("⚠️ RETURNING OLD CACHE:", key);
      return cached.data;
    }

    throw error;
  }
}

async function getDbCache(table, keyColumn, keyValue, maxAgeMs) {
  const { data, error } = await supabase
    .from(table)
    .select("data, updated_at")
    .eq(keyColumn, keyValue)
    .single();

  if (error || !data) return null;

  const age = Date.now() - new Date(data.updated_at).getTime();

  return {
    data: data.data,
    fresh: age < maxAgeMs,
  };
}

async function setDbCache(table, keyColumn, keyValue, value) {
  await supabase.from(table).upsert({
    [keyColumn]: keyValue,
    data: value,
    updated_at: new Date().toISOString(),
  });
}

const pendingRequests = new Map();

async function fetchWithRetry(fetchFunction, retries = 3, delay = 1000) {
  for (let i = 0; i < retries; i++) {
    try {
      return await fetchFunction();
    } catch (error) {
      if (i === retries - 1) throw error;

      console.log(`Retrying request... ${i + 1}/${retries}`);

      await new Promise((resolve) => setTimeout(resolve, delay));
    }
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

      // IMPORTANT:
      // prevents AniList rate limit
      await sleep(1200);

    } catch (error) {
      console.log(
        "AniList Error:",
        error?.response?.status || error.message
      );

      // if rate limited → retry slowly
      if (error?.response?.status === 429) {
  console.log("429 hit → failing fast, cache fallback will handle it");
  item.reject(error);
}
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

const CACHE_TTL = {
  HOME: 1000 * 60 * 60 * 2,
  DETAILS: 1000 * 60 * 60 * 24,
  EPISODES: 1000 * 60 * 60 * 24,
  SEARCH: 1000 * 60 * 30,
  RECOMMENDATIONS: 1000 * 60 * 60 * 24,
  CHARACTERS: 1000 * 60 * 60 * 24,
  SEASONS: 1000 * 60 * 60 * 24,
};

async function getSupabaseCache(table, key) {
  const { data, error } = await supabase
    .from(table)
    .select("*")
    .eq("cache_key", key)
    .single();

  if (error || !data) return null;

  if (Date.now() - new Date(data.updated_at).getTime() > data.ttl) {
    return null;
  }

  return data.payload;
}

async function setSupabaseCache(table, key, payload, ttl) {
  await supabase.from(table).upsert({
    cache_key: key,
    payload,
    ttl,
    updated_at: new Date().toISOString(),
  });
}

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
  }
  genres
  averageScore
  episodes
  status
  format
  season
  seasonYear
  nextAiringEpisode {
    episode
  }
`;

async function getList(sort, extra = "") {
  const query = `
    query {
      Page(page: 1, perPage: 20) {
        media(type: ANIME, sort: ${sort} ${extra}) {
          ${MEDIA_FIELDS}
        }
      }
    }
  `;

  const data = await anilist(query);
  return data.Page.media.map(normalizeAnime);
}

app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    uptime: process.uptime(),
    time: Date.now(),
  });
});

app.get("/", (req, res) => {
  res.send("🔥 Anime API Running");
});

app.get("/api/home", async (req, res) => {
  try {

    const cached = await getSupabaseCache(
      "home_cache",
      "key",
      "main",
      10 * 60 * 1000
    );

    if (cached?.fresh) {
      console.log("SUPABASE HOME CACHE HIT");
      return res.json(cached.data);
    }

    console.log("FETCHING FRESH HOME");

    const query = `
      query {

        trending: Page(page: 1, perPage: 10) {
          media(sort: TRENDING_DESC, type: ANIME) {
            ${MEDIA_FIELDS}
          }
        }

        popular: Page(page: 1, perPage: 12) {
          media(sort: POPULARITY_DESC, type: ANIME) {
            ${MEDIA_FIELDS}
          }
        }

        latest: Page(page: 1, perPage: 12) {
          media(sort: UPDATED_AT_DESC, type: ANIME) {
            ${MEDIA_FIELDS}
          }
        }

      }
    `;

    const result = await anilist(query);

    const response = {
      status: "ok",

      spotlight:
        result.trending.media
          .slice(0, 6)
          .map(normalizeAnime),

      trending:
        result.trending.media
          .map(normalizeAnime),

      latest_episode:
        result.latest.media
          .map(normalizeAnime),

      top_airing:
        result.popular.media
          .map(normalizeAnime),
    };

    await setSupabaseCache(
      "home_cache",
      "key",
      "main",
      response
    );

    res.json(response);

  } catch (err) {

    console.error(err.message);

    const fallback = await getSupabaseCache(
      "home_cache",
      "key",
      "main",
      999999999999
    );

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

    const cached = await getSupabaseCache(
      "anime_details",
      "id",
      id,
      30 * 60 * 60 * 1000
    );

    if (cached?.fresh) {
      console.log("DETAILS CACHE HIT:", id);
      return res.json(cached.data);
    }

    const query = `
      query {
        Media(id: ${id}, type: ANIME) {
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

    const data = await anilist(query);

    const media = data.Media;

    const anime = normalizeAnime(media);

    anime.studios =
      media.studios?.nodes?.map((s) => s.name) || [];

    anime.popularity =
      media.popularity || 0;

    anime.favorites =
      media.favourites || 0;

    await setSupabaseCache(
      "anime_details",
      "id",
      id,
      anime
    );

    res.json(anime);

  } catch (err) {

    console.error(err.message);

    const fallback = await getSupabaseCache(
      "anime_details",
      "id",
      id,
      999999999999
    );

    if (fallback?.data) {
      return res.json(fallback.data);
    }

    res.status(500).json({
      title: "Anime",
    });
  }
});

app.get("/api/episodes/:id", async (req, res) => {
  const id = Number(req.params.id);

  try {

    const cached = await getSupabaseCache(
      "anime_episodes",
      "id",
      id,
      6 * 60 * 60 * 1000
    );

    if (cached?.fresh) {
      console.log("EPISODES CACHE HIT:", id);
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

    const data = await anilist(query, {
      id,
    });

    const anime = data.Media;

    let totalEpisodes = 0;

    if (
      anime.status === "RELEASING" &&
      anime.nextAiringEpisode?.episode
    ) {
      totalEpisodes =
        anime.nextAiringEpisode.episode - 1;
    }

    else if (anime.episodes) {
      totalEpisodes = anime.episodes;
    }

    const image =
      anime.coverImage?.large ||
      anime.coverImage?.medium ||
      "";

    const episodes = Array.from(
      { length: totalEpisodes },
      (_, index) => {
        const ep = index + 1;

        return {
          id: `${anime.id}-${ep}`,
          number: ep,
          episodeId: ep,
          title: `Episode ${ep}`,
          image,
          url: `/watch/${anime.id}?ep=${ep}`,
        };
      }
    );

    const response = {
      status: "ok",
      results: episodes,
    };

    await setSupabaseCache(
      "anime_episodes",
      "id",
      id,
      response
    );

    res.json(response);

  } catch (err) {

    console.error(err.message);

    const fallback = await getSupabaseCache(
      "anime_episodes",
      "id",
      id,
      999999999999
    );

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

    const cached = await getSupabaseCache(
      "anime_characters",
      "id",
      id,
      24 * 60 * 60 * 1000
    );

    if (cached?.fresh) {
      return res.json(cached.data);
    }

    const query = `
      query {
        Media(id: ${id}, type: ANIME) {

          characters(page: 1, perPage: 20) {

            edges {

              role

              node {
                id
                fullName: name {
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

    const data = await anilist(query);

    const results =
      data.Media.characters.edges.map(
        (edge) => ({
          role: edge.role,

          character: {
            id: edge.node.id,
            name: edge.node.fullName,
            image: edge.node.image?.large,
          },

          voiceActor: edge.voiceActors?.[0]
            ? {
                id: edge.voiceActors[0].id,
                name:
                  edge.voiceActors[0].name.full,
                image:
                  edge.voiceActors[0].image
                    ?.large,
              }
            : null,
        })
      );

    const response = {
      status: "ok",
      results,
    };

    await setSupabaseCache(
      "anime_characters",
      "id",
      id,
      response
    );

    res.json(response);

  } catch (err) {

    console.error(err.message);

    const fallback = await getSupabaseCache(
      "anime_characters",
      "id",
      id,
      999999999999
    );

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

    const cached = await getSupabaseCache(
      "anime_recommendations",
      "id",
      id,
      24 * 60 * 60 * 1000
    );

    if (cached?.fresh) {
      return res.json(cached.data);
    }

    const query = `
      query {
        Media(id: ${id}, type: ANIME) {

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

    const data = await anilist(query);

    const results =
      data.Media.recommendations.nodes
        .map((item) =>
          normalizeAnime(
            item.mediaRecommendation
          )
        )
        .filter(Boolean);

    const response = {
      status: "ok",
      results,
    };

    await setSupabaseCache(
      "anime_recommendations",
      "id",
      id,
      response
    );

    res.json(response);

  } catch (err) {

    console.error(err.message);

    const fallback = await getSupabaseCache(
      "anime_recommendations",
      "id",
      id,
      999999999999
    );

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

  const keyword =
    String(req.query.keyword || "")
      .trim();

  if (!keyword) {
    return res.json({
      status: "ok",
      results: [],
    });
  }

  try {

    const cached = await getSupabaseCache(
      "search_cache",
      "key",
      keyword.toLowerCase(),
      6 * 60 * 60 * 1000
    );

    if (cached?.fresh) {
      return res.json(cached.data);
    }

    const query = `
      query ($search: String) {

        Page(page: 1, perPage: 18) {

          media(
            search: $search,
            type: ANIME
          ) {
            ${MEDIA_FIELDS}
          }

        }

      }
    `;

    const data = await anilist(query, {
      search: keyword,
    });

    const results =
      data.Page.media.map(normalizeAnime);

    const response = {
      status: "ok",
      results,
    };

    await setSupabaseCache(
      "search_cache",
      "key",
      keyword.toLowerCase(),
      response
    );

    res.json(response);

  } catch (err) {

    console.error(err.message);

    const fallback = await getSupabaseCache(
      "search_cache",
      "key",
      keyword.toLowerCase(),
      999999999999
    );

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

    const cached = await getSupabaseCache(
      "anime_seasons",
      "id",
      id,
      24 * 60 * 60 * 1000
    );

    if (cached?.fresh) {
      return res.json(cached.data);
    }

    const query = `
      query {
        Media(id: ${id}, type: ANIME) {

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

    const data = await anilist(query);

    const results =
      data.Media.relations.edges
        .filter((edge) =>
          [
            "SEQUEL",
            "PREQUEL",
          ].includes(edge.relationType)
        )
        .map((edge) =>
          normalizeAnime(edge.node)
        );

    const response = {
      status: "ok",
      results,
    };

    await setSupabaseCache(
      "anime_seasons",
      "id",
      id,
      response
    );

    res.json(response);

  } catch (err) {

    console.error(err.message);

    const fallback = await getSupabaseCache(
      "anime_seasons",
      "id",
      id,
      999999999999
    );

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

    const start = Math.floor(new Date(`${date}T00:00:00+05:30`).getTime() / 1000);
    const end = Math.floor(new Date(`${date}T23:59:59+05:30`).getTime() / 1000);

    const data = await anilist(query, {
      page: 1,
      airingAtGreater: start,
      airingAtLesser: end,
    });

    const results = data.Page.airingSchedules.map((item) => {
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
          media(sort: TRENDING_DESC, type: ANIME) {
            ${MEDIA_FIELDS}
          }
        }
      }
    `;

    const data = await anilist(query);

    const results =
      data.Page.media.map((anime, index) => ({
        rank: index + 1,
        ...normalizeAnime(anime),
      })) || [];

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
          media(type: ANIME, sort: $sort, format: $format) {
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

    const results = data.Page.media.map(normalizeAnime);

    res.json({
      status: "ok",
      results,
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
