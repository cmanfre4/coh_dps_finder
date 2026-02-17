# CoH DPS Attack Chain Calculator

Finds the highest DPS repeating attack chains for City of Heroes (Homecoming) powersets.

**Live:** [https://cmanfre4.github.io/coh_dps_finder/](https://cmanfre4.github.io/coh_dps_finder/)

## Features

- Exhaustive search of all chain combinations up to length 8
- ArcanaTime-corrected animation times
- DoT tick calculation
- Defiance (Blaster inherent) damage buff simulation with per-power stacking
- Blazing Bolt quick/engaged snipe mode
- All powers (ST, AoE, Cone) compete equally on DPA
- Adjustable global recharge bonus (0–200%)

## Currently Supported

- **Blaster** / **Fire Blast**

## Running Locally

Serve with any static file server:

```bash
python3 -m http.server 8080
```

Open `http://localhost:8080` in a browser.

## Refreshing Power Data

Data is bundled as static JSON fetched from the [City of Data](https://cod.cohcb.com) API.

```bash
bash scripts/fetch-data.sh
```

## Tech

Vanilla HTML/CSS/JavaScript with ES modules. No framework, no build step.
