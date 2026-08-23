/*
 * Should I Go Outside? — fully client-side.
 * APIs used (all free, no API key required, all support CORS from the browser):
 *   - Open-Meteo Geocoding API  : https://open-meteo.com/en/docs/geocoding-api
 *   - Open-Meteo Forecast API   : https://open-meteo.com/en/docs
 *   - Open-Meteo Air Quality API: https://open-meteo.com/en/docs/air-quality-api  (pollen fields)
 *   - NWS Alerts API            : https://www.weather.gov/documentation/services-web-api (US only)
 */

(() => {
  "use strict";

  const STORAGE_KEY_UNIT = "sigo_unit_pref";
  const STORAGE_KEY_LAST_LOCATION = "sigo_last_location";

  const els = {
    useLocationBtn: document.getElementById("use-location-btn"),
    currentLocationLabel: document.getElementById("current-location-label"),
    searchForm: document.getElementById("search-form"),
    searchInput: document.getElementById("search-input"),
    searchResults: document.getElementById("search-results"),
    toast: document.getElementById("toast"),
    sections: {
      current: document.querySelector("#section-current .card-body"),
      precip: document.querySelector("#section-precip .card-body"),
      pollen: document.querySelector("#section-pollen .card-body"),
      alerts: document.querySelector("#section-alerts .card-body"),
    },
  };

  let unitPref = localStorage.getItem(STORAGE_KEY_UNIT) || "f"; // 'f' or 'c'
  let activeLocation = null; // { lat, lon, label }
  let searchDebounceTimer = null;
  let searchRequestToken = 0;
  let alertsMapInstance = null; // current Leaflet map for the alerts section, if any

  // ---------- Utility: rendering helpers ----------

  function setSectionState(sectionEl, state, html) {
    sectionEl.dataset.state = state;
    sectionEl.innerHTML = html;
  }

  function loadingSkeleton(lines = 2) {
    const widths = ["long", "medium", "short"];
    let out = "";
    for (let i = 0; i < lines; i++) {
      out += `<div class="skeleton ${widths[i % widths.length]}"></div>`;
    }
    return out;
  }

  function errorBlock(message, retryFn) {
    const id = "retry-" + Math.random().toString(36).slice(2, 8);
    setTimeout(() => {
      const btn = document.getElementById(id);
      if (btn) btn.addEventListener("click", retryFn);
    }, 0);
    return `
      <p class="error-text">${escapeHtml(message)}</p>
      <button id="${id}" class="btn btn-secondary retry-btn" type="button">Try again</button>
    `;
  }

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  function showToast(message, duration = 4000) {
    els.toast.textContent = message;
    els.toast.hidden = false;
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => { els.toast.hidden = true; }, duration);
  }

  // ---------- Geolocation ----------

  function useCurrentLocation() {
    if (!("geolocation" in navigator)) {
      showToast("Your browser doesn't support location access. Try searching for a city instead.");
      return;
    }

    els.useLocationBtn.disabled = true;
    els.useLocationBtn.textContent = "Locating…";
    setAllSectionsLoading();

    navigator.geolocation.getCurrentPosition(
      (position) => {
        resetLocationButton();
        const { latitude, longitude } = position.coords;
        setActiveLocation({ lat: latitude, lon: longitude, label: "Current location" });
      },
      (err) => {
        resetLocationButton();
        let message = "Couldn't get your location.";
        if (err.code === err.PERMISSION_DENIED) {
          message = "Location access was denied. You can search for a city instead.";
        } else if (err.code === err.POSITION_UNAVAILABLE) {
          message = "Your location is currently unavailable. Try searching for a city instead.";
        } else if (err.code === err.TIMEOUT) {
          message = "Location request timed out. Try again or search for a city.";
        }
        showToast(message, 6000);
        resetAllSectionsIdle("Choose a location above to load conditions.");
      },
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 5 * 60 * 1000 }
    );
  }

  function resetLocationButton() {
    els.useLocationBtn.disabled = false;
    els.useLocationBtn.innerHTML = '<span class="icon" aria-hidden="true">📍</span> Use my current location';
  }

  // ---------- City search (Open-Meteo Geocoding) ----------

  function handleSearchInput() {
    const query = els.searchInput.value.trim();
    clearTimeout(searchDebounceTimer);
    if (query.length < 2) {
      hideSearchResults();
      return;
    }
    searchDebounceTimer = setTimeout(() => runGeocodeSearch(query), 350);
  }

  async function runGeocodeSearch(query) {
    const token = ++searchRequestToken;
    try {
      const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(query)}&count=6&language=en&format=json`;
      const res = await fetch(url);
      if (token !== searchRequestToken) return; // stale
      if (!res.ok) throw new Error("Geocoding request failed");
      const data = await res.json();
      renderSearchResults(data.results || []);
    } catch (e) {
      if (token !== searchRequestToken) return;
      els.searchResults.innerHTML = `<li class="muted-text">Search unavailable — check your connection.</li>`;
      els.searchResults.hidden = false;
    }
  }

  function renderSearchResults(results) {
    if (!results.length) {
      els.searchResults.innerHTML = `<li class="muted-text">No matching places found.</li>`;
      els.searchResults.hidden = false;
      return;
    }
    els.searchResults.innerHTML = results
      .map((r, i) => {
        const parts = [r.name, r.admin1, r.country].filter(Boolean);
        return `<li role="option" tabindex="0" data-index="${i}">${escapeHtml(parts.join(", "))}</li>`;
      })
      .join("");
    els.searchResults.hidden = false;

    els.searchResults.querySelectorAll("li[data-index]").forEach((li) => {
      const idx = Number(li.dataset.index);
      const r = results[idx];
      const select = () => {
        const label = [r.name, r.admin1, r.country].filter(Boolean).join(", ");
        hideSearchResults();
        els.searchInput.value = label;
        setActiveLocation({ lat: r.latitude, lon: r.longitude, label });
      };
      li.addEventListener("click", select);
      li.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); select(); }
      });
    });
  }

  function hideSearchResults() {
    els.searchResults.hidden = true;
    els.searchResults.innerHTML = "";
  }

  // ---------- Location state ----------

  function setActiveLocation(loc) {
    activeLocation = loc;
    els.currentLocationLabel.textContent = loc.label ? `Showing: ${loc.label}` : "";
    try {
      localStorage.setItem(STORAGE_KEY_LAST_LOCATION, JSON.stringify(loc));
    } catch (e) { /* storage may be unavailable; non-fatal */ }
    loadAllSections(loc);
  }

  function setAllSectionsLoading() {
    disposeAlertsMap();
    setSectionState(els.sections.current, "loading", loadingSkeleton(3));
    setSectionState(els.sections.precip, "loading", loadingSkeleton(3));
    setSectionState(els.sections.pollen, "loading", loadingSkeleton(4));
    setSectionState(els.sections.alerts, "loading", loadingSkeleton(2));
  }

  function resetAllSectionsIdle(message) {
    disposeAlertsMap();
    const html = `<p class="placeholder-text">${escapeHtml(message)}</p>`;
    setSectionState(els.sections.current, "idle", html);
    setSectionState(els.sections.precip, "idle", html);
    setSectionState(els.sections.pollen, "idle", html);
    setSectionState(els.sections.alerts, "idle", html);
  }

  function loadAllSections(loc) {
    setAllSectionsLoading();
    loadAlerts(loc);
    // loadCurrentAndPrecip resolves with the parsed forecast data (or null on failure);
    // the pollen estimate reuses that data's temperature/precipitation/wind instead of
    // making a second request.
    loadCurrentAndPrecip(loc).then((forecastData) => loadPollen(loc, forecastData));
  }

  // ---------- Section 1 + 2: current conditions & precipitation ----------
  // Combined into one Open-Meteo forecast call.

  const WEATHER_CODE_LABELS = {
    0: "Clear sky", 1: "Mostly clear", 2: "Partly cloudy", 3: "Overcast",
    45: "Fog", 48: "Depositing rime fog",
    51: "Light drizzle", 53: "Drizzle", 55: "Dense drizzle",
    56: "Light freezing drizzle", 57: "Freezing drizzle",
    61: "Light rain", 63: "Rain", 65: "Heavy rain",
    66: "Light freezing rain", 67: "Freezing rain",
    71: "Light snow", 73: "Snow", 75: "Heavy snow", 77: "Snow grains",
    80: "Light rain showers", 81: "Rain showers", 82: "Violent rain showers",
    85: "Light snow showers", 86: "Heavy snow showers",
    95: "Thunderstorm", 96: "Thunderstorm with light hail", 99: "Thunderstorm with heavy hail",
  };

  async function loadCurrentAndPrecip(loc) {
    try {
      const tempUnit = unitPref === "f" ? "fahrenheit" : "celsius";
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${loc.lat}&longitude=${loc.lon}` +
        `&current=temperature_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m` +
        `&hourly=precipitation_probability,temperature_2m` +
        `&forecast_days=2&timezone=auto&temperature_unit=${tempUnit}&wind_speed_unit=mph`;
      const res = await fetch(url);
      if (!res.ok) throw new Error("Forecast request failed (" + res.status + ")");
      const data = await res.json();
      renderCurrentConditions(data);
      renderPrecipitation(data);
      return data;
    } catch (e) {
      const msg = "Couldn't load weather data. " + (navigator.onLine === false ? "You appear to be offline." : "The weather service may be temporarily unavailable.");
      setSectionState(els.sections.current, "error", errorBlock(msg, () => loadCurrentAndPrecip(loc).then((d) => loadPollen(loc, d))));
      setSectionState(els.sections.precip, "error", errorBlock(msg, () => loadCurrentAndPrecip(loc).then((d) => loadPollen(loc, d))));
      return null;
    }
  }

  function renderCurrentConditions(data) {
    const cur = data.current;
    if (!cur) {
      setSectionState(els.sections.current, "error", errorBlock("No current conditions available for this location.", () => {}));
      return;
    }
    const unitSymbol = unitPref === "f" ? "°F" : "°C";
    const label = WEATHER_CODE_LABELS[cur.weather_code] ?? "Conditions unavailable";
    const html = `
      <div class="temp-row">
        <span class="temp-main">${Math.round(cur.temperature_2m)}${unitSymbol}</span>
        <span class="temp-feels">Feels like ${Math.round(cur.apparent_temperature)}${unitSymbol}</span>
      </div>
      <p class="condition-label">${escapeHtml(label)} · Wind ${Math.round(cur.wind_speed_10m)} mph</p>
      <div class="unit-toggle" role="group" aria-label="Temperature unit">
        <button type="button" data-unit="f" class="${unitPref === "f" ? "active" : ""}" aria-pressed="${unitPref === "f"}">°F</button>
        <button type="button" data-unit="c" class="${unitPref === "c" ? "active" : ""}" aria-pressed="${unitPref === "c"}">°C</button>
      </div>
    `;
    setSectionState(els.sections.current, "loaded", html);
    els.sections.current.querySelectorAll("[data-unit]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const newUnit = btn.dataset.unit;
        if (newUnit === unitPref) return;
        unitPref = newUnit;
        localStorage.setItem(STORAGE_KEY_UNIT, unitPref);
        if (activeLocation) loadCurrentAndPrecip(activeLocation).then((d) => loadPollen(activeLocation, d));
      });
    });
  }

  function renderPrecipitation(data) {
    const hourly = data.hourly;
    if (!hourly || !hourly.time || !hourly.precipitation_probability) {
      setSectionState(els.sections.precip, "error", errorBlock("Hourly precipitation data isn't available for this location.", () => {}));
      return;
    }

    // Find the index closest to "now" using the location's own reported time.
    const nowIso = data.current?.time || new Date().toISOString();
    let startIdx = hourly.time.findIndex((t) => t >= nowIso);
    if (startIdx === -1) startIdx = 0;

    const windowSize = 6;
    const slice = hourly.time.slice(startIdx, startIdx + windowSize).map((t, i) => ({
      time: t,
      pct: hourly.precipitation_probability[startIdx + i],
    }));

    const maxPct = slice.reduce((m, h) => Math.max(m, h.pct ?? 0), 0);
    const isCold = (data.current?.temperature_2m ?? 50) <= (unitPref === "f" ? 34 : 1);

    let recClass, recIcon, recText;
    if (maxPct >= 60) {
      recClass = "rec-raincoat";
      recIcon = "🧥";
      recText = isCold
        ? `High chance of precipitation (${maxPct}%) — wear a warm, waterproof coat.`
        : `High chance of rain (${maxPct}%) — a raincoat is a good idea, an umbrella alone may not be enough.`;
    } else if (maxPct >= 30) {
      recClass = "rec-umbrella";
      recIcon = "☂️";
      recText = `Moderate chance of rain (${maxPct}%) in the next few hours — bring an umbrella just in case.`;
    } else {
      recClass = "rec-none";
      recIcon = "🙂";
      recText = `Low chance of rain (${maxPct}%) — you probably won't need an umbrella.`;
    }

    const hourlyHtml = slice
      .map((h) => {
        const d = new Date(h.time);
        const hourLabel = d.toLocaleTimeString([], { hour: "numeric" });
        return `
          <div class="hour-item">
            <div class="hour-label">${hourLabel}</div>
            <div class="hour-pct">${h.pct ?? "–"}%</div>
          </div>
        `;
      })
      .join("");

    const html = `
      <div class="recommendation ${recClass}">
        <span class="icon" aria-hidden="true">${recIcon}</span>
        <span>${escapeHtml(recText)}</span>
      </div>
      <div class="hourly-strip">${hourlyHtml}</div>
    `;
    setSectionState(els.sections.precip, "loaded", html);
  }

  // ---------- Section 3: pollen (Open-Meteo Air Quality API) ----------

  const POLLEN_FIELDS = [
    { key: "alder_pollen", label: "Alder" },
    { key: "birch_pollen", label: "Birch" },
    { key: "grass_pollen", label: "Grass" },
    { key: "mugwort_pollen", label: "Mugwort" },
    { key: "olive_pollen", label: "Olive" },
    { key: "ragweed_pollen", label: "Ragweed" },
  ];

  async function loadPollen(loc, forecastData) {
    // Try real measured/modeled pollen data first (Open-Meteo's CAMS Europe domain —
    // reliable mainly in and around Europe). If it comes back empty or fails, fall back
    // to a client-side seasonal estimate that works anywhere, including the US, with no
    // API key or billing account required.
    try {
      const fields = POLLEN_FIELDS.map((f) => f.key).join(",");
      const url = `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${loc.lat}&longitude=${loc.lon}` +
        `&current=${fields}&domains=cams_europe&timezone=auto`;
      const res = await fetch(url);
      if (res.ok) {
        const data = await res.json();
        const cur = data.current || {};
        const hasRealData = POLLEN_FIELDS.some((f) => cur[f.key] !== null && cur[f.key] !== undefined);
        if (hasRealData) {
          renderPollen(data);
          return;
        }
      }
    } catch (e) {
      // Network/API failure — fall through to the estimate below rather than erroring,
      // since the estimate needs nothing from this request.
    }
    renderEstimatedPollen(loc, forecastData);
  }

  // ---- Client-side seasonal pollen estimate (no API, no key, no billing) ----
  //
  // Models three broad pollen categories (tree, grass, ragweed/weed) as a triangular
  // curve over the year, centered on a typical peak day. The peak shifts earlier for
  // southern latitudes and later for northern ones (roughly matching how tree pollen
  // arrives in February in the Gulf Coast vs. May in the Upper Midwest). The result is
  // then adjusted using already-fetched current weather: freezing temperatures suppress
  // pollen release, recent rain washes pollen out of the air, and wind increases how much
  // is airborne. This is a rough approximation, not a measured count — the UI labels it
  // as "Estimated" accordingly. Calibrated for temperate Northern Hemisphere climates
  // (i.e., most of the continental US); accuracy will be lower elsewhere.

  const ESTIMATE_CATEGORIES = [
    { key: "tree", label: "Tree", basePeakDay: 90, halfWidthDays: 55 },
    { key: "grass", label: "Grass", basePeakDay: 160, halfWidthDays: 45 },
    { key: "ragweed", label: "Ragweed / Weed", basePeakDay: 260, halfWidthDays: 40 },
  ];
  const ESTIMATE_REFERENCE_LATITUDE = 40; // roughly central US
  const ESTIMATE_DAYS_PER_DEGREE_LATITUDE = 1.8;

  function dayOfYear(date) {
    const start = new Date(date.getFullYear(), 0, 0);
    return Math.floor((date - start) / 86400000);
  }

  function circularDayDistance(a, b, yearLength = 365) {
    const diff = Math.abs(a - b);
    return Math.min(diff, yearLength - diff);
  }

  function computePollenEstimate(latitude, date, weather) {
    const doy = dayOfYear(date);
    const isSouthernHemisphere = latitude < 0;

    return ESTIMATE_CATEGORIES.map((cat) => {
      let peak = cat.basePeakDay;
      if (isSouthernHemisphere) {
        peak = (peak + 182) % 365; // seasons offset by ~6 months below the equator
      }
      peak += (latitude - (isSouthernHemisphere ? -ESTIMATE_REFERENCE_LATITUDE : ESTIMATE_REFERENCE_LATITUDE)) * ESTIMATE_DAYS_PER_DEGREE_LATITUDE;
      peak = ((peak % 365) + 365) % 365;

      const distance = circularDayDistance(doy, peak);
      let intensity = Math.max(0, 100 * (1 - distance / cat.halfWidthDays));

      if (weather) {
        if (weather.tempF !== null && weather.tempF <= 32) {
          intensity *= 0.15; // dormant / frozen conditions
        } else if (weather.precipMm !== null && weather.precipMm > 0.5) {
          intensity *= 0.4; // rain washes pollen out of the air
        } else if (weather.windMph !== null && weather.windMph > 15) {
          intensity *= 1.3; // wind lofts more pollen
        }
      }

      intensity = Math.round(Math.min(100, Math.max(0, intensity)));
      const level = intensity < 25 ? "low" : intensity < 60 ? "moderate" : "high";
      return { label: cat.label, intensity, level };
    });
  }

  function renderEstimatedPollen(loc, forecastData) {
    let weather = null;
    if (forecastData && forecastData.current) {
      const c = forecastData.current;
      const tempF = typeof c.temperature_2m === "number"
        ? (unitPref === "f" ? c.temperature_2m : c.temperature_2m * 9 / 5 + 32)
        : null;
      weather = {
        tempF,
        precipMm: typeof c.precipitation === "number" ? c.precipitation : null,
        windMph: typeof c.wind_speed_10m === "number" ? c.wind_speed_10m : null,
      };
    }

    const results = computePollenEstimate(loc.lat, new Date(), weather);
    const levelRank = { low: 0, moderate: 1, high: 2 };
    const worst = results.reduce((max, r) => (levelRank[r.level] > levelRank[max.level] ? r : max), results[0]);
    const overallText = {
      low: "Overall estimated pollen: Low",
      moderate: "Overall estimated pollen: Moderate",
      high: "Overall estimated pollen: High",
    }[worst.level];

    const rows = results
      .map((r) => `
        <div class="pollen-name">${escapeHtml(r.label)}</div>
        <div class="pollen-bar-track"><div class="pollen-bar-fill pollen-level-${r.level}" style="width:${r.intensity}%"></div></div>
      `)
      .join("");

    const html = `
      <p class="pollen-overall">
        ${overallText}
        <span class="badge-estimated">Estimated</span>
      </p>
      <div class="pollen-grid">${rows}</div>
      <p class="muted-text" style="margin-top:12px; font-size:0.8rem;">
        This location isn't in Open-Meteo's directly measured pollen coverage, so these
        levels are estimated from typical seasonal timing for this latitude plus current
        temperature, rain, and wind — not a measured pollen count. For an official count,
        check a local news or health source.
      </p>
    `;
    setSectionState(els.sections.pollen, "loaded", html);
  }

  function pollenLevel(value) {
    // Rough thresholds in grains/m³, adequate for a simple low/moderate/high read.
    if (value === null || value === undefined) return null;
    if (value < 10) return "low";
    if (value < 50) return "moderate";
    return "high";
  }

  function renderPollen(data) {
    const cur = data.current || {};
    const readings = POLLEN_FIELDS.map((f) => ({ ...f, value: cur[f.key], level: pollenLevel(cur[f.key]) }));
    const anyData = readings.some((r) => r.level !== null);

    if (!anyData) {
      setSectionState(
        els.sections.pollen,
        "loaded",
        `<p class="muted-text">Pollen forecasting currently has reliable coverage mainly in Europe, so no data is available for this location.</p>`
      );
      return;
    }

    const levelRank = { low: 0, moderate: 1, high: 2 };
    const worst = readings
      .filter((r) => r.level !== null)
      .reduce((max, r) => (levelRank[r.level] > levelRank[max.level] ? r : max), readings.find((r) => r.level !== null));

    const overallText = {
      low: "Overall pollen: Low",
      moderate: "Overall pollen: Moderate",
      high: "Overall pollen: High",
    }[worst.level];

    const rows = readings
      .map((r) => {
        if (r.level === null) return "";
        const pct = Math.min(100, Math.round((r.value / 80) * 100));
        return `
          <div class="pollen-name">${escapeHtml(r.label)}</div>
          <div class="pollen-bar-track"><div class="pollen-bar-fill pollen-level-${r.level}" style="width:${pct}%"></div></div>
        `;
      })
      .join("");

    const html = `
      <p class="pollen-overall">${overallText}</p>
      <div class="pollen-grid">${rows}</div>
      <p class="muted-text" style="margin-top:12px; font-size:0.8rem;">
        Levels shown relative to a 0–80 grains/m³ scale, from Open-Meteo's CAMS Europe model.
      </p>
    `;
    setSectionState(els.sections.pollen, "loaded", html);
  }

  // ---------- Section 4: severe weather alerts (NWS, US only) ----------

  function disposeAlertsMap() {
    if (alertsMapInstance) {
      alertsMapInstance.remove();
      alertsMapInstance = null;
    }
  }

  async function loadAlerts(loc) {
    disposeAlertsMap();
    try {
      const url = `https://api.weather.gov/alerts/active?point=${loc.lat.toFixed(4)},${loc.lon.toFixed(4)}`;
      const res = await fetch(url, { headers: { Accept: "application/geo+json" } });

      if (res.status === 400 || res.status === 404) {
        // Outside NWS coverage (non-US location).
        setSectionState(
          els.sections.alerts,
          "loaded",
          `<p class="muted-text">Severe weather alerts are currently only available for locations in the United States.</p>`
        );
        return;
      }
      if (!res.ok) throw new Error("Alerts request failed (" + res.status + ")");

      const data = await res.json();
      renderAlerts(data);
    } catch (e) {
      setSectionState(els.sections.alerts, "error", errorBlock(
        "Couldn't check for severe weather alerts right now.",
        () => loadAlerts(loc)
      ));
    }
  }

  // Cap how many zone-geometry lookups we'll do per alert. A statewide watch can list
  // dozens of zones; fetching all of them one-by-one would be slow and heavy for what's
  // meant to be a lightweight static page, so beyond this cap we skip the map for that
  // alert rather than show a partial/misleading shape.
  const MAX_ZONES_PER_ALERT = 20;

  const SEVERITY_COLORS = {
    extreme: "#b3261e",
    severe: "#b3261e",
    moderate: "#b46a00",
    minor: "#5b6b78",
    unknown: "#5b6b78",
  };

  async function renderAlerts(data) {
    // Any previous map is tied to a DOM node that's about to be replaced — dispose of it
    // first to avoid leaking Leaflet instances.
    disposeAlertsMap();

    const features = data.features || [];
    if (!features.length) {
      setSectionState(els.sections.alerts, "loaded", `<p class="no-alerts">No active alerts for this area.</p>`);
      return;
    }

    const alertBoxesHtml = features
      .map((f) => {
        const p = f.properties || {};
        const severity = (p.severity || "unknown").toLowerCase();
        const effective = p.effective ? new Date(p.effective).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "";
        const expires = p.expires ? new Date(p.expires).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "";
        return `
          <div class="alert-box severity-${escapeHtml(severity)}">
            <p class="alert-title">${escapeHtml(p.event || "Weather Alert")}</p>
            <p class="alert-meta">${escapeHtml(p.areaDesc || "")}${effective ? " · Effective " + effective : ""}${expires ? " · Expires " + expires : ""}</p>
            <p class="alert-desc">${escapeHtml((p.headline || p.description || "").slice(0, 600))}${(p.description || "").length > 600 ? "…" : ""}</p>
          </div>
        `;
      })
      .join("");

    const html = `
      ${alertBoxesHtml}
      <div id="alerts-map-wrap" class="alerts-map-wrap">
        <div id="alerts-map" class="alerts-map"></div>
      </div>
    `;
    setSectionState(els.sections.alerts, "loaded", html);
    await buildAlertsMap(features);
  }

  async function fetchZoneGeometry(zoneUrl) {
    try {
      const res = await fetch(zoneUrl, { headers: { Accept: "application/geo+json" } });
      if (!res.ok) return null;
      const zone = await res.json();
      return zone.geometry || null;
    } catch (e) {
      return null;
    }
  }

  async function collectAlertShapes(features) {
    const shapes = []; // { geometry, color, popupText }

    for (const f of features) {
      const p = f.properties || {};
      const severity = (p.severity || "unknown").toLowerCase();
      const color = SEVERITY_COLORS[severity] || SEVERITY_COLORS.unknown;
      const popupText = escapeHtml(p.event || "Weather Alert") + (p.areaDesc ? ": " + escapeHtml(p.areaDesc) : "");

      if (f.geometry) {
        shapes.push({ geometry: f.geometry, color, popupText });
        continue;
      }

      const zoneUrls = Array.isArray(p.affectedZones) ? p.affectedZones : [];
      if (!zoneUrls.length || zoneUrls.length > MAX_ZONES_PER_ALERT) {
        continue; // no shape available, or too many zones to fetch individually
      }

      const geometries = await Promise.all(zoneUrls.map(fetchZoneGeometry));
      geometries.filter(Boolean).forEach((geometry) => {
        shapes.push({ geometry, color, popupText });
      });
    }

    return shapes;
  }

  async function buildAlertsMap(features) {
    const wrap = document.getElementById("alerts-map-wrap");
    if (!wrap) return;

    const shapes = await collectAlertShapes(features);

    // Bail out of showing a map at all if we couldn't resolve a single shape — an empty
    // map would just be confusing.
    if (!shapes.length) {
      wrap.innerHTML = `<p class="muted-text">Affected-area map isn't available for this alert type — see the area description above.</p>`;
      return;
    }

    if (typeof L === "undefined") {
      wrap.innerHTML = `<p class="muted-text">Map library failed to load, so the affected area can't be shown here — see the area description above.</p>`;
      return;
    }

    const map = L.map("alerts-map", { scrollWheelZoom: false });
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 12,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors',
    }).addTo(map);

    const layerGroup = L.layerGroup();
    shapes.forEach(({ geometry, color, popupText }) => {
      const layer = L.geoJSON(geometry, {
        style: { color, weight: 2, fillColor: color, fillOpacity: 0.3 },
      });
      layer.bindPopup(popupText);
      layer.addTo(layerGroup);
    });
    layerGroup.addTo(map);

    try {
      map.fitBounds(layerGroup.getBounds(), { padding: [20, 20], maxZoom: 10 });
    } catch (e) {
      map.setView([39.5, -98.35], 4); // fallback: rough US center if bounds are invalid
    }

    // Distinct severities present, for a small legend under the map.
    const severitiesUsed = [...new Set(features.map((f) => (f.properties?.severity || "unknown").toLowerCase()))]
      .filter((s) => SEVERITY_COLORS[s]);
    if (severitiesUsed.length > 1) {
      const legendHtml = `
        <div class="map-legend">
          ${severitiesUsed
            .map((s) => `<span class="legend-item"><span class="swatch" style="background:${SEVERITY_COLORS[s]}"></span>${escapeHtml(s)}</span>`)
            .join("")}
        </div>
      `;
      wrap.insertAdjacentHTML("beforeend", legendHtml);
    }
    wrap.insertAdjacentHTML("beforeend", `<p class="muted-text map-caption">Shaded areas show the affected advisory/warning zones.</p>`);

    alertsMapInstance = map;
  }

  // ---------- Init ----------

  function init() {
    els.useLocationBtn.addEventListener("click", useCurrentLocation);
    els.searchForm.addEventListener("submit", (e) => {
      e.preventDefault();
      const query = els.searchInput.value.trim();
      if (query.length >= 2) runGeocodeSearch(query);
    });
    els.searchInput.addEventListener("input", handleSearchInput);
    document.addEventListener("click", (e) => {
      if (!els.searchResults.contains(e.target) && e.target !== els.searchInput) {
        hideSearchResults();
      }
    });

    // Restore last-used location, if any, without requesting permission again.
    try {
      const saved = localStorage.getItem(STORAGE_KEY_LAST_LOCATION);
      if (saved) {
        const loc = JSON.parse(saved);
        if (loc && typeof loc.lat === "number" && typeof loc.lon === "number") {
          els.currentLocationLabel.textContent = loc.label ? `Showing: ${loc.label} (last used)` : "";
          activeLocation = loc;
          loadAllSections(loc);
        }
      }
    } catch (e) { /* ignore malformed storage */ }
  }

  document.addEventListener("DOMContentLoaded", init);
})();
