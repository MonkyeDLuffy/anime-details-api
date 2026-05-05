import express from "express";
import cors from "cors";
import axios from "axios";

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

const CACHE_TTL = {
  HOME: 30 * 60 * 1000,        // 30 minutes
  ANIME: 24 * 60 * 60 * 1000,  // 24 hours
  EPISODES: 10 * 60 * 1000,    // 10 minutes
  SEARCH: 60 * 60 * 1000,      // 1 hour
  TOP_SEARCH: 6 * 60 * 60 * 1000,
  SCHEDULE: 15 * 60 * 1000,
};

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

    cache.set(key, {
      data: freshData,
      expiry: now + ttl,
    });

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

async function anilist(query, variables = {}) {
  const res = await axios.post(ANILIST, {
    query,
    variables,
  });
  return res.data.data;
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
    const data = await getOrSetCache("home", CACHE_TTL.HOME, async () => {
      console.log("📡 Fetching home data...");

      const [trending, popular, airing, upcoming] = await Promise.all([
        getList("TRENDING_DESC"),
        getList("POPULARITY_DESC"),
        getList("POPULARITY_DESC", "", { status: "RELEASING" }),
        getList("POPULARITY_DESC", "", { status: "NOT_YET_RELEASED" }),
      ]);

      const results = {
        spotlights: trending.slice(0, 8),
        trending,
        topTen: popular.slice(0, 10),
        topten: popular.slice(0, 10),
        today: airing,
        topAiring: airing,
        top_airing: airing,
        mostPopular: popular,
        most_popular: popular,
        mostFavorite: trending,
        most_favorite: trending,
        latestCompleted: popular,
        latest_completed: popular,
        latestEpisode: airing,
        latest_episode: airing,
        topUpcoming: upcoming,
        top_upcoming: upcoming,
        recentlyAdded: popular,
        recently_added: popular,
        genres: [
          "Action",
          "Adventure",
          "Comedy",
          "Drama",
          "Fantasy",
          "Romance",
          "Sci-Fi",
          "Horror",
          "Mystery",
        ],
      };

      return {
        status: "ok",
        results,
        ...results,
      };
    });

    res.json(data);
  } catch (error) {
    console.error("Home error:", error.message);
    res.status(500).json({
      status: "error",
      results: null,
    });
  }
});

app.get("/api/details/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);

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
    const anime = normalizeAnime(data.Media);

    anime.studios = data.Media.studios?.nodes?.map((s) => s.name) || [];
    anime.popularity = data.Media.popularity || 0;
    anime.favorites = data.Media.favourites || 0;

    res.json(anime);
  } catch (err) {
    console.error("Details error:", err.message);
    res.status(500).json({
      error: "Details failed",
      debug: err.message,
    });
  }
});

app.get("/api/episodes/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const result = await getOrSetCache(
      `episodes:${id}`,
      CACHE_TTL.EPISODES,
      async () => {
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

        const data = await anilist(query, { id: Number(id) });
        const anime = data.Media;

        if (!anime) {
          return {
            status: "error",
            results: [],
          };
        }

        let totalEpisodes = 0;

        // ✅ Ongoing anime
        if (anime.status === "RELEASING" && anime.nextAiringEpisode?.episode) {
          totalEpisodes = anime.nextAiringEpisode.episode - 1;
        }
        // ✅ Finished anime
        else if (anime.episodes) {
          totalEpisodes = anime.episodes;
        }
        // ✅ fallback
        else {
          totalEpisodes = 0;
        }

        const title =
          anime.title.english ||
          anime.title.romaji ||
          "Anime";

        const image =
          anime.coverImage?.medium ||
          anime.coverImage?.large ||
          "";

        const episodes = Array.from({ length: totalEpisodes }, (_, index) => {
          const ep = index + 1;

          return {
            id: `${anime.id}-${ep}`,
            episodeId: ep,
            number: ep,
            episode_no: ep,
            episode: ep,
            title: `Episode ${ep}`,
            name: `Episode ${ep}`,
            image,
            snapshot: image,
            url: `/watch/${anime.id}?ep=${ep}`,
          };
        });

        return {
          status: "ok",
          results: episodes,
        };
      }
    );

    res.json(result);

  } catch (error) {
    console.error("Episodes error:", error);
    res.status(500).json({
      status: "error",
      results: [],
    });
  }
});

app.get("/api/character/list/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const page = Number(req.query.page || 1);

    const query = `
      query ($id: Int, $page: Int) {
        Media(id: $id, type: ANIME) {
          characters(page: $page, perPage: 12, sort: ROLE) {
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
              voiceActors(language: JAPANESE, sort: RELEVANCE) {
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

    const data = await anilist(query, { id, page });

    const results =
      data.Media.characters.edges.map((edge) => ({
        role: edge.role,
        character: {
          id: edge.node.id,
          name: edge.node.name.full,
          image: edge.node.image.large,
        },
        voiceActors: edge.voiceActors.map((va) => ({
          id: va.id,
          name: va.name.full,
          image: va.image.large,
        })),
      })) || [];

    res.json({
      status: "ok",
      results,
    });
  } catch (err) {
    console.error("Character error:", err.message);
    res.status(500).json({
      error: "Character fetch failed",
      debug: err.message,
    });
  }
});

app.get("/api/recommendations/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);

    const query = `
      query ($id: Int) {
        Media(id: $id, type: ANIME) {
          recommendations(page: 1, perPage: 12, sort: RATING_DESC) {
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

    const results =
      data.Media.recommendations.nodes
        .map((node) => node.mediaRecommendation)
        .filter(Boolean)
        .map(normalizeAnime) || [];

    res.json({
      status: "ok",
      results,
    });
  } catch (err) {
    console.error("Recommendations error:", err.message);
    res.status(500).json({
      error: "Recommendations failed",
      debug: err.message,
    });
  }
});

app.get("/api/search", async (req, res) => {
  try {
    const keyword = req.query.query || req.query.q || req.query.keyword;
    const page = Number(req.query.page || 1);

    if (!keyword) {
      return res.json({
        status: "ok",
        results: [],
      });
    }

    const query = `
      query ($search: String, $page: Int) {
        Page(page: $page, perPage: 24) {
          pageInfo {
            total
            currentPage
            lastPage
            hasNextPage
          }
          media(search: $search, type: ANIME, sort: POPULARITY_DESC) {
            ${MEDIA_FIELDS}
          }
        }
      }
    `;

    const data = await anilist(query, {
      search: keyword,
      page,
    });

    const results = data.Page.media.map(normalizeAnime);

    res.json({
      status: "ok",
      results,
      paginationInfo: data.Page.pageInfo,
    });
  } catch (err) {
    console.error("Search error:", err.message);
    res.status(500).json({
      error: "Search failed",
      debug: err.message,
    });
  }
});

app.get("/api/seasons/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);

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

    const results =
      data.Media.relations.edges
        .filter((edge) =>
          [
            "PREQUEL",
            "SEQUEL",
            "SIDE_STORY",
            "PARENT",
            "SPIN_OFF",
            "ALTERNATIVE",
            "SUMMARY",
          ].includes(edge.relationType)
        )
        .map((edge) => ({
          relationType: edge.relationType,
          ...normalizeAnime(edge.node),
        })) || [];

    res.json({
      status: "ok",
      results,
    });
  } catch (err) {
    console.error("Seasons error:", err.message);
    res.status(500).json({
      error: "Seasons fetch failed",
      debug: err.message,
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
