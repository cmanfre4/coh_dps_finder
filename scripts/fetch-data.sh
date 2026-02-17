#!/bin/bash
# Fetches power data from City of Data API and saves as static JSON files.
# Usage: bash scripts/fetch-data.sh

set -euo pipefail

BASE_URL="https://cod.cohcb.com/homecoming"
DATA_DIR="data"

fetch_json() {
  local url="$1"
  local dest="$2"
  echo "  GET $url"
  mkdir -p "$(dirname "$dest")"
  curl -sS --fail "$url" > "$dest"
  echo "  -> $dest"
}

echo "CoH DPS Finder - Data Fetcher"
echo "=============================="

# Fetch Blaster modifier tables
echo ""
echo "Fetching blaster modifier tables..."
fetch_json "$BASE_URL/tables/blaster.json" "$DATA_DIR/blaster/tables.json"

# Known Fire Blast powers (from the all_power_search index)
CATEGORY="blaster_ranged"
POWERSET="fire_blast"
AT="blaster"
POWERS="flares fire_blast blaze blazing_bolt fire_ball fire_breath aim inferno rain_of_fire"

for SLUG in $POWERS; do
  echo ""
  echo "Fetching power: $SLUG..."
  fetch_json "$BASE_URL/powers/$CATEGORY/$POWERSET/$SLUG.json" "$DATA_DIR/$AT/$POWERSET/$SLUG.json"
done

echo ""
echo "Checking for pet/entity powers..."

# Parse each power for entity spawns and redirects
python3 << 'PYEOF'
import json, os, subprocess, glob

BASE_URL = "https://cod.cohcb.com/homecoming"
DATA_DIR = "data/blaster/fire_blast"
PETS_DIR = os.path.join(DATA_DIR, "pets")

for fpath in sorted(glob.glob(os.path.join(DATA_DIR, "*.json"))):
    fname = os.path.basename(fpath)
    with open(fpath) as f:
        data = json.load(f)

    for effect in data.get("effects", []):
        for tpl in effect.get("templates", []):
            # Entity spawns (Rain of Fire, etc.)
            entity = tpl.get("entity_name", "")
            if entity:
                print(f"  Entity spawn in {fname}: {entity}")
                pet_path = entity.replace(".", "/")
                url = f"{BASE_URL}/powers/pets/{pet_path}.json"
                slug = entity.lower().replace(".", "_")
                dest = os.path.join(PETS_DIR, f"{slug}.json")
                os.makedirs(PETS_DIR, exist_ok=True)
                print(f"  Trying: {url}")
                r = subprocess.run(["curl", "-sS", "--fail", url],
                                   capture_output=True, text=True, timeout=10)
                if r.returncode == 0:
                    with open(dest, "w") as out:
                        out.write(r.stdout)
                    print(f"  -> {dest}")

                    # Parse the pet power to find its attacks
                    try:
                        pet_data = json.loads(r.stdout)
                        # If it's a powerset, get its powers
                        pet_powers = pet_data.get("powers", [])
                        if isinstance(pet_powers, list):
                            for pp in pet_powers:
                                pname = pp if isinstance(pp, str) else pp.get("name", "")
                                if pname:
                                    purl = f"{BASE_URL}/powers/pets/{pet_path}/{pname.lower().replace(' ', '_')}.json"
                                    pdest = os.path.join(PETS_DIR, f"{slug}_{pname.lower().replace(' ', '_')}.json")
                                    print(f"  Trying pet power: {purl}")
                                    r2 = subprocess.run(["curl", "-sS", "--fail", purl],
                                                       capture_output=True, text=True, timeout=10)
                                    if r2.returncode == 0:
                                        with open(pdest, "w") as out2:
                                            out2.write(r2.stdout)
                                        print(f"  -> {pdest}")
                    except Exception as e:
                        print(f"  Parse error: {e}")
                else:
                    # Try alternative URL patterns
                    for alt in [
                        f"{BASE_URL}/powers/{entity.replace('.', '/')}.json",
                    ]:
                        print(f"  Trying alt: {alt}")
                        r2 = subprocess.run(["curl", "-sS", "--fail", alt],
                                           capture_output=True, text=True, timeout=10)
                        if r2.returncode == 0:
                            with open(dest, "w") as out:
                                out.write(r2.stdout)
                            print(f"  -> {dest}")
                            break

            # Redirects (sniper engaged mode)
            redirect = tpl.get("redirect_power", "") or tpl.get("redirect", "")
            if redirect:
                print(f"  Redirect in {fname}: {redirect}")

PYEOF

# Also fetch Blazing Bolt quick snipe variant if it exists
echo ""
echo "Fetching Blazing Bolt quick/engaged mode..."
for URL_PATTERN in \
  "$BASE_URL/powers/pets/blaster_fire_snipe/blazing_bolt_quick.json" \
  "$BASE_URL/powers/pets/blaster_ranged_fire_snipe/blazing_bolt.json" \
  "$BASE_URL/powers/blaster_ranged/fire_blast/blazing_bolt_fast.json"; do
  echo "  Trying: $URL_PATTERN"
  if curl -sS --fail "$URL_PATTERN" > /tmp/bb_quick.json 2>/dev/null; then
    mkdir -p "$DATA_DIR/$AT/$POWERSET/pets"
    cp /tmp/bb_quick.json "$DATA_DIR/$AT/$POWERSET/pets/blazing_bolt_quick.json"
    echo "  -> Found quick snipe!"
    break
  fi
done

echo ""
echo "Fetching complete!"
