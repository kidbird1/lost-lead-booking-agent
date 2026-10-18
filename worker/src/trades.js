// Trade presets. A client's "industry" picks one; anything unknown uses "general".
// mobile: true = the job happens where the caller is right now (car lockout, tow), not at a home address.

export const TRADES = {
  plumber: {
    label: "plumbing",
    ask: ["What's going on (leak, clog, no hot water, something else)?", "Is water leaking right now, and can they shut it off?", "Do they own the home or rent?"],
    urgentIf: "water is actively leaking or flooding, a pipe burst, sewage is backing up, or there is no water at all",
  },
  hvac: {
    label: "heating and air conditioning",
    ask: ["Is it heating, cooling, or both?", "What is it doing (not turning on, blowing warm, strange noise)?", "Roughly how old is the system, if they know?"],
    urgentIf: "they have no heat in freezing weather, no cooling in extreme heat, or someone vulnerable (baby, elderly, sick) is in the home",
  },
  electrician: {
    label: "electrical",
    ask: ["What is the problem (outlet, breaker, lights, new install)?", "Is power out to part or all of the home?"],
    urgentIf: "there are sparks, burning smell, smoke, exposed live wires, or total power loss",
    danger: true,
  },
  locksmith: {
    label: "locksmith",
    mobile: true,
    ask: ["Is it a car, home, or business?", "If a car: the make, model and year.", "Is anyone or any pet locked inside?"],
    urgentIf: "they are locked out right now, especially if a child or pet is inside or they are somewhere unsafe",
  },
  mechanic: {
    label: "auto repair and towing",
    mobile: true,
    ask: ["The car's year, make and model.", "What is it doing?", "Does it still drive, or does it need a tow?"],
    urgentIf: "they are stranded on the road or the car is not safe to drive",
  },
  solar: {
    label: "solar",
    ask: ["Do they own the home?", "Roughly what is their monthly electric bill?", "Roughly how old is the roof?", "Is this a new install or a problem with an existing system?"],
    urgentIf: "an existing system shows sparks, burning smell, or damage",
  },
  roofer: {
    label: "roofing",
    ask: ["Is it a leak, storm damage, repair, or a new roof?", "Is water coming inside right now?", "Is this an insurance claim?"],
    urgentIf: "water is coming inside right now or the roof is open after a storm",
  },
  cleaner: {
    label: "cleaning",
    ask: ["What kind of cleaning (regular, deep clean, move-out, office)?", "Roughly how many bedrooms and bathrooms or the size of the space?"],
    urgentIf: "they need it today or tomorrow",
  },
  pest: {
    label: "pest control",
    ask: ["What pest is it (ants, roaches, termites, rodents, wasps, other)?", "Where in the property and for how long?"],
    urgentIf: "there is a stinging insect nest near people or a rodent inside living areas",
  },
  general: {
    label: "home and local services",
    ask: ["What do they need done?"],
    urgentIf: "something is unsafe, causing damage right now, or they say it is an emergency",
  },
};

const ALIASES = {
  plumbing: "plumber", plumbers: "plumber", hvac: "hvac", heating: "hvac", "air conditioning": "hvac", ac: "hvac",
  electrical: "electrician", electric: "electrician", locksmiths: "locksmith", lockout: "locksmith", "car lockout": "locksmith",
  auto: "mechanic", "auto repair": "mechanic", towing: "mechanic", tow: "mechanic", mechanics: "mechanic",
  roofing: "roofer", roof: "roofer", cleaning: "cleaner", "house cleaning": "cleaner", pest: "pest", "pest control": "pest",
};

export function tradeFor(industry = "") {
  const key = String(industry).trim().toLowerCase();
  return TRADES[key] || TRADES[ALIASES[key]] || TRADES.general;
}
