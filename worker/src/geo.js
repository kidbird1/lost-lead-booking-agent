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
  try {
    const near = await geocode(location, profile.country, profile.base, boxDeg);
    if (near && isTown(near)) hit = near; // they named a town that is local
    else {
      const wide = await geocode(location, profile.country);
      if (wide && isTown(wide)) hit = wide; // they named a town somewhere else
      else hit = near || wide || (await geocode(location)); // just a street: assume their local one
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
    text: `OUTSIDE the service area: ${hit.place} is about ${dist} away and the limit is ${profile.radius} ${profile.units}. ` +
      "First confirm the town with the caller in one short question, in case you heard it wrong. If they confirm it, politely say the team only works in their local area and cannot help with this one, suggest they look for someone local, say goodbye and end the call. If they correct the town, call the check again with the corrected town.",
  };
}
