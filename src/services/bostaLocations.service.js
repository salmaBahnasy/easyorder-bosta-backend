const axios = require("axios");
const supabase = require("../config/supabase");
const { bosta } = require("../config/env");

const BOSTA_CITIES_TABLE =
  process.env.SUPABASE_BOSTA_CITIES_TABLE || "bosta_cities";
const BOSTA_DISTRICTS_TABLE =
  process.env.SUPABASE_BOSTA_DISTRICTS_TABLE || "bosta_districts";

const BOSTA_LOCATIONS_SETUP_HINT =
  "Run supabase/bosta_locations_schema.sql in Supabase SQL editor, then POST /api/bosta/locations/sync (or /api/easyorder/bosta/locations/sync).";

function isMissingBostaLocationsTableError(message) {
  const m = String(message || "");
  return (
    m.includes("bosta_cities") ||
    m.includes("bosta_districts") ||
    m.includes("schema cache")
  );
}

function enrichBostaDbError(error) {
  if (!error?.message || !isMissingBostaLocationsTableError(error.message)) {
    return error;
  }
  const err = new Error(error.message);
  err.code = "BOSTA_LOCATIONS_NOT_CONFIGURED";
  err.setupHint = BOSTA_LOCATIONS_SETUP_HINT;
  return err;
}

function getBostaV2BaseUrl() {
  const base = (bosta.baseUrl || "https://app.bosta.co/api").replace(/\/$/, "");
  return base.endsWith("/v2") ? base : `${base}/v2`;
}

/** Cities/districts v2 endpoints are public — Authorization only if BOSTA_API_KEY is set. */
function bostaHeaders() {
  const headers = { Accept: "application/json" };
  const key = (bosta.apiKey || "").trim();
  if (key) {
    headers.Authorization = key;
  }
  return headers;
}

async function fetchCitiesFromBostaApi() {
  const url = `${getBostaV2BaseUrl()}/cities`;
  const response = await axios.get(url, {
    headers: bostaHeaders(),
    timeout: 60000,
    validateStatus: () => true,
  });
  if (response.status >= 400) {
    const err = new Error(
      response.data?.message || `Bosta cities API returned ${response.status}`,
    );
    err.code = "BOSTA_HTTP_ERROR";
    err.status = response.status;
    err.details = response.data;
    throw err;
  }
  return response.data;
}

async function fetchDistrictsFromBostaApi(cityId) {
  const id = String(cityId || "").trim();
  if (!id) {
    const err = new Error("cityId is required");
    err.code = "INVALID_CITY_ID";
    throw err;
  }
  const url = `${getBostaV2BaseUrl()}/cities/${encodeURIComponent(id)}/districts`;
  const response = await axios.get(url, {
    headers: bostaHeaders(),
    timeout: 60000,
    validateStatus: () => true,
  });
  if (response.status >= 400) {
    const err = new Error(
      response.data?.message ||
        `Bosta districts API returned ${response.status}`,
    );
    err.code = "BOSTA_HTTP_ERROR";
    err.status = response.status;
    err.details = response.data;
    throw err;
  }
  return response.data;
}

function normalizeBostaCitiesList(apiBody) {
  if (!apiBody) return [];
  if (Array.isArray(apiBody)) return apiBody;
  if (Array.isArray(apiBody.data?.list)) return apiBody.data.list;
  if (Array.isArray(apiBody.list)) return apiBody.list;
  if (Array.isArray(apiBody.data)) return apiBody.data;
  return [];
}

function normalizeBostaDistrictsList(apiBody) {
  if (!apiBody) return [];
  if (Array.isArray(apiBody)) return apiBody;
  if (Array.isArray(apiBody.data)) return apiBody.data;
  return [];
}

function mapBostaCityToRow(item) {
  const id = item?._id != null ? String(item._id).trim() : "";
  if (!id) return null;
  return {
    id,
    name: item.name ?? null,
    name_ar: item.nameAr ?? item.name_ar ?? null,
    code: item.code ?? null,
    alias: item.alias ?? null,
    hub_id: item.hub?._id ?? item.hub_id ?? null,
    hub_name: item.hub?.name ?? item.hub_name ?? null,
    sector: item.sector ?? null,
    pickup_availability: item.pickupAvailability ?? true,
    drop_off_availability: item.dropOffAvailability ?? true,
    show_as_drop_off: item.showAsDropOff ?? true,
    show_as_pickup: item.showAsPickup ?? true,
    raw_data: item,
    synced_at: new Date().toISOString(),
  };
}

function mapBostaDistrictToRow(cityId, item) {
  const id =
    item?.districtId != null
      ? String(item.districtId).trim()
      : item?.district_id != null
        ? String(item.district_id).trim()
        : "";
  if (!id) return null;
  return {
    id,
    city_id: String(cityId).trim(),
    zone_id: item.zoneId ?? item.zone_id ?? null,
    zone_name: item.zoneName ?? item.zone_name ?? null,
    zone_other_name: item.zoneOtherName ?? item.zone_other_name ?? null,
    district_name: item.districtName ?? item.district_name ?? null,
    district_other_name:
      item.districtOtherName ?? item.district_other_name ?? null,
    pickup_availability: item.pickupAvailability ?? true,
    drop_off_availability: item.dropOffAvailability ?? true,
    raw_data: item,
    synced_at: new Date().toISOString(),
  };
}

function mapCityRowToBostaShape(row) {
  if (!row) return null;
  const raw =
    row.raw_data && typeof row.raw_data === "object" ? row.raw_data : {};
  return {
    _id: row.id,
    name: row.name ?? raw.name,
    nameAr: row.name_ar ?? raw.nameAr,
    code: row.code ?? raw.code,
    alias: row.alias ?? raw.alias,
    hub:
      row.hub_id || row.hub_name
        ? {
            _id: row.hub_id ?? raw.hub?._id,
            name: row.hub_name ?? raw.hub?.name,
          }
        : raw.hub ?? undefined,
    sector: row.sector ?? raw.sector,
    pickupAvailability:
      row.pickup_availability ?? raw.pickupAvailability ?? true,
    dropOffAvailability:
      row.drop_off_availability ?? raw.dropOffAvailability ?? true,
    showAsDropOff: row.show_as_drop_off ?? raw.showAsDropOff ?? true,
    showAsPickup: row.show_as_pickup ?? raw.showAsPickup ?? true,
  };
}

function parseLocationSearch(search) {
  if (search == null) return null;
  const raw = Array.isArray(search) ? search[0] : search;
  const s = String(raw).trim().slice(0, 120);
  if (!s) return null;
  return s.replace(/[%_\\,(){}]/g, "");
}

function applyLocationNameSearch(query, columns, term) {
  const needle = parseLocationSearch(term);
  if (!needle) return query;
  const pattern = `%${needle}%`;
  const orClause = columns.map((col) => `${col}.ilike.${pattern}`).join(",");
  return query.or(orClause);
}

function mapDistrictRowToBostaShape(row) {
  if (!row) return null;
  const raw =
    row.raw_data && typeof row.raw_data === "object" ? row.raw_data : {};
  return {
    zoneId: row.zone_id ?? raw.zoneId,
    zoneName: row.zone_name ?? raw.zoneName,
    zoneOtherName: row.zone_other_name ?? raw.zoneOtherName,
    districtId: row.id ?? raw.districtId,
    districtName: row.district_name ?? raw.districtName,
    districtOtherName: row.district_other_name ?? raw.districtOtherName,
    pickupAvailability:
      row.pickup_availability ?? raw.pickupAvailability ?? true,
    dropOffAvailability:
      row.drop_off_availability ?? raw.dropOffAvailability ?? true,
  };
}

async function syncBostaLocationsFromApi() {
  const citiesPayload = await fetchCitiesFromBostaApi();
  const cityItems = normalizeBostaCitiesList(citiesPayload);

  const cityRows = cityItems.map(mapBostaCityToRow).filter(Boolean);
  if (!cityRows.length) {
    return {
      citiesSynced: 0,
      districtsSynced: 0,
      citiesSkipped: cityItems.length,
      districtErrors: [],
    };
  }

  const { error: cityErr } = await supabase
    .from(BOSTA_CITIES_TABLE)
    .upsert(cityRows, { onConflict: "id" });
  if (cityErr) {
    throw enrichBostaDbError(cityErr);
  }

  let districtsSynced = 0;
  const districtErrors = [];

  for (const city of cityRows) {
    try {
      const distPayload = await fetchDistrictsFromBostaApi(city.id);
      const distItems = normalizeBostaDistrictsList(distPayload);
      const distRows = distItems
        .map((d) => mapBostaDistrictToRow(city.id, d))
        .filter(Boolean);

      if (!distRows.length) continue;

      const { error: distErr } = await supabase
        .from(BOSTA_DISTRICTS_TABLE)
        .upsert(distRows, { onConflict: "id" });
      if (distErr) {
        districtErrors.push({ cityId: city.id, error: distErr.message });
        continue;
      }
      districtsSynced += distRows.length;
    } catch (e) {
      districtErrors.push({
        cityId: city.id,
        error: e.message || String(e),
      });
    }
  }

  return {
    citiesSynced: cityRows.length,
    districtsSynced,
    citiesSkipped: cityItems.length - cityRows.length,
    districtErrors,
  };
}

async function getCitiesFromDb({ search } = {}) {
  const searchTerm = parseLocationSearch(search);

  let query = supabase
    .from(BOSTA_CITIES_TABLE)
    .select("*")
    .order("name_ar", { ascending: true, nullsFirst: false });

  query = applyLocationNameSearch(query, ["name", "name_ar", "alias", "code"], search);

  const { data, error } = await query;

  if (error) {
    throw enrichBostaDbError(error);
  }

  const list = (data || []).map(mapCityRowToBostaShape).filter(Boolean);
  return {
    success: true,
    message: "Done successfully.",
    data: { list },
    ...(searchTerm ? { search: { q: searchTerm, count: list.length } } : {}),
  };
}

async function getDistrictsFromDb(cityId, { search } = {}) {
  const id = String(cityId || "").trim();
  if (!id) {
    const err = new Error("cityId is required");
    err.code = "INVALID_CITY_ID";
    throw err;
  }

  const searchTerm = parseLocationSearch(search);

  let query = supabase
    .from(BOSTA_DISTRICTS_TABLE)
    .select("*")
    .eq("city_id", id)
    .order("district_other_name", { ascending: true, nullsFirst: false });

  query = applyLocationNameSearch(
    query,
    [
      "district_name",
      "district_other_name",
      "zone_name",
      "zone_other_name",
    ],
    search,
  );

  const { data, error } = await query;

  if (error) {
    throw enrichBostaDbError(error);
  }

  const districts = (data || []).map(mapDistrictRowToBostaShape).filter(Boolean);
  return {
    success: true,
    message: "Done successfully.",
    data: districts,
    ...(searchTerm ? { search: { q: searchTerm, count: districts.length } } : {}),
  };
}

module.exports = {
  fetchCitiesFromBostaApi,
  fetchDistrictsFromBostaApi,
  syncBostaLocationsFromApi,
  getCitiesFromDb,
  getDistrictsFromDb,
};
