# Should I Go Outside?

A small, fully client-side mobile web page that helps you decide whether to
go outside: current temperature, a rain/umbrella recommendation for the next
few hours, pollen levels, and active severe weather alerts.

No backend, no build step, no API keys. Three plain files:

```
index.html
style.css
app.js
```

## APIs used (all free, keyless, CORS-enabled)

| Purpose | API | Notes |
|---|---|---|
| City search | [Open-Meteo Geocoding API](https://open-meteo.com/en/docs/geocoding-api) | `geocoding-api.open-meteo.com/v1/search` |
| Current temp + feels-like + hourly precipitation probability | [Open-Meteo Forecast API](https://open-meteo.com/en/docs) | `api.open-meteo.com/v1/forecast` |
| Pollen levels (measured, Europe) | [Open-Meteo Air Quality API](https://open-meteo.com/en/docs/air-quality-api) | `air-quality-api.open-meteo.com/v1/air-quality`, pollen fields via the `cams_europe` domain |
| Pollen levels (estimated, everywhere else) | Built client-side, see below | No API — pure JS, no key, no billing |
| Severe weather alerts | [NWS Alerts API](https://www.weather.gov/documentation/services-web-api) | `api.weather.gov/alerts/active?point=lat,lon` |

**Coverage limitations worth knowing:**
- **Pollen**: Open-Meteo's pollen forecast is backed by the CAMS *European*
  air-quality model, so directly measured pollen data is really only
  available for locations in and around Europe.
- **Severe alerts**: The National Weather Service only covers the United
  States (and territories). For non-US locations the app shows a message
  explaining alerts aren't available there, instead of erroring.

### Why pollen is "estimated" for the US (and everywhere outside Europe)

Every US-capable pollen API that gives real measured counts — Google's
Pollen API, Ambee, Tomorrow.io's premium layer — requires either a paid plan
or a billing-enabled account, even if usage stays inside a free quota. To
keep this project fully static, keyless, and free with zero setup, the app
instead falls back to a **client-side seasonal estimate** for any location
without real Open-Meteo pollen data:

- Tree, grass, and ragweed/weed pollen are each modeled as a curve over the
  year, centered on a typical peak day (roughly: tree in spring, grass in
  early summer, ragweed in late summer/fall).
- The peak shifts earlier for southern latitudes and later for northern ones
  (e.g., Gulf Coast tree pollen arrives well before Upper Midwest tree
  pollen), using the location's latitude.
- The result is then adjusted by the current weather the app has already
  fetched for the temperature/rain sections: freezing temperatures suppress
  pollen release, recent rain washes pollen out of the air, and wind
  increases how much is airborne.

This adds no extra network request — it reuses the temperature, precipitation,
and wind data already pulled from the Open-Meteo Forecast API. It's clearly
labeled "Estimated" in the UI and comes with an explanatory note, since it's
a rough approximation calibrated for temperate Northern Hemisphere climates
(i.e., most of the continental US) — not a substitute for a real measured
pollen count. The estimation logic lives in `computePollenEstimate()` in
`app.js` if you want to tune the peak days, season widths, or weather
multipliers.

If you later decide a billing account is acceptable, swapping in Google's
Pollen API for the US case is a straightforward addition — it's just been
kept out to preserve the "no billing, no key" constraint.

## Running locally

Just open `index.html` in a browser — but note that `navigator.geolocation`
requires either `https://` or `localhost`, not a bare `file://` URL. Easiest
fix is to serve it locally:

```bash
python3 -m http.server 8080
# then visit http://localhost:8080
```

## Deploying to GitHub Pages

1. Create a new GitHub repo (or use an existing one) and push these three
   files to it (e.g. on the `main` branch, at the repo root or in a `/docs`
   folder).
2. In the repo, go to **Settings → Pages**.
3. Under **Build and deployment**, set **Source** to "Deploy from a branch",
   pick `main` (and `/root` or `/docs`, matching where you put the files).
4. Save. GitHub will publish the page at
   `https://<your-username>.github.io/<repo-name>/` within a minute or two.

Because geolocation requires a secure context, GitHub Pages (which serves
over HTTPS) works correctly out of the box.

## How the umbrella/raincoat recommendation works

The app looks at the precipitation probability for the next 6 hours from
Open-Meteo's hourly forecast and takes the highest value in that window:

- **< 30%** — low chance, no umbrella recommended.
- **30–59%** — moderate chance, umbrella suggested.
- **≥ 60%** — high chance; if it's also near/below freezing, the copy
  suggests a warm waterproof coat instead of just an umbrella.

This is a simple heuristic, not a meteorological model — feel free to adjust
the thresholds in `renderPrecipitation()` in `app.js`.

## Accessibility & resilience notes

- Every section has its own independent loading / error / loaded state, so
  one failed request (e.g. alerts) doesn't block the others (e.g. current
  temperature) from showing.
- Errors include a "Try again" button that retries only that section.
- Denying the location permission doesn't dead-end the app — it falls back
  to the manual city search.
- Last-used location is remembered in `localStorage` so returning visitors
  see data immediately without re-prompting for permission.
- Focus states are visible for keyboard users; reduced-motion preference is
  respected for the loading skeletons.
