#!/usr/bin/env node

// Fetches power data from City of Data API and saves as static JSON files.
// Usage: node scripts/fetch-data.js

import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DATA_DIR = join(ROOT, 'data');
const BASE_URL = 'https://cod.cohcb.com/homecoming';

const POWERSETS = [
  { archetype: 'blaster', category: 'blaster_ranged', powerset: 'fire_blast' },
];

async function fetchJSON(url) {
  console.log(`  GET ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${url}`);
  return res.json();
}

function saveJSON(filePath, data) {
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(filePath, JSON.stringify(data, null, 2));
  console.log(`  -> ${filePath}`);
}

async function fetchArchetypeTables(archetype) {
  console.log(`\nFetching ${archetype} modifier tables...`);
  const data = await fetchJSON(`${BASE_URL}/tables/${archetype}.json`);
  saveJSON(join(DATA_DIR, archetype, 'tables.json'), data);
  return data;
}

async function fetchPowerset(archetype, category, powerset) {
  console.log(`\nFetching powerset index: ${category}/${powerset}...`);
  const index = await fetchJSON(`${BASE_URL}/powers/${category}/${powerset}.json`);
  const setDir = join(DATA_DIR, archetype, powerset);
  saveJSON(join(setDir, 'index.json'), index);

  const powers = index.powers || index;
  const powerNames = Array.isArray(powers)
    ? powers.map(p => typeof p === 'string' ? p : p.name || p.power_name)
    : Object.keys(powers);

  for (const powerName of powerNames) {
    const slug = powerName.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/_+$/, '');
    console.log(`\nFetching power: ${powerName}...`);
    try {
      const powerData = await fetchJSON(
        `${BASE_URL}/powers/${category}/${powerset}/${encodeURIComponent(powerName)}.json`
      );
      saveJSON(join(setDir, `${slug}.json`), powerData);

      // Check for redirect/pet powers (like Blazing Bolt -> quick mode)
      await fetchPetPowers(powerData, setDir, category, powerset, powerName);
    } catch (err) {
      console.error(`  ERROR fetching ${powerName}: ${err.message}`);
    }
  }
}

async function fetchPetPowers(powerData, setDir, category, powerset, powerName) {
  const effects = powerData.effects || [];
  for (const effect of effects) {
    const templates = effect.templates || [];
    for (const tpl of templates) {
      // Look for Grant_Power or entity-spawning effects that point to pet powers
      if (tpl.type === 'EntCreate' && tpl.entity_name) {
        const entityName = tpl.entity_name;
        console.log(`  Found entity spawn: ${entityName}`);
        // Try to fetch the pet power data
        try {
          const parts = entityName.split('.');
          const petCategory = parts.length > 1 ? parts.slice(0, -1).join('/') : `pets/${category}`;
          const petName = parts[parts.length - 1];
          // Try common pet power URL patterns
          const petUrl = `${BASE_URL}/powers/pets/${entityName.replace(/\./g, '/')}.json`;
          const petData = await fetchJSON(petUrl);
          const petSlug = entityName.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/_+$/, '');
          const petsDir = join(setDir, 'pets');
          saveJSON(join(petsDir, `${petSlug}.json`), petData);
        } catch (err) {
          console.log(`  Could not fetch pet entity ${entityName}: ${err.message}`);
        }
      }

      // Look for redirect powers (like sniper engaged mode)
      if (tpl.type === 'Redirect' && tpl.power_name) {
        console.log(`  Found redirect to: ${tpl.power_name}`);
        try {
          const redirectUrl = `${BASE_URL}/powers/${tpl.power_name.replace(/\./g, '/')}.json`;
          const redirectData = await fetchJSON(redirectUrl);
          const slug = tpl.power_name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/_+$/, '');
          const petsDir = join(setDir, 'pets');
          saveJSON(join(petsDir, `${slug}.json`), redirectData);
        } catch (err) {
          console.log(`  Could not fetch redirect ${tpl.power_name}: ${err.message}`);
        }
      }
    }
  }
}

async function main() {
  console.log('CoH DPS Finder - Data Fetcher');
  console.log('==============================');

  for (const { archetype, category, powerset } of POWERSETS) {
    await fetchArchetypeTables(archetype);
    await fetchPowerset(archetype, category, powerset);
  }

  console.log('\nDone!');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
