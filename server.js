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
const MEGAPLAY = "https://megaplay.buzz";
const ANIKOTO = "https://anikotoapi.site";
const TMDB = "https://api.themoviedb.org/3";
const TMDB_IMAGE = "https://image.tmdb.org/t/p/original";


app.use(cors());
app.use(express.json());

const supabase =
  process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
    ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
    : null;

const TTL = {
  HOME: 1000 * 60 * 60 * 4,
  DETAILS: 1000 * 60 * 60 * 24,
  SEARCH: 1000 * 60 * 60 * 6,
  CHARACTERS: 1000 * 60 * 60 * 24,
  RECOMMENDATIONS: 1000 * 60 * 60 * 24,
  SEASONS: 1000 * 60 * 60 * 24,
  JIKAN_DETAILS: 1000 * 60 * 60 * 24 * 7,
  JIKAN_SEARCH: 1000 * 60 * 60 * 24,
  ID_MAP: 1000 * 60 * 60 * 24 * 30,
  STREAM: 1000 * 60 * 60 * 24 * 7,
  ANIKOTO_MAP: 1000 * 60 * 60 * 24 * 30,
  SCHEDULE: 1000 * 60 * 60 * 6,
  TMDB: 1000 * 60 * 60 * 24 * 7,
};

const MEDIA_FIELDS = `
  id
  idMal
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stripHtml(html = "") {
  return String(html).replace(/<[^>]*>/g, "").replace(/\n/g, " ").trim();
}

function normalizeAnime(media) {
  if (!media) return null;

  return {
    id: media.id,
    anilistId: media.id,
    malId: media.idMal || null,

    title: media.title?.english || media.title?.romaji || media.title?.native || "Anime",
    name: media.title?.english || media.title?.romaji || media.title?.native || "Anime",

    poster:
      media.coverImage?.extraLarge ||
      media.coverImage?.large ||
      media.coverImage?.medium ||
      null,

    image:
      media.coverImage?.extraLarge ||
      media.coverImage?.large ||
      media.coverImage?.medium ||
      null,

    banner:
      media.bannerImage ||
      media.coverImage?.extraLarge ||
      media.coverImage?.large ||
      null,

    bannerImage:
      media.bannerImage ||
      media.coverImage?.extraLarge ||
      media.coverImage?.large ||
      null,

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
    .filter((anime) => !anime.isAdult)
    .filter((anime) => {
      const genres = anime.genres || [];
      return !genres.some((g) => blocked.includes(g));
    })
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

  return {
    malId: anime.mal_id,
    id: anime.mal_id,
    url: anime.url,

    title: anime.title_english || anime.title || anime.title_japanese || "Anime",
    name: anime.title_english || anime.title || anime.title_japanese || "Anime",
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

const anilistQueue = [];
let processingQueue = false;

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
      await sleep(1400);
    } catch (error) {
      console.log("AniList Error:", error?.response?.status || error.message);
      item.reject(error);
    }
  }

  processingQueue = false;
}

async function getTmdbAnimeData(anilistId, forceRefresh = false) {
  try {
    const cacheKey = `tmdb-anime-${anilistId}`;

    if (!forceRefresh) {
      const cached = await getSupabaseCache("search_cache", cacheKey);
      if (cached?.fresh) {
        console.log("✅ TMDB CACHE HIT:", anilistId);
        return cached.data;
      }
    }

    const details = await getAnimeDetails(anilistId);

    if (!details || !process.env.TMDB_API_KEY) return null;

    const title = details.title || details.name || "Anime";

    const getSeasonNumber = (text = "") => {
      const t = String(text).toLowerCase();

      const a = t.match(/season\s*(\d+)/i);
      if (a?.[1]) return Number(a[1]);

      const b = t.match(/(\d+)(st|nd|rd|th)?\s*season/i);
      if (b?.[1]) return Number(b[1]);

      return 1;
    };

    const cleanSearchTitle = (value = "") =>
      String(value)
        .replace(/season\s*\d+/gi, "")
        .replace(/\d+(st|nd|rd|th)?\s*season/gi, "")
        .replace(/\s+part\s+\d+/gi, "")
        .replace(/\s+cour\s+\d+/gi, "")
        .trim();

    const normalizeTitle = (value = "") =>
      String(value).toLowerCase().replace(/[^a-z0-9]/g, "");

    const targetSeason = getSeasonNumber(title);

    const rawTitles = [
      details.title,
      details.name,
      details.titleEnglish,
      details.englishTitle,
      details.romajiTitle,
      details.titleRomaji,
      details.nativeTitle,
      details.titleNative,
    ];

    const possibleTitles = [
      ...new Set(
        rawTitles
          .filter(Boolean)
          .flatMap((t) => [String(t).trim(), cleanSearchTitle(t)])
          .filter(Boolean)
      ),
    ];

    let show = null;

    for (const searchTitle of possibleTitles) {
      const search = await axios.get(`${TMDB}/search/tv`, {
        params: {
          api_key: process.env.TMDB_API_KEY,
          query: searchTitle,
        },
        timeout: 15000,
      });

      const results = search.data?.results || [];
      const target = normalizeTitle(cleanSearchTitle(searchTitle));

      show =
        results.find((item) => {
          const name = normalizeTitle(item.name);
          const originalName = normalizeTitle(item.original_name);

          return (
            name === target ||
            originalName === target ||
            name.startsWith(target) ||
            originalName.startsWith(target) ||
            target.startsWith(name) ||
            target.startsWith(originalName)
          );
        }) || null;

      if (show?.id) break;
    }

    if (!show?.id) {
      const emptyData = {
        tmdbId: null,
        title,
        logo: null,
        seasonNumber: targetSeason,
        episodes: [],
      };

      await setSupabaseCache("search_cache", cacheKey, emptyData, TTL.TMDB);
      return emptyData;
    }

    const tv = await axios.get(`${TMDB}/tv/${show.id}`, {
      params: {
        api_key: process.env.TMDB_API_KEY,
        append_to_response: "images,episode_groups",
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

    let episodes = [];

    const seasonGroups =
      tvData?.episode_groups?.results?.filter(
        (g) => String(g.type) === "6" || g.type === 6
      ) || [];

    if (seasonGroups.length) {
      const group = seasonGroups[0];

      const groupRes = await axios.get(`${TMDB}/tv/episode_group/${group.id}`, {
        params: {
          api_key: process.env.TMDB_API_KEY,
        },
        timeout: 20000,
      });

      const groups = groupRes.data?.groups || [];

      const selectedGroup =
        groups.find((g) =>
          String(g.name || "")
            .toLowerCase()
            .includes(`season ${targetSeason}`)
        ) ||
        groups[targetSeason] ||
        groups[targetSeason - 1];

      episodes =
        selectedGroup?.episodes?.map((ep, index) => ({
          episodeNumber: index + 1,
          seasonNumber: targetSeason,
          tmdbEpisodeNumber: ep.episode_number,
          title: ep.name,
          image: ep.still_path ? `${TMDB_IMAGE}${ep.still_path}` : null,
          overview: ep.overview || "",
        })) || [];
    }

    if (!episodes.length) {
      const seasonRes = await axios.get(`${TMDB}/tv/${show.id}/season/${targetSeason}`, {
        params: {
          api_key: process.env.TMDB_API_KEY,
        },
        timeout: 20000,
      });

      episodes =
        seasonRes.data?.episodes?.map((ep) => ({
          episodeNumber: ep.episode_number,
          seasonNumber: targetSeason,
          tmdbEpisodeNumber: ep.episode_number,
          title: ep.name,
          image: ep.still_path ? `${TMDB_IMAGE}${ep.still_path}` : null,
          overview: ep.overview || "",
        })) || [];
    }

    const finalData = {
      tmdbId: show.id,
      title,
      logo: logo?.file_path ? `${TMDB_IMAGE}${logo.file_path}` : null,
      seasonNumber: targetSeason,
      episodes,
    };

    await setSupabaseCache("search_cache", cacheKey, finalData, TTL.TMDB);

    return finalData;
  } catch (error) {
    console.log("TMDB error:", error.message);
    return null;
  }
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

async function convertMalToAniList(malId) {
  try {
    const cacheKey = `mal-anilist-${malId}`;

    const cached = await getSupabaseCache("search_cache", cacheKey);

    if (cached?.fresh) {
      return cached.data;
    }

    const query = `
      query ($idMal: Int) {
        Media(idMal: $idMal, type: ANIME) {
          id
        }
      }
    `;

    const data = await anilist(query, {
      idMal: Number(malId),
    });

    const id = data?.Media?.id || null;

    if (id) {
      await setSupabaseCache(
        "search_cache",
        cacheKey,
        id,
        TTL.ID_MAP
      );
    }

    return id;
  } catch (error) {
    console.log(
      "MAL -> AniList conversion failed:",
      malId
    );

    return null;
  }
}

async function searchAniList(keyword) {
  try {
    const query = `
      query ($search: String) {
        Page(page: 1, perPage: 25) {
          media(
            search: $search,
            type: ANIME,
            sort: POPULARITY_DESC,
            ${SAFE_FILTER}
          ) {
            ${MEDIA_FIELDS}
          }
        }
      }
    `;

    const data = await anilist(query, {
      search: keyword,
    });

    return safeAnimeList(
      data?.Page?.media || []
    );
  } catch (error) {
    console.log(
      "AniList search failed:",
      error?.response?.status || error.message
    );

    return [];
  }
}

async function searchJikan(keyword) {
  try {
    const data = await jikanGet("/anime", {
      q: keyword,
      limit: 25,
    });

    const cleaned = (data?.data || [])
      .map(cleanJikanAnime)
      .filter(Boolean);

    const final = [];

    for (const anime of cleaned) {
      const anilistId = anime.malId
        ? await convertMalToAniList(anime.malId)
        : null;

      final.push({
        ...anime,
        anilistId:
          anilistId || anime.malId,
        id:
          anilistId || anime.malId,
      });
    }

    return final;
  } catch (error) {
    console.log(
      "Jikan search failed:",
      error?.response?.status || error.message
    );

    return [];
  }
}

async function getAnimeDetails(anilistId) {
  try {
    const cacheKey = `anime-details-${anilistId}`;

    const cached = await getSupabaseCache(
      "anime_details",
      cacheKey
    );

    if (cached?.fresh) {
      console.log(
        "✅ DETAILS CACHE HIT"
      );

      return cached.data;
    }

    const query = `
      query ($id: Int) {
        Media(id: $id, type: ANIME) {
          ${MEDIA_FIELDS}

          trailer {
            id
            site
            thumbnail
          }

          rankings {
            rank
            type
            allTime
          }

          studios(isMain: true) {
            nodes {
              name
            }
          }

          relations {
            edges {
              relationType
              node {
                id
                title {
                  romaji
                  english
                }
                coverImage {
                  large
                }
              }
            }
          }
        }
      }
    `;

    const data = await anilist(query, {
      id: Number(anilistId),
    });

    const media = data?.Media;

    if (!media) {
      return null;
    }

    let jikan = null;

    if (media.idMal) {
      try {
        const jikanData = await jikanGet(
          `/anime/${media.idMal}/full`
        );

        jikan = cleanJikanAnime(
          jikanData?.data
        );
      } catch (err) {
        console.log(
          "Jikan detail fail:",
          media.idMal
        );
      }
    }

    const normalized =
      normalizeAnime(media);

    const finalData = {
      ...normalized,

      malId: media.idMal,

      trailer:
        jikan?.trailer ||
        media.trailer ||
        null,

      studios:
        jikan?.studios ||
        media.studios?.nodes?.map(
          (s) => s.name
        ) ||
        [],

      relations:
        media.relations?.edges || [],

      ranking:
        media.rankings || [],

      popularity:
        jikan?.popularity || null,

      members:
        jikan?.members || null,

      favorites:
        jikan?.favorites || null,

      broadcast:
        jikan?.broadcast || null,

      duration:
        jikan?.duration || null,

      rating:
        jikan?.rating || null,

      source:
        jikan?.source || null,
    };

    await setSupabaseCache(
      "anime_details",
      cacheKey,
      finalData,
      TTL.DETAILS
    );

    return finalData;
  } catch (error) {
    console.log(
      "Details error:",
      error?.response?.status || error.message
    );

    return null;
  }
}

async function getAniListAiredEpisodeCount(anilistId) {
  try {
    const query = `
      query ($id: Int) {
        Media(id: $id, type: ANIME) {
          episodes
          status
          nextAiringEpisode {
            episode
          }
        }
      }
    `;

    const res = await axios.post(
      "https://graphql.anilist.co",
      {
        query,
        variables: { id: Number(anilistId) },
      },
      { timeout: 15000 }
    );

    const media = res.data?.data?.Media;

    if (!media) return 0;

    if (media.nextAiringEpisode?.episode) {
      return Math.max(0, Number(media.nextAiringEpisode.episode) - 1);
    }

    return Number(media.episodes || 0);
  } catch (err) {
    console.log("AniList aired count error:", err.message);
    return 0;
  }
}

async function getAnimeEpisodes(anilistId, forceRefresh = false) {
  try {
    const cacheKey = `anime-episodes-${anilistId}`;

    const details = await getAnimeDetails(anilistId);
    if (!details?.malId) return [];

    const isAiring =
      String(details.status || "")
        .toLowerCase()
        .includes("airing") ||
      String(details.status || "")
        .toLowerCase()
        .includes("releasing");

    const episodeTTL = isAiring
      ? 1000 * 60 * 30 // 30 minutes for ongoing anime
      : TTL.EPISODES; // normal cache for completed anime

    if (!forceRefresh) {
      const cached = await getSupabaseCache("anime_episodes", cacheKey);

      if (cached?.fresh) {
        console.log("✅ EPISODES CACHE HIT:", anilistId);
        return cached.data;
      }
    }

    console.log("🔥 FETCHING FRESH EPISODES:", anilistId);

    const allEpisodes = [];
    let page = 1;
    let hasNextPage = true;

    while (hasNextPage) {
      const response = await jikanGet(`/anime/${details.malId}/episodes`, {
        page,
      });

      const episodes = response?.data || [];
      allEpisodes.push(...episodes);

      hasNextPage = Boolean(response?.pagination?.has_next_page);

      page++;

      if (hasNextPage) await sleep(800);
      if (page > 40) break;
    }

   let finalEpisodes = allEpisodes
  .map((ep, index) => {
    const epNumber = Number(ep.mal_id) || index + 1;

    return {
      id: epNumber,
      number: epNumber,
      episodeId: epNumber,
      episodeNumber: epNumber,
      title: ep.title || `Episode ${epNumber}`,
      description: ep.synopsis || "",
      image:
        ep.images?.jpg?.image_url ||
        ep.images?.webp?.image_url ||
        null,
      aired: ep.aired,
      filler: Boolean(ep.filler),
      recap: Boolean(ep.recap),
      score: ep.score || null,
    };
  })
  .filter((ep) => ep.number)
  .sort((a, b) => Number(a.number) - Number(b.number));

const aniListAiredCount = await getAniListAiredEpisodeCount(anilistId);

if (aniListAiredCount > finalEpisodes.length) {
  for (let ep = finalEpisodes.length + 1; ep <= aniListAiredCount; ep++) {
    finalEpisodes.push({
      id: ep,
      number: ep,
      episodeId: ep,
      episodeNumber: ep,
      title: `Episode ${ep}`,
      description: "",
      image: null,
      aired: null,
      filler: false,
      recap: false,
      score: null,
    });
  }
}

    await setSupabaseCache(
      "anime_episodes",
      cacheKey,
      finalEpisodes,
      episodeTTL
    );

    return finalEpisodes;
  } catch (error) {
    console.log("Episode error:", error?.response?.status || error.message);
    return [];
  }
}

async function getHomeData() {
  try {
    const cached = await getSupabaseCache(
      "home_cache",
      "home-main"
    );

    if (cached?.fresh) {
      console.log("✅ HOME CACHE HIT");
      return cached.data;
    }

    const query = `
      query {
        trending: Page(page: 1, perPage: 12) {
          media(
            type: ANIME,
            sort: TRENDING_DESC,
            ${SAFE_FILTER}
          ) {
            ${MEDIA_FIELDS}
          }
        }

        popular: Page(page: 1, perPage: 12) {
          media(
            type: ANIME,
            sort: POPULARITY_DESC,
            ${SAFE_FILTER}
          ) {
            ${MEDIA_FIELDS}
          }
        }

        airing: Page(page: 1, perPage: 12) {
          media(
            type: ANIME,
            status: RELEASING,
            sort: POPULARITY_DESC,
            ${SAFE_FILTER}
          ) {
            ${MEDIA_FIELDS}
          }
        }

        latest: Page(page: 1, perPage: 20) {
          media(
            type: ANIME,
            sort: START_DATE_DESC,
            ${SAFE_FILTER}
          ) {
            ${MEDIA_FIELDS}
          }
        }
      }
    `;

    const data = await anilist(query);

    const finalData = {
      spotlights: safeAnimeList(
        data?.trending?.media || []
      ),

      trending: safeAnimeList(
        data?.trending?.media || []
      ),

      top_airing: safeAnimeList(
        data?.airing?.media || []
      ),

      most_popular: safeAnimeList(
        data?.popular?.media || []
      ),

      latest_episode: safeAnimeList(
        data?.latest?.media || []
      ),

      recently_added: safeAnimeList(
        data?.latest?.media || []
      ),

      latest_completed: [],

      most_favorite: safeAnimeList(
        data?.popular?.media || []
      ),

      top_upcoming: [],

      todaySchedule: [],
      genres: [],
      topten: [],
    };

    await setSupabaseCache(
      "home_cache",
      "home-main",
      finalData,
      TTL.HOME
    );

    return finalData;
  } catch (error) {
    console.log(
      "Home error:",
      error?.response?.status || error.message
    );

    return {
      spotlights: [],
      trending: [],
      top_airing: [],
      most_popular: [],
      latest_episode: [],
      recently_added: [],
      latest_completed: [],
      most_favorite: [],
      top_upcoming: [],
      todaySchedule: [],
      genres: [],
      topten: [],
    };
  }
}

async function resolveMegaPlay(anilistId, ep, lang = "sub") {
  try {
    const embed = `${MEGAPLAY}/stream/ani/${anilistId}/${ep}/${lang}`;

    const response = await axios.get(embed, {
      timeout: 15000,
      validateStatus: () => true,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36",
      },
    });

    const html = String(response.data || "").toLowerCase();

    const isBad =
      response.status >= 400 ||
      html.includes("oops") ||
      html.includes("404") ||
      html.includes("something went wrong") ||
      html.includes("page you're looking for doesn't exist") ||
      html.length < 500;

    if (isBad) {
      console.log("❌ MegaPlay invalid, fallback needed:", embed);
      return null;
    }

    return {
      source: "megaplay",
      success: true,
      embed,
    };
  } catch {
    return null;
  }
}

async function resolveAnikoto(
  animeTitle,
  episode,
  lang = "sub"
) {
  try {
    const series =
      await searchAnikotoSeries(
        animeTitle
      );

    if (!series?.id) {
      return null;
    }

    const response = await axios.get(
      `${ANIKOTO}/series/${series.id}`,
      {
        timeout: 20000,
      }
    );

    const episodes =
      response.data?.episodes || [];

    const foundEpisode =
      episodes.find(
        (ep) =>
          Number(ep.number) ===
          Number(episode)
      );

    if (!foundEpisode) {
      return null;
    }

    const embedId =
      foundEpisode.embed_id;

    if (!embedId) {
      return null;
    }

    const embed = `${MEGAPLAY}/stream/s-2/${embedId}/${lang}`;

    return {
      source: "anikoto",
      success: true,
      embed,
      episodeData: foundEpisode,
    };
  } catch (error) {
    console.log(
      "Anikoto resolve fail:",
      error.message
    );

    return null;
  }
}

async function resolveStream(anilistId, ep, lang = "sub") {
  try {
    const cacheKey = `stream-${anilistId}-${ep}-${lang}`;

    const cached = await getSupabaseCache("stream_cache", cacheKey);
    if (cached?.fresh) return cached.data;

    const details = await getAnimeDetails(anilistId);

    if (!details?.title) {
      return {
        success: false,
        reason: "anime-details-not-found",
      };
    }

    console.log("🔥 Trying Anikoto only:", details.title, ep, lang);

    const anikoto = await resolveAnikoto(details.title, ep, lang);

    if (anikoto?.success) {
      await setSupabaseCache("stream_cache", cacheKey, anikoto, TTL.STREAM);
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
  } catch (error) {
    console.log("Resolve stream error:", error.message);

    return {
      success: false,
      reason: "resolver-crashed",
      error: error.message,
    };
  }
}

app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    mode: "smart-hybrid-anilist-jikan-megaplay-anikoto",
    uptime: process.uptime(),
    time: Date.now(),
  });
});

/* ===============================
   HOME
================================ */

app.get("/api/home", async (req, res) => {
  const data = await getHomeData();
  res.json(data);
});

/* ===============================
   SEARCH
================================ */

app.get("/api/search", async (req, res) => {
  const keyword = String(req.query.keyword || req.query.q || "").trim();

  if (!keyword) {
    return res.json({
      status: "ok",
      source: "empty",
      results: [],
    });
  }

  const cacheKey = `search-${keyword.toLowerCase()}`;

  try {
    const cached = await getSupabaseCache("search_cache", cacheKey);

    if (cached?.fresh) {
      return res.json({
        status: "ok",
        source: "cache",
        results: cached.data,
      });
    }

    let results = await searchAniList(keyword);

    if (!results.length) {
      results = await searchJikan(keyword);
    }

    await setSupabaseCache("search_cache", cacheKey, results, TTL.SEARCH);

    res.json({
      status: "ok",
      source: results.length ? "smart-search" : "empty",
      results,
    });
  } catch (error) {
    console.log("Search error:", error?.response?.status || error.message);

    const fallback = await getSupabaseCache("search_cache", cacheKey);

    if (fallback?.data) {
      return res.json({
        status: "ok",
        source: "stale-cache",
        results: fallback.data,
      });
    }

    res.json({
      status: "ok",
      source: "failed",
      results: [],
    });
  }
});

/* ===============================
   DETAILS
================================ */

app.get("/api/details/:id", async (req, res) => {
  const id = Number(req.params.id);

  if (!id) {
    return res.status(400).json({
      status: "error",
      error: "Invalid anime ID",
    });
  }

  const data = await getAnimeDetails(id);

  if (!data) {
    return res.status(404).json({
      status: "error",
      error: "Anime not found",
    });
  }

  res.json(data);
});

app.get("/api/smart/details/:id", async (req, res) => {
  const id = Number(req.params.id);

  if (!id) {
    return res.status(400).json({
      status: "error",
      error: "Invalid anime ID",
    });
  }

  const data = await getAnimeDetails(id);

  if (!data) {
    return res.status(404).json({
      status: "error",
      error: "Anime not found",
    });
  }

  res.json({
    status: "ok",
    source: "smart-hybrid",
    data,
  });
});

/* ===============================
   EPISODES
================================ */

app.get("/api/episodes/:id", async (req, res) => {
  const id = Number(req.params.id);

  if (!id) {
    return res.status(400).json({
      status: "error",
      results: [],
    });
  }

  const forceRefresh =
    String(req.query.refresh || "").toLowerCase() === "true" ||
    String(req.query.force || "").toLowerCase() === "true";

  if (forceRefresh && supabase) {
    await supabase
      .from("anime_episodes")
      .delete()
      .eq("cache_key", `anime-episodes-${id}`);
  }

  const episodes = await getAnimeEpisodes(id, forceRefresh);

  res.json({
    status: "ok",
    forceRefresh,
    total: episodes.length,
    results: episodes,
  });
});

/* ===============================
   STREAM RESOLVER
================================ */

app.get("/api/stream/resolve/:id", async (req, res) => {
  const id = Number(req.params.id);
  const ep = Number(req.query.ep || 1);
  const lang = String(req.query.lang || "sub").toLowerCase() === "dub" ? "dub" : "sub";

  if (!id || !ep) {
    return res.status(400).json({
      status: "error",
      error: "Missing anime ID or episode",
    });
  }

  try {
    const stream = await resolveStream(id, ep, lang);

    if (!stream?.success) {
  return res.status(404).json({
    status: "error",
    error: "Stream not found",
    ...stream,
  });
}

    res.json({
      status: "ok",
      ...stream,
      url: stream.embed,
      provider: stream.source,
    });
  } catch (error) {
    res.status(500).json({
      status: "error",
      error: "Stream resolve failed",
      debug: error.message,
    });
  }
});

/* ===============================
   JIKAN
================================ */

app.get("/api/jikan/anime/:malId", async (req, res) => {
  const malId = Number(req.params.malId);

  if (!malId) {
    return res.status(400).json({
      status: "error",
      error: "Invalid MAL ID",
    });
  }

  try {
    const data = await jikanGet(`/anime/${malId}/full`);

    res.json({
      status: "ok",
      source: "jikan",
      data: cleanJikanAnime(data?.data),
    });
  } catch (error) {
    res.status(500).json({
      status: "error",
      error: "Jikan anime failed",
      debug: error.message,
    });
  }
});

app.get("/api/jikan/from-anilist/:id", async (req, res) => {
  const id = Number(req.params.id);

  if (!id) {
    return res.status(400).json({
      status: "error",
      error: "Invalid AniList ID",
    });
  }

  try {
    const details = await getAnimeDetails(id);

    if (!details?.malId) {
      return res.status(404).json({
        status: "error",
        error: "MAL ID not found",
      });
    }

    const data = await jikanGet(`/anime/${details.malId}/full`);

    res.json({
      status: "ok",
      source: "jikan-from-anilist",
      anilistId: id,
      malId: details.malId,
      data: cleanJikanAnime(data?.data),
    });
  } catch (error) {
    res.status(500).json({
      status: "error",
      error: "Jikan from AniList failed",
      debug: error.message,
    });
  }
});

/* ===============================
   RECOMMENDATIONS
================================ */

app.get("/api/recommendations/:id", async (req, res) => {
  const id = Number(req.params.id);

  try {
    const cacheKey = `recommendations-${id}`;
    const cached = await getSupabaseCache("anime_recommendations", cacheKey);

    if (cached?.fresh) {
      return res.json({
        status: "ok",
        results: cached.data,
      });
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
      data?.Media?.recommendations?.nodes?.map((item) => item.mediaRecommendation) || []
    );

    await setSupabaseCache(
      "anime_recommendations",
      cacheKey,
      results,
      TTL.RECOMMENDATIONS
    );

    res.json({
      status: "ok",
      results,
    });
  } catch (error) {
    res.json({
      status: "ok",
      results: [],
    });
  }
});

/* ===============================
   SEASONS / RELATIONS
================================ */

app.get("/api/seasons/:id", async (req, res) => {
  const id = Number(req.params.id);

  try {
    const cacheKey = `seasons-${id}`;
    const cached = await getSupabaseCache("anime_seasons", cacheKey);

    if (cached?.fresh) {
      return res.json({
        status: "ok",
        results: cached.data,
      });
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

    const results = safeAnimeList(
      data?.Media?.relations?.edges
        ?.filter((edge) => ["SEQUEL", "PREQUEL", "SIDE_STORY", "SPIN_OFF"].includes(edge.relationType))
        ?.map((edge) => edge.node) || []
    );

    await setSupabaseCache("anime_seasons", cacheKey, results, TTL.SEASONS);

    res.json({
      status: "ok",
      results,
    });
  } catch (error) {
    res.json({
      status: "ok",
      results: [],
    });
  }
});

/* ===============================
   CATEGORY
================================ */

app.get("/api/category/:type", async (req, res) => {
  const type = req.params.type;
  const page = Number(req.query.page || 1);

  try {
    const sortMap = {
      "recently-added": "START_DATE_DESC",
      "top-upcoming": "POPULARITY_DESC",
      "most-popular": "POPULARITY_DESC",
      "top-airing": "POPULARITY_DESC",
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
      results: safeAnimeList(data?.Page?.media || []),
      paginationInfo: data?.Page?.pageInfo || {
        total: 0,
        currentPage: page,
        lastPage: 1,
        hasNextPage: false,
      },
    });
  } catch (error) {
    res.status(500).json({
      status: "error",
      error: "Category failed",
      debug: error.message,
    });
  }
});

/* ===============================
   TOP SEARCH
================================ */

app.get("/api/top-search", async (req, res) => {
  try {
    const query = `
      query {
        Page(page: 1, perPage: 10) {
          media(type: ANIME, sort: TRENDING_DESC, ${SAFE_FILTER}) {
            ${MEDIA_FIELDS}
          }
        }
      }
    `;

    const data = await anilist(query);

    const results = safeAnimeList(data?.Page?.media || []).map((anime, index) => ({
      rank: index + 1,
      ...anime,
    }));

    res.json({
      status: "ok",
      results,
    });
  } catch (error) {
    res.json({
      status: "ok",
      results: [],
    });
  }
});

/* ===============================
   SCHEDULE
================================ */

app.get("/api/schedule", async (req, res) => {
  const date = String(req.query.date || "").trim();

  if (!date) {
    return res.json({
      status: "ok",
      results: [],
    });
  }

  const cacheKey = `schedule-${date}`;

  try {
    const cached = await getSupabaseCache("schedule_cache", cacheKey);

    if (cached?.fresh) {
      return res.json({
        status: "ok",
        source: "cache",
        date,
        results: cached.data,
      });
    }

    const start = Math.floor(new Date(`${date}T00:00:00Z`).getTime() / 1000);
    const end = Math.floor(new Date(`${date}T23:59:59Z`).getTime() / 1000);

    const query = `
      query ($start: Int, $end: Int) {
        Page(page: 1, perPage: 50) {
          airingSchedules(
            airingAt_greater: $start,
            airingAt_lesser: $end,
            sort: TIME
          ) {
            id
            episode
            airingAt
            media {
              id
              idMal
              title {
                romaji
                english
                native
              }
              coverImage {
                large
                extraLarge
              }
              bannerImage
              format
              episodes
              isAdult
              genres
            }
          }
        }
      }
    `;

    const data = await anilist(query, {
      start,
      end,
    });

    const results =
      data?.Page?.airingSchedules
        ?.filter((item) => item?.media && !item.media.isAdult)
        ?.filter((item) => {
          const genres = item.media.genres || [];
          return !genres.includes("Hentai") && !genres.includes("Ecchi");
        })
        ?.map((item) => {
          const media = item.media;

          const title =
            media.title?.english ||
            media.title?.romaji ||
            media.title?.native ||
            "Anime";

          return {
            id: media.id,
            anilistId: media.id,
            malId: media.idMal,
            title,
            name: title,
            episode: item.episode,
            airingAt: item.airingAt,
            time: new Date(item.airingAt * 1000).toLocaleTimeString("en-IN", {
              hour: "2-digit",
              minute: "2-digit",
              hour12: true,
            }),
            image: media.coverImage?.extraLarge || media.coverImage?.large,
            poster: media.coverImage?.extraLarge || media.coverImage?.large,
            banner: media.bannerImage || media.coverImage?.extraLarge,
            type: media.format || "TV",
            episodes: media.episodes || "?",
          };
        }) || [];

    await setSupabaseCache(
      "schedule_cache",
      cacheKey,
      results,
      TTL.SCHEDULE
    );

    res.json({
      status: "ok",
      source: "anilist",
      date,
      results,
    });
  } catch (error) {
    console.log("Schedule error:", error?.response?.status || error.message);

    const fallback = await getSupabaseCache("schedule_cache", cacheKey);

    if (fallback?.data) {
      return res.json({
        status: "ok",
        source: "stale-cache",
        date,
        results: fallback.data,
      });
    }

    res.json({
      status: "ok",
      source: "failed",
      date,
      results: [],
    });
  }
});

app.get("/api/tmdb/:id", async (req, res) => {
  const id = Number(req.params.id);

  if (!id) {
    return res.status(400).json({
      status: "error",
      data: null,
    });
  }

  const forceRefresh =
    String(req.query.refresh || "").toLowerCase() === "true" ||
    String(req.query.force || "").toLowerCase() === "true";

  if (forceRefresh && supabase) {
    await supabase
      .from("search_cache")
      .delete()
      .eq("cache_key", `tmdb-anime-${id}`);
  }

  const data = await getTmdbAnimeData(id, forceRefresh);

  res.json({
    status: "ok",
    forceRefresh,
    data,
  });
});

app.listen(PORT, () => {
  console.log(`🔥 OFFANIME Smart Hybrid API running on http://localhost:${PORT}`);
});
