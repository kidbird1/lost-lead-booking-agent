// Service-area check. Works in any country using OpenStreetMap (free, no key, about 1 lookup a second).

const UA = "missed-call-agent/1.0 (+https://missed-call-agent.wwape4.workers.dev)";

export async function geocode(query, country = "", near = null, boxDeg = 1) {
  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.searchParams.set("q", query);
  url.searchParams.set("format", "json");
  url.searchParams.set("limit", "1");
  url.searchParams.set("addressdetails", "1");
  if (country) url.searchParams.set("countrycodes", country.toLowerCase());
  if (near) {
    // Prefer matches near the business (a "Main Street" near them, not one 1,000 miles away).
    // Only look inside a box around the business (local-first search).
    url.searchParams.set("viewbox", [near.lng - boxDeg, near.lat + boxDeg, near.lng + boxDeg, near.lat - boxDeg].join(","));
    url.searchParams.set("bounded", "1");
  }
  const res = await fetch(url, { headers: { "user-agent": UA, "accept-language": "en" } });
  if (!res.ok) throw new Error(`map lookup failed (${res.status})`);
  const [hit] = await res.json();
  if (!hit) return null;
  const a = hit.address || {};
  const town = a.city || a.town || a.village || a.hamlet || a.suburb || a.county || "";
  const place = [town, a.state || a.region, a.country_code?.toUpperCase()].filter(Boolean).join(", ") || hit.display_name;
  const kind = hit.addresstype || hit.type || "";
  return { lat: Number(hit.lat), lng: Number(hit.lon), place, kind, country: a.country_code?.toUpperCase() || "" };
}

const TOWN_KINDS = new Set(["city", "town", "village", "hamlet", "suburb", "municipality", "county", "state", "region",
  "province", "postcode", "borough", "quarter", "neighbourhood", "city_district", "district", "island", "country"]);
const isTown = (hit) => TOWN_KINDS.has(hit.kind);

// "five six two four Linson Blvd" -> "5624 Linson Blvd" (the agent hears numbers as words).
const DIGITS = { zero: 0, oh: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9 };
export function spokenToDigits(text) {
  return String(text)
    .replace(/\b(?:zero|oh|one|two|three|four|five|six|seven|eight|nine)(?:[\s-]+(?:zero|oh|one|two|three|four|five|six|seven|eight|nine))+\b/gi,
      (m) => m.toLowerCase().split(/[\s-]+/).map((w) => DIGITS[w]).join(""))
    .replace(/(\d)\s+(?=\d)/g, "$1"); // "3 3 4 8 7" -> "33487"
}

// Postcode lookup (free, no key): much better than the map for ZIPs, including PO-box ZIPs.
const POSTCODE = { US: /\b\d{5}\b/, AU: /\b\d{4}\b/, NZ: /\b\d{4}\b/, CA: /\b[A-Z]\d[A-Z]\b/i, GB: /\b[A-Z]{1,2}\d[A-Z\d]?\b/i };
async function postcodeLookup(text, country) {
  const m = POSTCODE[country]?.exec(text);
  if (!m) return null;
  const res = await fetch(`https://api.zippopotam.us/${country.toLowerCase()}/${encodeURIComponent(m[0].toUpperCase())}`).catch(() => null);
  if (!res?.ok) return null;
  const p = (await res.json()).places?.[0];
  if (!p) return null;
  return { lat: Number(p.latitude), lng: Number(p.longitude), place: [p["place name"], p.state, country].filter(Boolean).join(", "), kind: "postcode", country };
}

export function distanceKm(a, b) {
  const rad = (d) => (d * Math.PI) / 180;
  const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(h));
}

// Returns { status: inside | outside | unknown, text } where text is what the agent is told.
export async function checkArea(profile, location) {
  if (!profile.base?.lat) return { status: "unknown", text: "No service area is set for this business. Continue and take their details." };
  let hit = null;
  // Search near the business first (so "123 Main Street" means THEIR Main Street),
  // then the whole country, then anywhere (catches callers far away).
  const radiusKm = profile.units === "km" ? profile.radius : profile.radius / 0.621371;
  const boxDeg = Math.min(Math.max(radiusKm / 111, 0.2), 3);
  const text = spokenToDigits(location);
  const country = profile.country || "US";
  try {
    // 1. A ZIP or postcode in the business's country wins (a bare ZIP never matches another country).
    hit = await postcodeLookup(text, country);
    if (!hit) {
      // 2. Near the business first, so "123 Main Street" means THEIR Main Street.
      const near = await geocode(text, country, profile.base, boxDeg);
      if (near && isTown(near)) hit = near; // they named a local town
      else {
        // 3. The rest of their country.
        const wide = await geocode(text, country);
        if (wide && isTown(wide)) hit = wide; // they named a town somewhere else
        else if (near || wide) hit = near || wide; // just a street: assume the local one
        else if (!/^[\s\d-]+$/.test(text)) {
          // 4. Anywhere in the world, but only a real named town (never a bare number).
          const world = await geocode(text);
          if (world && isTown(world) && world.kind !== "postcode") hit = world;
        }
      }
    }
    // 5. Street misheard ("Linson" for "Linton")? Fall back to the town part after the first comma.
    if (!hit && text.includes(",")) {
      const town = text.slice(text.indexOf(",") + 1).trim();
      hit = (await postcodeLookup(town, country)) || (await geocode(town, country));
    }
  } catch {
    return { status: "unknown", text: "The map check is not working right now. Continue and take their details." };
  }
  if (!hit) {
    return { status: "unknown", text: "Could not find that place. Ask once for the town and ZIP or postcode. If it is still unclear, continue and take their details." };
  }
  const km = distanceKm(profile.base, hit);
  const miles = profile.units === "km" ? null : km * 0.621371;
  const dist = miles != null ? `${Math.round(miles)} miles` : `${Math.round(km)} km`;
  const limitKm = profile.units === "km" ? profile.radius : profile.radius / 0.621371;
  if (km <= limitKm) {
    return { status: "inside", place: hit.place, km, text: `INSIDE the service area: ${hit.place}, about ${dist} away. Continue.` };
  }
  return {
    status: "outside", place: hit.place, km,
    text: `Note: ${hit.place} is about ${dist} away, outside the usual area. ` +
      "Do not turn them away. Take their details as normal; the team will decide.",
  };
}
