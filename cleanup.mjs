import WebSocket from "ws";
if (typeof globalThis.WebSocket === "undefined") globalThis.WebSocket = WebSocket;
import dotenv from "dotenv"; dotenv.config();
import { createClient } from "@supabase/supabase-js";
const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth:{persistSession:false} });
const tables = ["search_cache","home_cache","anime_details","anime_seasons","anime_episodes"];
for (const t of tables) {
  try {
    const { data, error } = await s.from(t).select("cache_key, payload");
    if (error) { console.log(t, "select err:", error.message); continue; }
    let removed = 0;
    for (const row of (data||[])) {
      const p = row.payload;
      const emptyArr = Array.isArray(p) && p.length === 0;
      const emptyRes = p && Array.isArray(p.results) && p.results.length === 0;
      if (emptyArr || emptyRes) {
        await s.from(t).delete().eq("cache_key", row.cache_key);
        removed++;
      }
    }
    console.log(t, "rows:", (data||[]).length, "removed empty:", removed);
  } catch(e){ console.log(t,"ERR",e.message); }
}
console.log("cleanup done");
