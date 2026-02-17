// Loads bundled JSON data from the data/ directory

const DATA_BASE = 'data';

async function loadJSON(path) {
  const res = await fetch(`${DATA_BASE}/${path}`);
  if (!res.ok) throw new Error(`Failed to load ${path}: ${res.status}`);
  return res.json();
}

export async function loadArchetypeTables(archetype) {
  return loadJSON(`${archetype}/tables.json`);
}

export async function loadPower(archetype, powerset, powerSlug) {
  return loadJSON(`${archetype}/${powerset}/${powerSlug}.json`);
}

export async function loadPetPower(archetype, powerset, petSlug) {
  return loadJSON(`${archetype}/${powerset}/pets/${petSlug}.json`);
}

// Load all powers for a given archetype/powerset
export async function loadAllPowers(archetype, powerset) {
  const powerSlugs = getPowerSlugs(archetype, powerset);
  const powers = {};
  for (const slug of powerSlugs) {
    try {
      powers[slug] = await loadPower(archetype, powerset, slug);
    } catch (e) {
      console.warn(`Could not load power ${slug}:`, e);
    }
  }
  return powers;
}

// Hardcoded power lists per powerset (fetched from API)
function getPowerSlugs(archetype, powerset) {
  if (archetype === 'blaster' && powerset === 'fire_blast') {
    return [
      'flares', 'fire_blast', 'fire_ball', 'fire_breath',
      'aim', 'blaze', 'blazing_bolt', 'inferno', 'rain_of_fire'
    ];
  }
  if (archetype === 'blaster' && powerset === 'fire_manipulation') {
    return [
      'ring_of_fire', 'fire_sword', 'build_up', 'combustion',
      'blazing_aura', 'hot_feet', 'consume', 'fire_sword_circle'
    ];
  }
  return [];
}

// Pet/redirect power paths per power
export function getRedirectSlugs(powerSlug) {
  if (powerSlug === 'blazing_bolt') {
    return {
      quick: 'pets_blaster_fire_snipe_blazing_bolt_quick',
      normal: 'pets_blaster_fire_snipe_blazing_bolt_normal'
    };
  }
  if (powerSlug === 'rain_of_fire') {
    return {
      pet: 'rainoffire_rainoffire'
    };
  }
  return null;
}
