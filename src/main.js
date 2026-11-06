import { buildAreaSummary, buildMarketSummary, filterCommunesByRadius, SEARCH_RADIUS_KM } from "./market.js";

const DVF_API = "https://dvf-api.data.gouv.fr";
const GEO_API = "https://geo.api.gouv.fr";
const ADDRESS_API = "https://api-adresse.data.gouv.fr/search/";
const LOCATION_STORAGE_KEY = "maison-marche-location";
const LISTINGS_STORAGE_KEY = "maison-marche-listings";
const PROPERTY_STORAGE_KEY = "maison-marche-property";
const NEARBY_COMMUNES_CACHE_KEY = "maison-marche-nearby-communes";
const NEARBY_COMMUNES_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const GEOGRAPHY_REQUEST_TIMEOUT_MS = 45000;
const MAX_DPE_LOOKUPS = 10000;
const LISTING_STATUSES = ["À suivre", "Contact pris", "Visite prévue", "Offre en cours", "Clôturée"];
const BACKUP_VERSION = 2;
// Valeurs neutres : le profil réel vit dans le navigateur ou dans config.local.js (LOCAL_HOME.property).
const DEFAULT_PROPERTY = {
  energyRating: "D",
  livingArea: 100,
  garageArea: 0,
  landArea: 500,
  rooms: 5,
  purchasePrice: 0,
  purchaseDate: "",
  constructionYear: 1975,
};
const DEFAULT_HOME = {
  label: "Cournon-d'Auvergne",
  latitude: 45.742,
  longitude: 3.1885,
  departmentCode: "63",
  cityCode: "63124",
};
const DEPARTMENTS_BY_RADIUS = {
  "63": ["63", "03", "15", "19", "23", "42", "43"],
};

const elements = {
  location: document.querySelector("#location-label"),
  updated: document.querySelector("#updated-label"),
  headlinePrice: document.querySelector("#headline-price"),
  headlineChange: document.querySelector("#headline-change"),
  headlineVolume: document.querySelector("#headline-volume"),
  housePrice: document.querySelector("#house-price"),
  houseSales: document.querySelector("#house-sales"),
  apartmentPrice: document.querySelector("#apartment-price"),
  apartmentSales: document.querySelector("#apartment-sales"),
  totalSales: document.querySelector("#total-sales"),
  listingCount: document.querySelector("#listing-count"),
  propertyValue: document.querySelector("#property-value"),
  propertyEstimateDetail: document.querySelector("#property-estimate-detail"),
  purchasePrice: document.querySelector("#purchase-price"),
  purchaseDate: document.querySelector("#purchase-date"),
  purchaseDifference: document.querySelector("#purchase-difference"),
  purchaseDifferencePercent: document.querySelector("#purchase-difference-percent"),
  profileLivingArea: document.querySelector("#profile-living-area"),
  profileRooms: document.querySelector("#profile-rooms"),
  profileLandArea: document.querySelector("#profile-land-area"),
  profileGarageArea: document.querySelector("#profile-garage-area"),
  profileConstructionYear: document.querySelector("#profile-construction-year"),
  profileEnergy: document.querySelector("#profile-energy"),
  propertyType: document.querySelector("#property-type"),
  compareButton: document.querySelector("#compare-button"),
  comparablesStatus: document.querySelector("#comparables-status"),
  comparablesResults: document.querySelector("#comparables-results"),
  comparableEstimate: document.querySelector("#comparable-estimate"),
  annualComparables: document.querySelector("#annual-comparables"),
  annualComparablesBody: document.querySelector("#annual-comparables-body"),
  comparableDpe: document.querySelector("#comparable-dpe"),
  comparableDpeFilter: document.querySelector("#filter-dpe"),
  dashboardTab: document.querySelector("#dashboard-tab"),
  transactionsTab: document.querySelector("#transactions-tab"),
  dashboardView: document.querySelector("#dashboard-view"),
  transactionsView: document.querySelector("#transactions-view"),
  transactionsStatus: document.querySelector("#transactions-status"),
  transactionsTableBody: document.querySelector("#transactions-table-body"),
  transactionsYearFilter: document.querySelector("#transactions-year-filter"),
  transactionsSort: document.querySelector("#transactions-sort"),
  transactionMapCount: document.querySelector("#transaction-map-count"),
  exportTransactionsButton: document.querySelector("#export-transactions-button"),
  exportTransactionsJsonButton: document.querySelector("#export-transactions-json-button"),
  transactionDistanceFilter: document.querySelector("#transaction-distance-filter"),
  refreshTransactionsButton: document.querySelector("#refresh-transactions-button"),
  expandSampleButton: document.querySelector("#expand-sample-button"),
  expandTransactionsButton: document.querySelector("#expand-transactions-button"),
  chart: document.querySelector("#price-chart"),
  chartAxis: document.querySelector("#chart-axis"),
  chartRange: document.querySelector("#chart-range"),
  townCount: document.querySelector("#town-count"),
  townList: document.querySelector("#town-list"),
  mapMessage: document.querySelector("#map-message"),
  listingList: document.querySelector("#listing-list"),
  exportDataButton: document.querySelector("#export-data-button"),
  importDataButton: document.querySelector("#import-data-button"),
  importDataFile: document.querySelector("#import-data-file"),
  backupStatus: document.querySelector("#backup-status"),
  dvfCoverage: document.querySelector("#dvf-coverage"),
  dvfCoverageDetails: document.querySelector("#dvf-coverage-details"),
  snapshotHistory: document.querySelector("#snapshot-history"),
  snapshotPriceChart: document.querySelector("#snapshot-price-chart"),
  snapshotCountChart: document.querySelector("#snapshot-count-chart"),
  snapshotHistoryNote: document.querySelector("#snapshot-history-note"),
  listingMatchSummary: document.querySelector("#listing-match-summary"),
  locationDialog: document.querySelector("#location-dialog"),
  listingDialog: document.querySelector("#listing-dialog"),
  propertyDialog: document.querySelector("#property-dialog"),
};

let home = window.STATIC_DATA_MODE
  ? window.LOCAL_HOME ?? DEFAULT_HOME
  : readSavedLocation() ?? window.LOCAL_HOME ?? DEFAULT_HOME;
let property = {
  ...DEFAULT_PROPERTY,
  ...(readSavedProperty() ?? window.LOCAL_HOME?.property ?? {}),
};
let marketData = [];
let nearbyCommunes = [];
let localTrendRows = [];
let map;
let mapLayers = [];
let listingItems = readSavedListings();
let comparableQueryKey = null;
let dpeLookupLimit = MAX_DPE_LOOKUPS;
let eligibleDpeParcels = 0;
let marketCoverageNotice = "";
let comparableTransactions = null;
let comparableTransactionMetadata = null;
let transactionMap;
let transactionMapMarkers;
let transactionMapHomeMarker;
let editingListingId = null;

document.querySelector("#settings-button").addEventListener("click", () => {
  elements.locationDialog.showModal();
  document.querySelector("#address-input").focus();
});
document.querySelector("#edit-property-button").addEventListener("click", openPropertyDialog);
document.querySelector("#property-type").addEventListener("change", renderDashboard);
elements.compareButton.addEventListener("click", () => loadComparables());
elements.dashboardTab.addEventListener("click", () => setActiveView("dashboard"));
elements.transactionsTab.addEventListener("click", () => setActiveView("transactions"));
document.querySelector('[role="tablist"]').addEventListener("keydown", (event) => {
  const tabs = [elements.dashboardTab, elements.transactionsTab];
  const currentIndex = tabs.indexOf(document.activeElement);
  if (currentIndex === -1) return;

  const nextIndex = {
    ArrowRight: (currentIndex + 1) % tabs.length,
    ArrowLeft: (currentIndex + tabs.length - 1) % tabs.length,
    Home: 0,
    End: tabs.length - 1,
  }[event.key];
  if (nextIndex === undefined) return;
  event.preventDefault();
  tabs[nextIndex].focus();
  tabs[nextIndex].click();
});
elements.refreshTransactionsButton.addEventListener("click", () => loadComparables());
elements.expandSampleButton.addEventListener("click", () => loadComparables({ expandDpeSample: true }));
elements.expandTransactionsButton.addEventListener("click", () => loadComparables({ expandDpeSample: true }));
elements.transactionsYearFilter.addEventListener("change", renderFilteredTransactions);
elements.transactionsSort.addEventListener("change", renderFilteredTransactions);
elements.transactionDistanceFilter.addEventListener("change", renderFilteredTransactions);
elements.exportTransactionsButton.addEventListener("click", exportTransactionsCsv);
elements.exportTransactionsJsonButton.addEventListener("click", exportTransactionsJson);
elements.exportDataButton.addEventListener("click", exportUserData);
elements.importDataButton.addEventListener("click", () => elements.importDataFile.click());
elements.importDataFile.addEventListener("change", importUserData);
document.querySelector("#add-listing-button").addEventListener("click", openListingDialog);
document.querySelector("#add-listing-link").addEventListener("click", openListingDialog);
document.querySelector("#location-form").addEventListener("submit", handleLocationSubmit);
document.querySelector("#property-form").addEventListener("submit", handlePropertySubmit);
document.querySelector("#listing-form").addEventListener("submit", handleListingSubmit);
document.querySelectorAll(".comparable-filters input, .comparable-filters select").forEach((input) => {
  input.addEventListener("input", updateListingAlerts);
  input.addEventListener("change", updateListingAlerts);
});
document.querySelectorAll("[data-close]").forEach((button) => {
  button.addEventListener("click", () => document.getElementById(button.dataset.close).close());
});

elements.location.textContent = home.label;
document.querySelector("#property-living-area").value = property.livingArea;
document.querySelector("#property-rooms").value = property.rooms;
document.querySelector("#property-land-area").value = property.landArea;
document.querySelector("#property-garage-area").value = property.garageArea;
document.querySelector("#property-purchase-price").value = property.purchasePrice;
document.querySelector("#property-purchase-date").value = property.purchaseDate;
document.querySelector("#property-construction-year").value = property.constructionYear;
document.querySelector("#property-energy").value = property.energyRating;
document.querySelector("#property-construction-year").max = String(new Date().getFullYear());
document.querySelector("#listing-construction-year").max = String(new Date().getFullYear());
document.querySelectorAll("#filter-min-construction-year, #filter-max-construction-year").forEach((input) => {
  input.max = String(new Date().getFullYear());
});
renderPropertyProfile();
updateComparableFilterDefaults();
configureStaticComparableFilters();
renderListings();
loadMarketData();
if (window.STATIC_DATA_MODE) loadComparables();
loadSnapshotHistory();
if (window.STATIC_DATA_MODE) {
  document.querySelector("#dpe-context-description").textContent =
    "Cette version publique charge un instantané calculé chaque semaine par GitHub Actions. " +
    "Les critères sont fixes pour ce jeu de données ; les lignes détaillées, identifiants cadastraux et coordonnées DVF publiés sont accessibles à tous. " +
    "Le DPE et l'année de construction sont issus des bâtiments associés aux parcelles et peuvent ne pas correspondre exactement au logement vendu.";
  elements.compareButton.textContent = "Recharger l'instantané";
  const settingsButton = document.querySelector("#settings-button");
  settingsButton.disabled = true;
  settingsButton.title = "La localisation de cet instantané public est fixe.";
}

function optionalFormNumber(value) {
  if (value == null || String(value).trim() === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function readSavedLocation() {
  try {
    const savedLocation = localStorage.getItem(LOCATION_STORAGE_KEY);
    return savedLocation ? JSON.parse(savedLocation) : null;
  } catch (error) {
    console.error("Impossible de lire la localisation enregistrée.", error);
    return null;
  }
}

function readSavedListings() {
  try {
    const savedListings = localStorage.getItem(LISTINGS_STORAGE_KEY);
    const parsedListings = savedListings ? JSON.parse(savedListings) : [];
    return Array.isArray(parsedListings)
      ? parsedListings.filter((listing) => listing && typeof listing === "object").map(normalizeListing)
      : [];
  } catch (error) {
    console.error("Impossible de lire les annonces enregistrées.", error);
    return [];
  }
}

function readSavedProperty() {
  try {
    const savedProperty = localStorage.getItem(PROPERTY_STORAGE_KEY);
    return savedProperty ? { ...DEFAULT_PROPERTY, ...JSON.parse(savedProperty) } : null;
  } catch (error) {
    console.error("Impossible de lire le profil du bien enregistré.", error);
    return null;
  }
}

async function fetchJson(url, timeoutMs = 20000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  const sourceHost = new URL(url, window.location.href).hostname;
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      throw new Error(
        payload?.error ?? `La source ${sourceHost} a répondu ${response.status}.`,
      );
    }
    return await response.json();
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error(`La source ${sourceHost} n'a pas répondu sous ${timeoutMs / 1000} secondes.`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function getNearbyCommunes() {
  const cached = readNearbyCommunesCache();
  const cacheMatchesHome =
    cached &&
    cached.latitude === home.latitude &&
    cached.longitude === home.longitude;
  const cacheIsFresh =
    cacheMatchesHome && Date.now() - cached.savedAt < NEARBY_COMMUNES_CACHE_TTL_MS;
  if (cacheIsFresh) return { communes: cached.communes, missingDepartments: [] };

  const departmentCodes = DEPARTMENTS_BY_RADIUS[home.departmentCode] ?? [home.departmentCode];
  const responses = await Promise.allSettled(
    departmentCodes.map((code) =>
      fetchJson(
        `${GEO_API}/communes?codeDepartement=${encodeURIComponent(code)}&fields=nom,code,centre`,
        GEOGRAPHY_REQUEST_TIMEOUT_MS,
      ),
    ),
  );
  const communes = responses.flatMap((response) =>
    response.status === "fulfilled" ? response.value : [],
  );
  const nearby = filterCommunesByRadius(communes, home, SEARCH_RADIUS_KM);
  const missingDepartments = responses.flatMap((response, index) =>
    response.status === "rejected" ? [departmentCodes[index]] : [],
  );

  if (nearby.length > 0) {
    try {
      localStorage.setItem(
        NEARBY_COMMUNES_CACHE_KEY,
        JSON.stringify({
          latitude: home.latitude,
          longitude: home.longitude,
          savedAt: Date.now(),
          communes: nearby,
        }),
      );
    } catch (error) {
      console.warn("Impossible de mettre en cache les communes proches.", error);
    }
    return { communes: nearby, missingDepartments };
  }

  if (cacheMatchesHome && cached.communes.length > 0) {
    return { communes: cached.communes, missingDepartments: departmentCodes };
  }
  if (responses.every((response) => response.status === "rejected")) {
    throw new Error("Le service géographique est indisponible et aucune commune en cache n'est disponible.");
  }
  if (nearby.length === 0) {
    throw new Error("Aucune commune n'a été trouvée dans le rayon de 20 km.");
  }
  return { communes: nearby, missingDepartments };
}

function readNearbyCommunesCache() {
  try {
    const saved = localStorage.getItem(NEARBY_COMMUNES_CACHE_KEY);
    if (!saved) return null;
    const cache = JSON.parse(saved);
    if (
      !Number.isFinite(cache.latitude) ||
      !Number.isFinite(cache.longitude) ||
      !Number.isFinite(cache.savedAt) ||
      !Array.isArray(cache.communes)
    ) {
      return null;
    }
    return cache;
  } catch (error) {
    console.warn("Impossible de lire le cache des communes proches.", error);
    return null;
  }
}

async function loadMarketData() {
  marketData = [];
  nearbyCommunes = [];
  localTrendRows = [];
  elements.updated.textContent = "Chargement des ventes DVF…";
  elements.townList.innerHTML = '<p class="loading-row">Chargement des données communales…</p>';
  try {
    const geography = await getNearbyCommunes();
    nearbyCommunes = geography.communes;
    const departmentCodes = DEPARTMENTS_BY_RADIUS[home.departmentCode] ?? [home.departmentCode];
    const [departmentResults, trendResult] = await Promise.all([
      Promise.allSettled(
        departmentCodes.map((code) =>
          fetchJson(`${DVF_API}/departement/${encodeURIComponent(code)}/communes`),
        ),
      ),
      fetchJson(`${DVF_API}/commune/${encodeURIComponent(home.cityCode)}`).then(
        (value) => ({ status: "fulfilled", value }),
        (reason) => ({ status: "rejected", reason }),
      ),
    ]);
    const departmentResponses = departmentResults.flatMap((result) =>
      result.status === "fulfilled" ? [result.value] : [],
    );
    const unavailableDvfDepartments = departmentResults.flatMap((result, index) =>
      result.status === "rejected" ? [departmentCodes[index]] : [],
    );
    if (departmentResponses.length === 0) {
      throw new Error("Les données DVF des départements proches sont indisponibles.");
    }
    const summariesByCode = new Map(
      departmentResponses.flatMap((response) => response.data.map((summary) => [summary.c, summary])),
    );
    marketData = nearbyCommunes
      .map((commune) => ({
        commune,
        summary: summariesByCode.get(commune.code),
      }))
      .filter((entry) => entry.summary);
    if (marketData.length === 0) {
      throw new Error("Aucune donnée DVF n'a été trouvée pour les communes de cette zone.");
    }
    localTrendRows = trendResult.status === "fulfilled" ? trendResult.value.data : [];
    const coverageIssues = [
      geography.missingDepartments.length
        ? `géographie des départements ${geography.missingDepartments.join(", ")}`
        : "",
      unavailableDvfDepartments.length
        ? `ventes DVF des départements ${unavailableDvfDepartments.join(", ")}`
        : "",
      trendResult.status === "rejected" ? "historique mensuel de la commune" : "",
    ].filter(Boolean);
    marketCoverageNotice = coverageIssues.length
      ? `Couverture partielle : ${coverageIssues.join(" et ")} indisponible(s).`
      : "";
    elements.townCount.textContent = nearbyCommunes.length.toLocaleString("fr-FR");
    renderDashboard();
    if (marketCoverageNotice) {
      elements.updated.textContent = marketCoverageNotice;
      showMapMessage(marketCoverageNotice);
    }
    if (!window.STATIC_DATA_MODE) loadComparables();
  } catch (error) {
    console.error("Le chargement des données DVF a échoué.", error);
    elements.updated.textContent = "Échec du chargement DVF";
    elements.townList.innerHTML = '<p class="empty-row">Le chargement des données a échoué. Vérifiez la connexion puis réessayez.</p>';
    elements.transactionsStatus.textContent =
      "Les données géographiques DVF n’ont pas pu être chargées ; réessayez avec « Actualiser ».";
    elements.transactionsTableBody.innerHTML =
      '<tr><td colspan="9">Les données DVF sont indisponibles pour le moment.</td></tr>';
    showMapMessage(`Impossible de charger les données du marché : ${error.message}`);
    if (!window.STATIC_DATA_MODE) loadComparables();
  }
}

function renderDashboard() {
  const propertyType = elements.propertyType.value;
  const summary = buildAreaSummary(marketData, propertyType);
  const house = buildAreaSummary(marketData, "house").recent;
  const apartment = buildAreaSummary(marketData, "apartment").recent;
  const trend = buildMarketSummary([{ commune: home, rows: localTrendRows }], propertyType);

  elements.headlinePrice.textContent = formatNumber(summary.recent.price);
  elements.headlineChange.textContent =
    trend.changePercent === null
      ? "Historique insuffisant"
      : `${trend.changePercent > 0 ? "+" : ""}${trend.changePercent.toFixed(1).replace(".", ",")} % sur 12 mois`;
  elements.headlineChange.title = `Évolution mensuelle à ${home.label}`;
  elements.headlineChange.classList.toggle("negative", trend.changePercent !== null && trend.changePercent < 0);
  elements.headlineVolume.textContent = formatNumber(summary.recent.sales);
  elements.housePrice.textContent = formatNumber(house.price);
  elements.houseSales.textContent = formatNumber(house.sales);
  elements.apartmentPrice.textContent = formatNumber(apartment.price);
  elements.apartmentSales.textContent = formatNumber(apartment.sales);
  elements.totalSales.textContent = formatNumber(buildAreaSummary(marketData, "all").recent.sales);
  elements.listingCount.textContent = listingItems.length.toLocaleString("fr-FR");
  renderPropertyProfile(house.price);
  if (trend.lastUpdatedMonth && !marketCoverageNotice) {
    elements.updated.textContent = `Ventes DVF jusqu'en ${formatMonth(trend.lastUpdatedMonth)}`;
  }
  renderPriceChart(trend.series);
  renderTowns(summary.communeSummaries);
  if (nearbyCommunes.length > 0) renderMap();
}

function renderPropertyProfile(localHousePrice = null) {
  elements.profileLivingArea.textContent = formatNumber(property.livingArea);
  elements.profileRooms.textContent = formatNumber(property.rooms);
  elements.profileLandArea.textContent = formatNumber(property.landArea);
  elements.profileGarageArea.textContent = formatNumber(property.garageArea);
  elements.profileConstructionYear.textContent = property.constructionYear
    ? String(property.constructionYear)
    : "—";
  elements.profileEnergy.textContent = property.energyRating;
  elements.comparableDpe.textContent = property.energyRating;
  const hasPurchasePrice = property.purchasePrice > 0;
  elements.purchasePrice.textContent = hasPurchasePrice
    ? `${formatNumber(property.purchasePrice)} €`
    : "Non renseigné";
  elements.purchaseDate.textContent = validDateString(property.purchaseDate)
    ? `Achetée le ${formatDate(property.purchaseDate)}`
    : "Date d'achat non renseignée";

  if (localHousePrice === null) {
    elements.propertyValue.textContent = "—";
    elements.propertyEstimateDetail.textContent = "Prix local indisponible";
    elements.purchaseDifference.textContent = "—";
    elements.purchaseDifferencePercent.textContent = "Repère DVF indisponible";
    elements.purchaseDifference.classList.remove("positive", "negative");
    return;
  }

  const estimatedValue = Math.round(localHousePrice * property.livingArea / 1000) * 1000;
  elements.propertyValue.textContent = `${formatNumber(estimatedValue)} €`;
  elements.propertyEstimateDetail.textContent =
    `${formatNumber(property.livingArea)} m² × ${formatNumber(localHousePrice)} €/m² autour de ${home.label}`;
  if (!hasPurchasePrice) {
    elements.purchaseDifference.textContent = "—";
    elements.purchaseDifferencePercent.textContent = "Prix d'achat non renseigné";
    elements.purchaseDifference.classList.remove("positive", "negative");
    return;
  }
  const difference = estimatedValue - property.purchasePrice;
  const differencePercent = (difference / property.purchasePrice) * 100;
  elements.purchaseDifference.textContent = `${difference > 0 ? "+" : difference < 0 ? "−" : ""}${formatNumber(Math.abs(difference))} €`;
  elements.purchaseDifferencePercent.textContent =
    `${differencePercent > 0 ? "+" : ""}${differencePercent.toFixed(1).replace(".", ",")} % · écart brut indicatif`;
  elements.purchaseDifference.classList.toggle("positive", difference > 0);
  elements.purchaseDifference.classList.toggle("negative", difference < 0);
}

function formatDate(value) {
  const [year, month, day] = value.split("-").map(Number);
  return new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "long", year: "numeric" })
    .format(new Date(year, month - 1, day));
}

function openPropertyDialog() {
  document.querySelector("#property-form").reset();
  document.querySelector("#property-living-area").value = property.livingArea;
  document.querySelector("#property-rooms").value = property.rooms;
  document.querySelector("#property-land-area").value = property.landArea;
  document.querySelector("#property-garage-area").value = property.garageArea;
  document.querySelector("#property-purchase-price").value = property.purchasePrice;
  document.querySelector("#property-purchase-date").value = property.purchaseDate;
  document.querySelector("#property-construction-year").value = property.constructionYear;
  document.querySelector("#property-energy").value = property.energyRating;
  document.querySelector("#property-message").textContent = "";
  elements.propertyDialog.showModal();
}

function updateComparableFilterDefaults() {
  const livingArea = Number(property.livingArea) || DEFAULT_PROPERTY.livingArea;
  const rooms = Number(property.rooms) || DEFAULT_PROPERTY.rooms;
  const landArea = Number(property.landArea) || DEFAULT_PROPERTY.landArea;
  const constructionYear = Number(property.constructionYear) || DEFAULT_PROPERTY.constructionYear;
  document.querySelector("#filter-min-area").value = Math.max(20, Math.round(livingArea - 20));
  document.querySelector("#filter-max-area").value = Math.round(livingArea + 20);
  document.querySelector("#filter-min-rooms").value = Math.max(1, Math.round(rooms - 1));
  document.querySelector("#filter-max-rooms").value = Math.round(rooms + 1);
  document.querySelector("#filter-min-land").value = Math.max(0, Math.round(landArea - 375));
  document.querySelector("#filter-max-land").value = Math.round(landArea + 525);
  document.querySelector("#filter-min-construction-year").value = Math.max(1600, constructionYear - 10);
  document.querySelector("#filter-max-construction-year").value = Math.min(new Date().getFullYear(), constructionYear + 10);
  elements.comparableDpeFilter.value = "ABCDEFG".includes(property.energyRating)
    ? property.energyRating
    : "all";
  configureStaticComparableFilters();
}

function configureStaticComparableFilters(filters = window.STATIC_COMPARABLE_FILTERS) {
  if (!window.STATIC_DATA_MODE || !filters) return;
  const values = {
    "#filter-min-area": filters.minArea,
    "#filter-max-area": filters.maxArea,
    "#filter-min-rooms": filters.minRooms,
    "#filter-max-rooms": filters.maxRooms,
    "#filter-min-land": filters.minLand,
    "#filter-max-land": filters.maxLand,
    "#filter-min-construction-year": filters.minConstructionYear,
    "#filter-max-construction-year": filters.maxConstructionYear,
  };
  for (const [selector, value] of Object.entries(values)) {
    const input = document.querySelector(selector);
    input.value = value;
    input.disabled = true;
  }
  elements.comparableDpeFilter.value = filters.dpe;
  elements.comparableDpeFilter.disabled = true;
}

function handlePropertySubmit(event) {
  event.preventDefault();
  const values = new FormData(event.currentTarget);
  property = {
    energyRating: String(values.get("energyRating")),
    livingArea: Number(values.get("livingArea")),
    garageArea: Number(values.get("garageArea")),
    landArea: Number(values.get("landArea")),
    rooms: Number(values.get("rooms")),
    purchasePrice: Number(values.get("purchasePrice")),
    purchaseDate: String(values.get("purchaseDate")),
    constructionYear: Number(values.get("constructionYear")),
  };
  try {
    localStorage.setItem(PROPERTY_STORAGE_KEY, JSON.stringify(property));
  } catch (error) {
    console.error("Impossible d'enregistrer le profil du bien.", error);
    document.querySelector("#property-message").textContent =
      "Le profil n'a pas pu être enregistré dans le stockage local du navigateur.";
    return;
  }
  updateComparableFilterDefaults();
  renderDashboard();
  elements.propertyDialog.close();
  loadComparables();
}

async function loadComparables({ expandDpeSample = false } = {}) {
  const departmentCodes = nearbyCommunes.length
    ? nearbyCommunes.map((commune) =>
        /^9[78]\d{3}$/.test(commune.code) ? commune.code.slice(0, 3) : commune.code.slice(0, 2),
      )
    : DEPARTMENTS_BY_RADIUS[home.departmentCode] ?? [home.departmentCode];
  const departments = [...new Set(departmentCodes)];
  const coverageNotice =
    nearbyCommunes.length === 0 && !DEPARTMENTS_BY_RADIUS[home.departmentCode]
      ? `Couverture provisoire limitée au département ${home.departmentCode}. `
      : "";
  const params = new URLSearchParams({
    lat: String(home.latitude),
    lon: String(home.longitude),
    radius: String(SEARCH_RADIUS_KM),
    departments: departments.join(","),
    min_area: document.querySelector("#filter-min-area").value,
    max_area: document.querySelector("#filter-max-area").value,
    min_rooms: document.querySelector("#filter-min-rooms").value,
    max_rooms: document.querySelector("#filter-max-rooms").value,
    min_land: document.querySelector("#filter-min-land").value,
    max_land: document.querySelector("#filter-max-land").value,
    min_construction_year: document.querySelector("#filter-min-construction-year").value,
    max_construction_year: document.querySelector("#filter-max-construction-year").value,
    dpe: elements.comparableDpeFilter.value,
  });
  const queryKey = params.toString();
  if (queryKey !== comparableQueryKey) {
    comparableQueryKey = queryKey;
    dpeLookupLimit = MAX_DPE_LOOKUPS;
    eligibleDpeParcels = 0;
    updateExpandSampleButtons(null);
  }
  elements.dvfCoverage.hidden = true;
  elements.dvfCoverageDetails.textContent = "";
  const requestedDpeLookupLimit = expandDpeSample
    ? Math.min(dpeLookupLimit + MAX_DPE_LOOKUPS, eligibleDpeParcels)
    : dpeLookupLimit;
  params.set("dpe_limit", String(requestedDpeLookupLimit));
  elements.compareButton.disabled = true;
  elements.compareButton.textContent = "Analyse DVF en cours…";
  elements.refreshTransactionsButton.disabled = true;
  elements.refreshTransactionsButton.textContent = "Chargement…";
  elements.expandSampleButton.disabled = true;
  elements.expandTransactionsButton.disabled = true;
  const dpeStatus = params.get("dpe") === "all" ? "" : ` et le DPE ${params.get("dpe")}`;
  const constructionStatus =
    `, construction ${params.get("min_construction_year")}–${params.get("max_construction_year")}`;
  if (expandDpeSample) {
    elements.comparablesStatus.textContent =
      `Élargissement de l'échantillon à ${formatNumber(requestedDpeLookupLimit)} parcelles ; ` +
      "les résultats actuels restent affichés pendant la vérification…";
    elements.transactionsStatus.textContent =
      `Vérification des parcelles ${formatNumber(dpeLookupLimit + 1)}–${formatNumber(requestedDpeLookupLimit)}…`;
  } else {
    elements.comparablesStatus.textContent =
      `${coverageNotice}Recherche des maisons de ${params.get("min_area")}–${params.get("max_area")} m², ` +
      `${params.get("min_rooms")}–${params.get("max_rooms")} pièces et ` +
      `${params.get("min_land")}–${params.get("max_land")} m² de terrain` +
      `${constructionStatus}${dpeStatus}` +
      `${params.get("dpe") === "all" ? "…" : ` · vérification jusqu'à ${formatNumber(requestedDpeLookupLimit)} parcelles…`}`;
    elements.comparablesResults.innerHTML = "";
    clearComparableValuation();
    clearTransactionData();
    elements.transactionsStatus.textContent = "Chargement des transactions DVF comparables…";
    elements.transactionsTableBody.innerHTML = '<tr><td colspan="9">Recherche en cours…</td></tr>';
  }

  try {
    const response = await fetchJson(
      window.STATIC_DATA_MODE ? "./data/comparables.json" : `/api/dvf-comparables?${params}`,
      180000,
    );
    if (window.STATIC_DATA_MODE && response.filters) {
      configureStaticComparableFilters({
        minArea: response.filters.livingArea[0],
        maxArea: response.filters.livingArea[1],
        minRooms: response.filters.rooms[0],
        maxRooms: response.filters.rooms[1],
        minLand: response.filters.landArea[0],
        maxLand: response.filters.landArea[1],
        minConstructionYear: response.filters.constructionYear?.[0],
        maxConstructionYear: response.filters.constructionYear?.[1],
        dpe: response.filters.dpe ?? "all",
      });
    }
    const { summary } = response;
    renderDvfCoverage(response);
    dpeLookupLimit = requestedDpeLookupLimit;
    const parcelSample = summary.dpeSample ?? summary.constructionSample;
    eligibleDpeParcels = parcelSample
      ? Math.min(parcelSample.eligibleParcels, parcelSample.maximumLookups)
      : 0;
    updateExpandSampleButtons(parcelSample);
    const sampleLabel =
      parcelSample && parcelSample.eligibleParcels > parcelSample.checkedParcels
        ? ` · ${formatNumber(parcelSample.checkedParcels)} parcelles vérifiées sur ` +
          `${formatNumber(parcelSample.eligibleParcels)} candidates, les plus proches de vos critères` +
          ` (plafond ${formatNumber(parcelSample.maximumLookups)}) · BDNB ${parcelSample.version}`
        : parcelSample
          ? ` · ${formatNumber(parcelSample.checkedParcels)} parcelles vérifiées · BDNB ${parcelSample.version}`
          : "";
    if (summary.suppressed) {
      const suppressedMessage =
        `${coverageNotice}Moins de ${summary.minimumRequired} ventes répondent à ces critères` +
        `${params.get("dpe") === "all" ? "" : ` avec un DPE ${params.get("dpe")}`}` +
        `, construction ${params.get("min_construction_year")}–${params.get("max_construction_year")}` +
        ` ; les résultats détaillés sont masqués${sampleLabel}.`;
      elements.comparablesStatus.textContent = suppressedMessage;
      elements.transactionsStatus.textContent = suppressedMessage;
      elements.transactionsTableBody.innerHTML =
        '<tr><td colspan="9">Aucune ligne affichée : le seuil minimum de ventes comparables n’est pas atteint.</td></tr>';
      clearComparableValuation();
      clearTransactionData();
      return;
    }

    elements.comparablesStatus.textContent =
      `${window.STATIC_DATA_MODE && response.generatedAt ? `Instantané public du ${formatDate(response.generatedAt)} · ` : ""}` +
      `${coverageNotice}${formatNumber(summary.matched)} ventes de maisons comparables` +
      `${params.get("dpe") === "all" ? "" : ` avec un DPE ${params.get("dpe")}`}` +
      ` · construction ${params.get("min_construction_year")}–${params.get("max_construction_year")}` +
      `${sampleLabel} · ${response.firstYear}–${response.lastYear}`;
    elements.comparablesResults.innerHTML = `
      <article class="comparable-result-card primary-result">
        <span>Prix de vente médian</span>
        <strong>${formatNumber(summary.medianPrice)} €</strong>
        <small>fourchette centrale ${formatNumber(summary.priceRange[0])}–${formatNumber(summary.priceRange[1])} €</small>
      </article>
      <article class="comparable-result-card">
        <span>Prix médian au m²</span>
        <strong>${formatNumber(summary.medianPricePerM2)} €/m²</strong>
        <small>prix DVF / surface bâtie</small>
      </article>
      <article class="comparable-result-card">
        <span>Maison médiane vendue</span>
        <strong>${formatNumber(summary.medianLivingArea)} m² · ${formatNumber(summary.medianRooms)} pièces</strong>
        <small>surface habitable et pièces</small>
      </article>
      <article class="comparable-result-card">
        <span>Terrain médian renseigné</span>
        <strong>${formatNumber(summary.medianLandArea)} m²</strong>
        <small>parcelles associées à la mutation</small>
      </article>`;
    renderTransactions(
      summary.transactions,
      parcelSample,
      response.firstYear,
      response.lastYear,
      coverageNotice,
      response.coverage,
    );
    renderComparableValuation(summary.transactions, params.get("dpe"));
    updateListingAlerts();
  } catch (error) {
    console.error("Le chargement des comparables DVF a échoué.", error);
    const errorMessage =
      error.message.includes("404") || error.message.includes("Failed to fetch")
        ? window.STATIC_DATA_MODE
          ? "L'instantané public n'est pas disponible ; vérifiez que le déploiement GitHub Pages a réussi."
          : "Pour charger les ventes détaillées, démarrez l'application avec « python3 server.py »."
        : `Les ventes détaillées n'ont pas pu être chargées : ${error.message}`;
    const requestError = expandDpeSample
      ? `${errorMessage} L'échantillon précédent reste affiché ; réessayez le lot.`
      : errorMessage;
    elements.comparablesStatus.textContent = requestError;
    elements.transactionsStatus.textContent = requestError;
    if (!expandDpeSample) {
      elements.transactionsTableBody.innerHTML =
        '<tr><td colspan="9">Les transactions n’ont pas pu être chargées.</td></tr>';
      clearTransactionData();
      clearComparableValuation();
    }
  } finally {
    elements.compareButton.disabled = false;
    elements.compareButton.textContent = "Actualiser les comparables";
    elements.refreshTransactionsButton.disabled = false;
    elements.refreshTransactionsButton.textContent = "Actualiser";
    elements.expandSampleButton.disabled = false;
    elements.expandTransactionsButton.disabled = false;
  }
}

function updateExpandSampleButtons(dpeSample) {
  const maximumLookups = dpeSample
    ? Math.min(dpeSample.eligibleParcels, dpeSample.maximumLookups)
    : 0;
  const remaining = dpeSample
    ? Math.max(maximumLookups - dpeSample.checkedParcels, 0)
    : 0;
  const constructionFilterActive =
    document.querySelector("#filter-min-construction-year").value !== "" ||
    document.querySelector("#filter-max-construction-year").value !== "";
  const visible =
    (elements.comparableDpeFilter.value !== "all" || constructionFilterActive) &&
    remaining > 0 &&
    !window.STATIC_DATA_MODE;
  const label = `Vérifier les ${formatNumber(Math.min(MAX_DPE_LOOKUPS, remaining))} parcelles suivantes`;
  for (const button of [elements.expandSampleButton, elements.expandTransactionsButton]) {
    button.hidden = !visible;
    button.textContent = label;
    button.disabled = !visible;
  }
}

function setActiveView(view) {
  const showTransactions = view === "transactions";
  elements.dashboardView.hidden = showTransactions;
  elements.transactionsView.hidden = !showTransactions;
  elements.dashboardTab.classList.toggle("active", !showTransactions);
  elements.dashboardTab.setAttribute("aria-selected", String(!showTransactions));
  elements.transactionsTab.classList.toggle("active", showTransactions);
  elements.transactionsTab.setAttribute("aria-selected", String(showTransactions));
  if (showTransactions) {
    window.requestAnimationFrame(() => {
      if (transactionMap) transactionMap.invalidateSize();
      renderFilteredTransactions();
    });
  }
}

function renderTransactions(
  transactions,
  dpeSample,
  firstYear,
  lastYear,
  coverageNotice = "",
  coverage = [],
) {
  comparableTransactions = Array.isArray(transactions) ? transactions : null;
  comparableTransactionMetadata = { dpeSample, firstYear, lastYear, coverageNotice, coverage };
  populateTransactionYears(comparableTransactions ?? []);
  elements.exportTransactionsButton.disabled = !comparableTransactions?.length;
  elements.exportTransactionsJsonButton.disabled = !comparableTransactions?.length;
  if (!Array.isArray(transactions)) {
    elements.transactionsStatus.textContent = elements.comparableDpeFilter.value === "all"
      ? "Choisissez une classe DPE pour afficher les mutations des parcelles vérifiées."
      : "Les transactions détaillées ne sont pas disponibles pour cette sélection.";
    elements.transactionsTableBody.innerHTML =
      '<tr><td colspan="9">Aucune transaction détaillée pour cette sélection.</td></tr>';
    return;
  }

  renderFilteredTransactions();
}

function clearTransactionData() {
  comparableTransactions = null;
  comparableTransactionMetadata = null;
  elements.transactionsYearFilter.innerHTML = '<option value="all">Toutes</option>';
  elements.transactionsSort.value = "date-desc";
  elements.exportTransactionsButton.disabled = true;
  elements.exportTransactionsJsonButton.disabled = true;
}

function populateTransactionYears(transactions) {
  const selectedYear = elements.transactionsYearFilter.value;
  const years = [...new Set(transactions.map((sale) => sale.date?.slice(0, 4)).filter((year) => /^\d{4}$/.test(year)))]
    .sort((a, b) => b.localeCompare(a));
  elements.transactionsYearFilter.innerHTML =
    '<option value="all">Toutes</option>' +
    years.map((year) => `<option value="${year}">${year}</option>`).join("");
  elements.transactionsYearFilter.value = years.includes(selectedYear) ? selectedYear : "all";
}

function getFilteredTransactions() {
  if (!comparableTransactions) return [];
  const selectedYear = elements.transactionsYearFilter.value;
  const [sortKey, direction] = elements.transactionsSort.value.split("-");
  const keyBySort = {
    date: "date",
    price: "price",
    area: "livingArea",
    land: "landArea",
  };
  return comparableTransactions
    .filter((sale) => selectedYear === "all" || sale.date?.startsWith(`${selectedYear}-`))
    .slice()
    .sort((left, right) => {
      const key = keyBySort[sortKey];
      const comparison = key === "date"
        ? String(left[key] ?? "").localeCompare(String(right[key] ?? ""))
        : (Number(left[key]) || 0) - (Number(right[key]) || 0);
      return direction === "asc" ? comparison : -comparison;
    });
}

function renderFilteredTransactions() {
  if (!comparableTransactions || !comparableTransactionMetadata) return;
  const { dpeSample, firstYear, lastYear, coverageNotice, coverage } = comparableTransactionMetadata;
  const transactions = getFilteredTransactions();
  const sampleLabel = dpeSample
    ? ` · ${formatNumber(dpeSample.checkedParcels)} parcelles vérifiées sur ` +
      `${formatNumber(dpeSample.eligibleParcels)} candidates, les plus proches de vos critères` +
      ` (maximum ${formatNumber(dpeSample.maximumLookups)})`
    : "";
  elements.transactionsStatus.textContent =
    `${coverageNotice}${formatNumber(transactions.length)} ventes comparables affichées` +
    `${elements.transactionsYearFilter.value === "all" ? "" : ` en ${elements.transactionsYearFilter.value}`} · DPE ${comparableTransactions[0]?.dpe ?? "—"}` +
    `${sampleLabel} · ${firstYear}–${lastYear}` +
    `${coverage?.length ? ` · départements ${coverage.map((item) => item.department).join(", ")}` : ""}`;
  if (transactions.length === 0) {
    elements.transactionsTableBody.innerHTML =
      '<tr><td colspan="9">Aucune transaction ne correspond aux critères.</td></tr>';
    renderTransactionMap(transactions);
    return;
  }
  elements.transactionsTableBody.innerHTML = transactions.map((sale) => `
    <tr>
      <td>${formatSaleDate(sale.date)}</td>
      <td class="transaction-price">${formatNumber(sale.price)} €</td>
      <td>${formatNumber(sale.livingArea)} m²</td>
      <td>${formatNumber(sale.landArea)} m²</td>
      <td>${formatNumber(sale.rooms)}</td>
      <td>${formatNumber(sale.pricePerM2)} €/m²</td>
      <td><span class="transaction-dpe">${sale.dpe ?? "—"}</span></td>
      <td>${sale.constructionYear ? String(sale.constructionYear) : "Inconnue"}</td>
      <td>${renderParcelLink(sale)}</td>
    </tr>`).join("");
  renderTransactionMap(transactions);
}

function exportTransactionsCsv() {
  const transactions = getFilteredTransactions();
  if (transactions.length === 0) return;
  const rows = [
    ["Date de vente", "Prix DVF (€)", "Surface habitable (m²)", "Terrain (m²)", "Pièces", "Prix au m² (€/m²)", "DPE associé", "Année de construction BDNB", "Parcelle cadastrale", "Latitude DVF", "Longitude DVF"],
    ...transactions.map((sale) => [
      sale.date ?? "",
      sale.price,
      sale.livingArea,
      sale.landArea,
      sale.rooms,
      sale.pricePerM2,
      sale.dpe,
      sale.constructionYear ?? "",
      sale.parcelId ?? "",
      sale.latitude ?? "",
      sale.longitude ?? "",
    ]),
  ];
  const csv = `\uFEFF${rows.map((row) => row.map(csvCell).join(";")).join("\r\n")}`;
  downloadFile(csv, `transactions-comparables-${elements.transactionsYearFilter.value}.csv`, "text/csv;charset=utf-8");
}

function exportTransactionsJson() {
  const transactions = getFilteredTransactions();
  if (!transactions.length || !comparableTransactionMetadata) return;
  const filters = {
    livingArea: [
      Number(document.querySelector("#filter-min-area").value),
      Number(document.querySelector("#filter-max-area").value),
    ],
    rooms: [
      Number(document.querySelector("#filter-min-rooms").value),
      Number(document.querySelector("#filter-max-rooms").value),
    ],
    landArea: [
      Number(document.querySelector("#filter-min-land").value),
      Number(document.querySelector("#filter-max-land").value),
    ],
    constructionYear: [
      Number(document.querySelector("#filter-min-construction-year").value),
      Number(document.querySelector("#filter-max-construction-year").value),
    ],
    dpe: elements.comparableDpeFilter.value,
  };
  downloadFile(
    JSON.stringify({
      source: "DVF géolocalisé · DGFiP/data.gouv.fr",
      exportedAt: new Date().toISOString(),
      selectedYear: elements.transactionsYearFilter.value,
      coverage: comparableTransactionMetadata.coverage,
      firstYear: comparableTransactionMetadata.firstYear,
      lastYear: comparableTransactionMetadata.lastYear,
      filters,
      transactions,
    }, null, 2),
    `transactions-comparables-${elements.transactionsYearFilter.value}.json`,
    "application/json;charset=utf-8",
  );
}

function csvCell(value) {
  const text = String(value ?? "");
  return /[;"\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function renderParcelLink(sale) {
  if (!sale.parcelId) return "Non renseignée";
  const parcelId = escapeHtml(sale.parcelId);
  const reference = escapeHtml(formatParcelReference(sale.parcelId));
  return `<a class="parcel-link" href="${escapeHtml(parcelExplorerUrl(sale))}" target="_blank" rel="noopener noreferrer" title="${parcelId}"><span>${reference}</span><small>${parcelId}</small></a>`;
}

function formatParcelReference(parcelId) {
  const identifier = String(parcelId);
  const match = identifier.match(/^.{8}([A-Z0-9]{2})(\d{4})$/);
  return match
    ? `Section ${match[1]} · parcelle ${Number(match[2])}`
    : identifier;
}

function parcelExplorerUrl(sale) {
  const url = new URL("https://explore.data.gouv.fr/fr/immobilier");
  const parameters = {
    onglet: "carte",
    filtre: "tous",
    level: "parcelle",
    code: sale.parcelId,
    zoom: "16.00",
  };
  if (sale.latitude != null && sale.longitude != null) {
    parameters.lat = sale.latitude;
    parameters.lng = sale.longitude;
  }
  for (const [key, value] of Object.entries(parameters)) url.searchParams.set(key, value);
  return url.toString();
}

function getSaleCoordinates(sale) {
  if (sale.latitude == null || sale.longitude == null) return null;
  const latitude = Number(sale.latitude);
  const longitude = Number(sale.longitude);
  if (
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    latitude < -90 ||
    latitude > 90 ||
    longitude < -180 ||
    longitude > 180
  ) {
    return null;
  }
  return [latitude, longitude];
}

function renderTransactionMap(transactions) {
  if (!window.L) {
    elements.transactionMapCount.textContent = "La carte n’a pas pu être chargée.";
    return;
  }
  if (!transactionMap) {
    transactionMap = window.L.map("transaction-map", {
      zoomControl: false,
      scrollWheelZoom: false,
    }).setView([home.latitude, home.longitude], 12);
    window.L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 18,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(transactionMap);
    window.L.control.zoom({ position: "bottomright" }).addTo(transactionMap);
    transactionMapMarkers = window.L.layerGroup().addTo(transactionMap);
    transactionMapHomeMarker = window.L.circleMarker([home.latitude, home.longitude], {
      radius: 7,
      color: "#fff",
      weight: 2,
      fillColor: "#315c45",
      fillOpacity: 1,
    }).bindTooltip("Centre de la commune").addTo(transactionMap);
  } else {
    transactionMapHomeMarker.setLatLng([home.latitude, home.longitude]);
  }

  transactionMapMarkers.clearLayers();
  const radiusKm = Number(elements.transactionDistanceFilter.value) || 20;
  const mapTransactions = transactions.filter((sale) => {
    const coordinates = getSaleCoordinates(sale);
    return coordinates && distanceInKm(home.latitude, home.longitude, coordinates[0], coordinates[1]) <= radiusKm;
  });
  const locations = new Map();
  for (const sale of mapTransactions) {
    const coordinates = getSaleCoordinates(sale);
    if (!coordinates) continue;
    const [latitude, longitude] = coordinates;
    const key = `${latitude.toFixed(5)},${longitude.toFixed(5)}`;
    if (!locations.has(key)) locations.set(key, { latitude, longitude, sales: [] });
    locations.get(key).sales.push(sale);
  }

  const points = [];
  for (const location of locations.values()) {
    const marker = window.L.circleMarker([location.latitude, location.longitude], {
      radius: 6 + Math.min(Math.sqrt(location.sales.length), 5),
      color: "#fff",
      weight: 1.5,
      fillColor: "#d99155",
      fillOpacity: 0.9,
    }).bindPopup(
      `<div class="transaction-popup"><strong>${location.sales.length} vente${location.sales.length > 1 ? "s" : ""} comparable${location.sales.length > 1 ? "s" : ""}</strong>` +
      location.sales.map((sale) => {
        const details = [
          escapeHtml(formatSaleDate(sale.date)),
          `${formatNumber(sale.price)} €`,
          `${formatNumber(sale.livingArea)} m² habitables`,
          `${formatNumber(sale.rooms)} pièces`,
          `${formatNumber(sale.landArea)} m² de terrain`,
          `${formatNumber(sale.pricePerM2)} €/m²`,
          sale.dpe ? `DPE ${escapeHtml(sale.dpe)}` : "DPE inconnu",
          sale.constructionYear ? `Construction ${sale.constructionYear}` : "Année inconnue",
        ].join(" · ");
        const parcel = sale.parcelId
          ? `<br><span>${escapeHtml(formatParcelReference(sale.parcelId))} · ${escapeHtml(sale.parcelId)}</span> <a href="${escapeHtml(parcelExplorerUrl(sale))}" target="_blank" rel="noopener noreferrer">Ouvrir la parcelle</a>`
          : "";
        return `<p>${details}${parcel}</p>`;
      }).join("") +
      "</div>",
    );
    marker.addTo(transactionMapMarkers);
    points.push([location.latitude, location.longitude]);
  }

  const locatedSales = mapTransactions.length;
  elements.transactionMapCount.textContent = points.length
    ? `${formatNumber(locatedSales)} ventes dans ${radiusKm} km · ${formatNumber(points.length)} points`
    : `Aucune vente géolocalisée dans un rayon de ${radiusKm} km.`;
  if (!elements.transactionsView.hidden) {
    const boundsPoints = [[home.latitude, home.longitude], ...points];
    if (points.length > 0) {
      transactionMap.fitBounds(window.L.latLngBounds(boundsPoints), { padding: [20, 20], maxZoom: 13 });
    } else {
      transactionMap.setView([home.latitude, home.longitude], 12);
    }
  }
}

function distanceInKm(latitude, longitude, otherLatitude, otherLongitude) {
  const radians = (value) => (value * Math.PI) / 180;
  const latDifference = radians(otherLatitude - latitude);
  const lonDifference = radians(otherLongitude - longitude);
  const value =
    Math.sin(latDifference / 2) ** 2 +
    Math.cos(radians(latitude)) *
      Math.cos(radians(otherLatitude)) *
      Math.sin(lonDifference / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
}

function renderComparableValuation(transactions, dpeClass) {
  if (!Array.isArray(transactions) || transactions.length < 5) {
    clearComparableValuation();
    return;
  }
  const estimatedValues = transactions
    .map((sale) => sale.price / sale.livingArea * property.livingArea)
    .filter((value) => Number.isFinite(value) && value > 0);
  if (estimatedValues.length < 5) {
    clearComparableValuation();
    return;
  }
  const median = medianOf(estimatedValues);
  const lower = percentileOf(estimatedValues, 0.25);
  const upper = percentileOf(estimatedValues, 0.75);
  const dpeLabel = dpeClass === "all" ? "toutes classes DPE confondues" : `DPE ${dpeClass}`;
  const purchaseDifference = property.purchasePrice - median;
  const purchaseDifferencePercent = (purchaseDifference / median) * 100;
  const purchasePosition =
    property.purchasePrice < lower
      ? "Votre prix d'achat est inférieur à la fourchette."
      : property.purchasePrice > upper
        ? "Votre prix d'achat est supérieur à la fourchette."
        : "Votre prix d'achat se situe dans la fourchette.";
  const purchaseNote = property.purchasePrice > 0 && validDateString(property.purchaseDate)
    ? `<p class="purchase-range-note">${purchasePosition} Achat du ${escapeHtml(formatDate(property.purchaseDate))} : ${formatNumber(property.purchasePrice)} €, soit ${purchaseDifference > 0 ? "+" : purchaseDifference < 0 ? "−" : ""}${formatNumber(Math.abs(Math.round(purchaseDifference)))} € (${purchaseDifferencePercent > 0 ? "+" : ""}${purchaseDifferencePercent.toFixed(1).replace(".", ",")} %) par rapport à la médiane extrapolée. Indication brute, hors frais d'achat, travaux et évolution propre au logement.</p>`
    : "";
  elements.comparableEstimate.innerHTML = `
    <div>
      <span class="estimate-kicker">FOURCHETTE INDICATIVE PAR COMPARABLES · ${escapeHtml(dpeLabel.toUpperCase())}</span>
      <strong>${formatNumber(Math.round(median / 1000) * 1000)} €</strong>
      <small>médiane estimée pour ${formatNumber(property.livingArea)} m² · ${formatNumber(estimatedValues.length)} ventes</small>
    </div>
    <div class="comparable-estimate-details">
      <p>Fourchette centrale : <strong>${formatNumber(Math.round(lower / 1000) * 1000)}–${formatNumber(Math.round(upper / 1000) * 1000)} €</strong>. Calcul au prorata du prix au m² des ventes filtrées ; les caractéristiques non comparées ne sont pas ajustées.</p>
      ${purchaseNote}
    </div>`;
  elements.comparableEstimate.hidden = false;
  renderAnnualComparables(transactions);
}

function renderDvfCoverage(response) {
  const years = Array.isArray(response.years) ? response.years : [];
  const coverage = Array.isArray(response.coverage) ? response.coverage : [];
  const timestamp = response.generatedAtUtc
    ? new Date(response.generatedAtUtc).toLocaleString("fr-FR")
    : response.generatedAt
      ? formatDate(response.generatedAt)
      : "date inconnue";
  const departmentCoverage = coverage.length
    ? coverage.map(({ department, years: available }) =>
      `${escapeHtml(department)} : ${available?.length ? available.join(", ") : "aucune archive"}`,
    ).join(" · ")
    : "Détail par département indisponible";
  elements.dvfCoverageDetails.textContent =
    `Relevé effectué le ${timestamp} · années effectivement disponibles : ` +
    `${years.length ? years.join(", ") : "inconnues"} · ${departmentCoverage}. ` +
    "La date du relevé n'est pas la date de mise à jour des fichiers DVF par leur source.";
  elements.dvfCoverage.hidden = false;
}

async function loadSnapshotHistory() {
  try {
    const response = await fetch("./data/snapshot-history.json");
    if (!response.ok) {
      if (response.status === 404) return;
      throw new Error(`L'historique des instantanés a répondu ${response.status}.`);
    }
    renderSnapshotHistory(await response.json());
  } catch (error) {
    console.error("L'historique des instantanés n'a pas pu être chargé.", error);
    elements.snapshotHistoryNote.textContent = "L'historique des instantanés est temporairement indisponible.";
    elements.snapshotHistory.hidden = false;
  }
}

function renderSnapshotHistory(history) {
  if (history?.schemaVersion !== 1 || !Array.isArray(history.snapshots)) {
    throw new Error("Le format de l'historique des instantanés est invalide.");
  }
  const allSnapshots = history.snapshots
    .filter((snapshot) => validDateString(snapshot.generatedAt))
    .sort((left, right) => left.generatedAt.localeCompare(right.generatedAt));
  const latest = allSnapshots.at(-1);
  const sameScope = (snapshot) =>
    JSON.stringify(snapshot.filters ?? {}) === JSON.stringify(latest.filters ?? {}) &&
    JSON.stringify(snapshot.scope ?? {}) === JSON.stringify(latest.scope ?? {});
  const snapshots = allSnapshots.filter(sameScope);
  if (!snapshots.length) return;
  renderSnapshotSparkline(elements.snapshotPriceChart, snapshots, "medianPrice", "Prix médian", " €");
  renderSnapshotSparkline(elements.snapshotCountChart, snapshots, "matched", "Ventes comparables", "");
  elements.snapshotHistoryNote.textContent =
    `${snapshots.length} instantané${snapshots.length > 1 ? "s" : ""} conservé${snapshots.length > 1 ? "s" : ""}. ` +
    `${snapshots.length < allSnapshots.length ? `${allSnapshots.length - snapshots.length} ancien(s) instantané(s) avec d'autres critères ou une autre zone non affiché(s). ` : ""}` +
    "L'historique public contient uniquement des indicateurs agrégés, sans coordonnées ni parcelles.";
  elements.snapshotHistory.hidden = false;
}

function renderSnapshotSparkline(container, snapshots, key, label, suffix) {
  const values = snapshots
    .map((snapshot, index) => ({ index, date: snapshot.generatedAt, value: snapshot[key] }))
    .filter((point) => Number.isFinite(point.value));
  if (!values.length) {
    container.innerHTML = '<p class="snapshot-history-note">Aucune donnée disponible.</p>';
    return;
  }
  const width = 480;
  const height = 68;
  const padding = 8;
  const minimum = Math.min(...values.map((point) => point.value));
  const maximum = Math.max(...values.map((point) => point.value));
  const range = Math.max(maximum - minimum, 1);
  const coordinates = values.map((point) => ({
    ...point,
    x: padding + (point.index / Math.max(snapshots.length - 1, 1)) * (width - padding * 2),
    y: height - padding - ((point.value - minimum) / range) * (height - padding * 2),
  }));
  const polyline = coordinates.map((point) => `${point.x},${point.y}`).join(" ");
  const circles = coordinates.map((point) =>
    `<circle class="sparkline-point" cx="${point.x}" cy="${point.y}" r="3"><title>${escapeHtml(formatDate(point.date))} · ${escapeHtml(label)} : ${formatNumber(point.value)}${suffix}</title></circle>`,
  ).join("");
  const firstDate = escapeHtml(formatDate(values[0].date));
  const lastDate = escapeHtml(formatDate(values.at(-1).date));
  container.innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(label)} : de ${formatNumber(minimum)}${suffix} à ${formatNumber(maximum)}${suffix}">
      <polyline class="sparkline" points="${polyline}" />
      ${circles}
      <text class="sparkline-label" x="${padding}" y="${height - 1}">${firstDate}</text>
      <text class="sparkline-label" x="${width - padding}" y="${height - 1}" text-anchor="end">${lastDate} · ${formatNumber(values.at(-1).value)}${suffix}</text>
    </svg>`;
}

function renderAnnualComparables(transactions) {
  const byYear = new Map();
  for (const sale of transactions) {
    const year = sale.date?.slice(0, 4);
    if (!/^\d{4}$/.test(year ?? "")) continue;
    const yearSales = byYear.get(year) ?? [];
    yearSales.push(sale);
    byYear.set(year, yearSales);
  }
  const rows = [...byYear.entries()].sort(([a], [b]) => Number(b) - Number(a));
  elements.annualComparablesBody.innerHTML = rows.map(([year, sales]) => `
    <tr>
      <td>${year}</td>
      <td>${formatNumber(sales.length)}</td>
      <td>${formatNumber(Math.round(medianOf(sales.map((sale) => sale.price))))} €</td>
      <td>${formatNumber(Math.round(medianOf(sales.map((sale) => sale.pricePerM2))))} €/m²</td>
    </tr>`).join("");
  elements.annualComparables.hidden = rows.length === 0;
}

function clearComparableValuation() {
  elements.comparableEstimate.hidden = true;
  elements.comparableEstimate.innerHTML = "";
  elements.annualComparables.hidden = true;
  elements.annualComparablesBody.innerHTML = "";
}

function medianOf(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function percentileOf(values, fraction) {
  const sorted = values.slice().sort((a, b) => a - b);
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function downloadFile(contents, filename, type) {
  const objectUrl = URL.createObjectURL(new Blob([contents], { type }));
  const link = document.createElement("a");
  link.href = objectUrl;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
}

function formatSaleDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value ?? "");
  return match ? `${match[3]}/${match[2]}/${match[1]}` : "—";
}

function formatNumber(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return "—";
  return Number(value).toLocaleString("fr-FR");
}

function formatCurrency(value) {
  return value === null || value === undefined
    ? "Données insuffisantes"
    : `${formatNumber(value)} €/m²`;
}

function renderPriceChart(series) {
  const points = series.filter((point) => point.price !== null);
  if (points.length === 0) {
    elements.chart.innerHTML = '<p class="empty-row">Aucune vente exploitable sur cette période.</p>';
    elements.chartAxis.innerHTML = "";
    elements.chartRange.textContent = "Données en attente";
    return;
  }

  const width = 720;
  const height = 220;
  const padding = { top: 16, right: 12, bottom: 24, left: 8 };
  const values = points.map((point) => point.price);
  const low = Math.min(...values) * 0.96;
  const high = Math.max(...values) * 1.04;
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const coordinates = points.map((point, index) => ({
    x: padding.left + (index / Math.max(points.length - 1, 1)) * plotWidth,
    y: padding.top + ((high - point.price) / Math.max(high - low, 1)) * plotHeight,
    ...point,
  }));
  const path = coordinates.map((point, index) => `${index === 0 ? "M" : "L"}${point.x},${point.y}`).join(" ");
  const areaPath = `${path} L${coordinates.at(-1).x},${height - padding.bottom} L${coordinates[0].x},${height - padding.bottom} Z`;
  const gridLines = [0, 0.5, 1]
    .map((position) => {
      const y = padding.top + position * plotHeight;
      const price = Math.round(high - position * (high - low));
      return `<line x1="${padding.left}" y1="${y}" x2="${width - padding.right}" y2="${y}" class="chart-grid-line" /><text x="${padding.left}" y="${y - 6}" class="chart-y-label">${formatNumber(price)} €</text>`;
    })
    .join("");
  const lastPoint = coordinates.at(-1);
  const axisLabels = [coordinates[0], coordinates[Math.floor((coordinates.length - 1) / 2)], lastPoint]
    .filter((point, index, list) => list.findIndex((other) => other.month === point.month) === index)
    .map((point) => `<span>${formatMonth(point.month)}</span>`)
    .join("");

  elements.chart.innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true">
      ${gridLines}
      <path d="${areaPath}" class="chart-area" />
      <path d="${path}" class="chart-line" />
      <circle cx="${lastPoint.x}" cy="${lastPoint.y}" r="5" class="chart-point" />
    </svg>`;
  elements.chartAxis.innerHTML = axisLabels;
  elements.chartRange.textContent = `${formatMonth(points[0].month)} – ${formatMonth(lastPoint.month)} · ${points.length} mois avec ventes`;
}

function formatMonth(month) {
  const [year, monthNumber] = month.split("-");
  return new Intl.DateTimeFormat("fr-FR", { month: "short", year: "numeric" })
    .format(new Date(Number(year), Number(monthNumber) - 1, 1))
    .replace(".", "");
}

function renderTowns(towns) {
  const visibleTowns = towns
    .filter((town) => town.sales > 0)
    .sort((a, b) => a.commune.distanceKm - b.commune.distanceKm)
    .slice(0, 5);
  if (visibleTowns.length === 0) {
    elements.townList.innerHTML = '<p class="empty-row">Aucune vente récente dans les communes du rayon.</p>';
    return;
  }

  elements.townList.innerHTML = visibleTowns
    .map(
      (town, index) => `
        <div class="town-row">
          <span class="town-rank">${String(index + 1).padStart(2, "0")}</span>
          <div class="town-name">
            <strong>${escapeHtml(town.commune.nom)}</strong>
            <span>${town.commune.distanceKm.toFixed(1).replace(".", ",")} km · ${formatNumber(town.sales)} ventes</span>
          </div>
          <strong class="town-price">${formatCurrency(town.price)}</strong>
        </div>`,
    )
    .join("");
}

function renderMap() {
  if (!window.L) {
    showMapMessage("La carte n'a pas pu être chargée. Les indicateurs restent disponibles.");
    return;
  }
  if (!map) {
    map = window.L.map("map", { zoomControl: false, scrollWheelZoom: false }).setView(
      [home.latitude, home.longitude],
      10,
    );
    window.L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 18,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(map);
    window.L.control.zoom({ position: "bottomright" }).addTo(map);
  }

  map.setView([home.latitude, home.longitude], 10);
  mapLayers.forEach((layer) => layer.remove());
  mapLayers = [];

  const radius = window.L.circle([home.latitude, home.longitude], {
    radius: SEARCH_RADIUS_KM * 1000,
    color: "#3d7661",
    weight: 1.5,
    dashArray: "6 7",
    fillColor: "#7fb69e",
    fillOpacity: 0.1,
  }).addTo(map);
  mapLayers.push(radius);

  const houseMarker = window.L.circleMarker([home.latitude, home.longitude], {
    radius: 7,
    color: "#fff",
    weight: 2,
    fillColor: "#274d3e",
    fillOpacity: 1,
  })
    .bindTooltip("Votre maison")
    .addTo(map);
  mapLayers.push(houseMarker);

  const summary = buildAreaSummary(marketData, elements.propertyType.value);
  for (const town of summary.communeSummaries) {
    const commune = town.commune;
    if (town.price === null) continue;
    const marker = window.L.circleMarker([commune.latitude, commune.longitude], {
      radius: 5 + Math.min(Math.sqrt(town.sales), 5),
      color: "#fff",
      weight: 1.5,
      fillColor: "#d99155",
      fillOpacity: 0.85,
    }).bindPopup(
      `<strong>${escapeHtml(commune.nom)}</strong><br>${formatCurrency(town.price)}<br>${formatNumber(town.sales)} ventes DVF`,
    );
    marker.addTo(map);
    mapLayers.push(marker);
  }
  map.fitBounds(radius.getBounds(), { padding: [12, 12] });
  elements.mapMessage.hidden = true;
}

function showMapMessage(message) {
  elements.mapMessage.textContent = message;
  elements.mapMessage.hidden = false;
}

function openListingDialog() {
  openListingDialogFor();
}

function openListingDialogFor(listingId = null) {
  const form = document.querySelector("#listing-form");
  form.reset();
  document.querySelector("#listing-message").textContent = "";
  editingListingId = listingId;
  const existing = listingId ? readSavedListings().find((listing) => listing.id === listingId) : null;
  const data = existing ?? {};
  document.querySelector("#listing-title").value = data.title ?? "";
  document.querySelector("#listing-price").value = data.price ?? "";
  document.querySelector("#listing-area").value = data.area ?? "";
  document.querySelector("#listing-kind").value = data.kind ?? "Maison";
  document.querySelector("#listing-intent").value = data.intent ?? "À acheter";
  document.querySelector("#listing-status").value = data.status ?? "À suivre";
  document.querySelector("#listing-rooms").value = data.rooms ?? "";
  document.querySelector("#listing-land-area").value = data.landArea ?? "";
  document.querySelector("#listing-construction-year").value = data.constructionYear ?? "";
  document.querySelector("#listing-energy").value = data.energyRating ?? "";
  document.querySelector("#listing-url").value = data.url ?? "";
  form.querySelector("h2").textContent = existing ? "Modifier une annonce" : "Ajouter une annonce";
  form.querySelector('button[type="submit"]').textContent = existing ? "Enregistrer les modifications" : "Enregistrer l'annonce";
  elements.listingDialog.showModal();
}

function renderListings() {
  const listings = readSavedListings();
  listingItems = listings;
  elements.listingCount.textContent = listings.length.toLocaleString("fr-FR");
  const activeMatches = listings.filter((listing) =>
    listing.status !== "Clôturée" && getListingMatch(listing).matches,
  ).length;
  const activePriceDrops = listings.filter((listing) =>
    listing.status !== "Clôturée" && getListingPriceDrop(listing),
  ).length;
  const activeAlerts = activeMatches + activePriceDrops;
  elements.listingMatchSummary.hidden = activeAlerts === 0;
  elements.listingMatchSummary.textContent = activeAlerts
    ? `${activeMatches ? `${activeMatches} annonce${activeMatches > 1 ? "s" : ""} correspond${activeMatches > 1 ? "ent" : ""} aux critères` : ""}` +
      `${activeMatches && activePriceDrops ? " · " : ""}` +
      `${activePriceDrops ? `${activePriceDrops} baisse${activePriceDrops > 1 ? "s" : ""} de prix` : ""} · Saisie et mises à jour manuelles.`
    : "";
  if (listings.length === 0) {
    elements.listingList.innerHTML = `
      <div class="empty-listings">
        <span class="empty-listing-icon" aria-hidden="true">↗</span>
        <p>Votre veille commence ici.</p>
        <span>Ajoutez une annonce repérée autour de chez vous.</span>
      </div>`;
    return;
  }

  elements.listingList.innerHTML = listings
    .map(
      (listing) => {
        const extraDetails = [
          listing.rooms ? `${formatNumber(listing.rooms)} pièces` : "",
          listing.landArea != null ? `${formatNumber(listing.landArea)} m² de terrain` : "",
          listing.constructionYear ? `Construction ${listing.constructionYear}` : "",
          listing.energyRating ? `DPE ${escapeHtml(listing.energyRating)}` : "",
        ].filter(Boolean);
        return `
          <article class="listing-row">
            <div class="listing-indicator ${listing.intent === "À vendre" ? "seller" : ""} ${listing.status === "Clôturée" ? "closed" : ""}"></div>
            <div class="listing-details">
              <a href="${escapeHtml(listing.url)}" target="_blank" rel="noreferrer">${escapeHtml(listing.title)}</a>
              <span>${escapeHtml(listing.kind)} · ${formatNumber(listing.area)} m² · ${escapeHtml(listing.intent)} · mise à jour ${formatDate(listing.updatedAt ?? listing.createdAt ?? todayDate())}</span>
              ${extraDetails.length ? `<span>${extraDetails.join(" · ")}</span>` : ""}
              ${renderListingPriceHistory(listing)}
              ${renderListingAlerts(listing)}
            </div>
            <div class="listing-price">
              <strong>${formatNumber(listing.price)} €</strong>
              <label class="sr-only" for="listing-status-${escapeHtml(listing.id)}">Statut de suivi de ${escapeHtml(listing.title)}</label>
              <select id="listing-status-${escapeHtml(listing.id)}" data-status="${escapeHtml(listing.id)}" aria-label="Statut : ${escapeHtml(listing.title)}">
                ${LISTING_STATUSES.map((status) => `<option value="${escapeHtml(status)}" ${status === (listing.status ?? "À suivre") ? "selected" : ""}>${escapeHtml(status)}</option>`).join("")}
              </select>
              <button type="button" class="edit-listing" data-edit="${escapeHtml(listing.id)}" aria-label="Modifier l'annonce">Modifier</button>
              <button type="button" class="remove-listing" data-remove="${escapeHtml(listing.id)}" aria-label="Supprimer l'annonce">×</button>
            </div>
          </article>`;
      },
    )
    .join("");
  elements.listingList.querySelectorAll("[data-edit]").forEach((button) => {
    button.addEventListener("click", () => openListingDialogFor(button.dataset.edit));
  });
  elements.listingList.querySelectorAll("[data-remove]").forEach((button) => {
    button.addEventListener("click", () => removeListing(button.dataset.remove));
  });
  elements.listingList.querySelectorAll("[data-status]").forEach((select) => {
    select.addEventListener("change", () => updateListingStatus(select.dataset.status, select.value));
  });
}

function getListingPriceDrop(listing) {
  const history = Array.isArray(listing.priceHistory) ? listing.priceHistory : [];
  if (history.length < 2) return null;
  const previous = history.at(-2);
  const latest = history.at(-1);
  if (!Number.isFinite(previous.price) || !Number.isFinite(latest.price) || latest.price >= previous.price) {
    return null;
  }
  return {
    amount: previous.price - latest.price,
    percent: ((previous.price - latest.price) / previous.price) * 100,
  };
}

function getListingMatch(listing) {
  if (listing.kind !== "Maison") return { matches: false, complete: false };
  const ranges = {
    area: [
      Number(document.querySelector("#filter-min-area").value),
      Number(document.querySelector("#filter-max-area").value),
    ],
    rooms: [
      Number(document.querySelector("#filter-min-rooms").value),
      Number(document.querySelector("#filter-max-rooms").value),
    ],
    landArea: [
      Number(document.querySelector("#filter-min-land").value),
      Number(document.querySelector("#filter-max-land").value),
    ],
    constructionYear: [
      Number(document.querySelector("#filter-min-construction-year").value),
      Number(document.querySelector("#filter-max-construction-year").value),
    ],
  };
  if (listing.area < ranges.area[0] || listing.area > ranges.area[1]) {
    return { matches: false, complete: false };
  }
  const criteria = [
    { value: listing.rooms, range: ranges.rooms },
    { value: listing.landArea, range: ranges.landArea },
    { value: listing.constructionYear, range: ranges.constructionYear },
  ];
  const dpe = elements.comparableDpeFilter.value;
  if (dpe !== "all" && listing.energyRating && listing.energyRating !== dpe) {
    return { matches: false, complete: false };
  }
  const complete =
    criteria.every(({ value }) => value != null && Number.isFinite(value)) &&
    (dpe === "all" || Boolean(listing.energyRating));
  const matches = criteria.every(({ value, range }) =>
    value == null || !Number.isFinite(value) || (value >= range[0] && value <= range[1]),
  );
  return { matches, complete };
}

function renderListingAlerts(listing) {
  if (listing.status === "Clôturée") return "";
  const alerts = [];
  const priceDrop = getListingPriceDrop(listing);
  if (priceDrop) {
    alerts.push(
      `<span class="listing-alert price-drop">Baisse de ${formatNumber(priceDrop.amount)} € (${priceDrop.percent.toFixed(1).replace(".", ",")} %)</span>`,
    );
  }
  const match = getListingMatch(listing);
  if (match.matches) {
    alerts.push(
      `<span class="listing-alert">${match.complete ? "Correspond à vos critères" : "Correspondance partielle · détails manquants"}</span>`,
    );
  }
  return alerts.length ? `<div class="listing-alerts">${alerts.join("")}</div>` : "";
}

function updateListingAlerts() {
  if (elements.listingList) renderListings();
}

function renderListingPriceHistory(listing) {
  const history = Array.isArray(listing.priceHistory) ? listing.priceHistory : [];
  if (history.length < 2) return "";
  const entries = history
    .map((item) => `${formatNumber(item.price)} € (${formatDate(item.date)})`)
    .join(" → ");
  return `<span class="listing-price-history">Historique : ${entries}</span>`;
}

function handleListingSubmit(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const data = new FormData(form);
  const message = document.querySelector("#listing-message");
  const url = String(data.get("url")).trim();
  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch {
    message.textContent = "Saisissez un lien d'annonce valide.";
    return;
  }
  if (parsedUrl.protocol !== "https:" && parsedUrl.protocol !== "http:") {
    message.textContent = "Le lien doit commencer par http:// ou https://.";
    return;
  }

  const existingListings = readSavedListings();
  const oldListing = editingListingId
    ? existingListings.find((item) => item.id === editingListingId)
    : null;
  const today = todayDate();
  const price = Number(data.get("price"));
  const priceHistory = Array.isArray(oldListing?.priceHistory) && oldListing.priceHistory.length
    ? oldListing.priceHistory.slice(-49)
    : [{ date: oldListing?.createdAt ?? today, price: oldListing?.price ?? price }];
  if (oldListing && oldListing.price !== price) {
    priceHistory.push({ date: today, price });
  }
  const listing = {
    ...(oldListing ?? {}),
    id: oldListing?.id ?? crypto.randomUUID(),
    title: String(data.get("title")).trim(),
    price,
    area: Number(data.get("area")),
    kind: String(data.get("kind")),
    intent: String(data.get("intent")),
    status: String(data.get("status")),
    rooms: optionalFormNumber(data.get("rooms")),
    landArea: optionalFormNumber(data.get("landArea")),
    constructionYear: optionalFormNumber(data.get("constructionYear")),
    energyRating: String(data.get("energyRating") ?? "") || null,
    url: parsedUrl.toString(),
    createdAt: oldListing?.createdAt ?? today,
    updatedAt: today,
    priceHistory,
  };
  listingItems = oldListing
    ? existingListings.map((item) => item.id === oldListing.id ? listing : item)
    : [listing, ...existingListings];
  if (!saveListings()) return;
  renderListings();
  editingListingId = null;
  elements.listingDialog.close();
}

function updateListingStatus(id, status) {
  if (!LISTING_STATUSES.includes(status)) return;
  listingItems = readSavedListings().map((listing) =>
    listing.id === id ? { ...listing, status, updatedAt: todayDate() } : listing,
  );
  if (saveListings()) renderListings();
}

function removeListing(id) {
  listingItems = readSavedListings().filter((listing) => listing.id !== id);
  if (saveListings()) renderListings();
}

function saveListings() {
  try {
    localStorage.setItem(LISTINGS_STORAGE_KEY, JSON.stringify(listingItems));
    return true;
  } catch (error) {
    console.error("Impossible d'enregistrer l'annonce dans ce navigateur.", error);
    window.alert("L'annonce n'a pas pu être enregistrée dans le stockage local du navigateur.");
    return false;
  }
}

function normalizeListing(listing) {
  const createdAt = validDateString(listing.createdAt) ? listing.createdAt : todayDate();
  const priceHistory = Array.isArray(listing.priceHistory)
    ? listing.priceHistory.filter((item) =>
      item && validDateString(item.date) && Number.isFinite(item.price) && item.price > 0,
    )
    : [];
  if (priceHistory.length === 0 && Number.isFinite(listing.price) && listing.price > 0) {
    priceHistory.push({ date: createdAt, price: listing.price });
  }
  return {
    ...listing,
    rooms: Number.isFinite(listing.rooms) ? listing.rooms : null,
    landArea: Number.isFinite(listing.landArea) ? listing.landArea : null,
    constructionYear: Number.isFinite(listing.constructionYear) ? listing.constructionYear : null,
    energyRating: [..."ABCDEFG"].includes(listing.energyRating) ? listing.energyRating : null,
    status: LISTING_STATUSES.includes(listing.status) ? listing.status : "À suivre",
    createdAt,
    updatedAt: validDateString(listing.updatedAt) ? listing.updatedAt : createdAt,
    priceHistory,
  };
}

function todayDate() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function validDateString(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00`));
}

function exportUserData() {
  const backup = {
    app: "Maison & Marché",
    schemaVersion: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    location: {
      label: home.label,
      latitude: home.latitude,
      longitude: home.longitude,
      departmentCode: home.departmentCode,
      cityCode: home.cityCode,
    },
    property,
    listings: readSavedListings(),
  };
  downloadFile(
    JSON.stringify(backup, null, 2),
    `maison-marche-sauvegarde-${todayDate()}.json`,
    "application/json;charset=utf-8",
  );
  elements.backupStatus.textContent = "Sauvegarde téléchargée. Conservez ce fichier en lieu sûr.";
}

async function importUserData(event) {
  const file = event.currentTarget.files?.[0];
  event.currentTarget.value = "";
  if (!file) return;
  try {
    if (file.size > 5 * 1024 * 1024) {
      throw new Error("Le fichier dépasse la taille maximale de 5 Mo.");
    }
    const backup = JSON.parse(await file.text());
    const imported = validateBackup(backup);
    if (!window.confirm("Cette restauration remplacera la localisation, le profil et toutes les annonces enregistrées dans ce navigateur. Continuer ?")) {
      return;
    }
    const entries = [
      [LOCATION_STORAGE_KEY, JSON.stringify(imported.location)],
      [PROPERTY_STORAGE_KEY, JSON.stringify(imported.property)],
      [LISTINGS_STORAGE_KEY, JSON.stringify(imported.listings)],
    ];
    const previousValues = entries.map(([key]) => localStorage.getItem(key));
    try {
      entries.forEach(([key, value]) => localStorage.setItem(key, value));
    } catch (error) {
      entries.forEach(([key], index) => {
        if (previousValues[index] === null) localStorage.removeItem(key);
        else localStorage.setItem(key, previousValues[index]);
      });
      throw error;
    }
    home = imported.location;
    property = imported.property;
    listingItems = imported.listings;
    elements.location.textContent = home.label;
    document.querySelector("#property-living-area").value = property.livingArea;
    document.querySelector("#property-rooms").value = property.rooms;
    document.querySelector("#property-land-area").value = property.landArea;
    document.querySelector("#property-garage-area").value = property.garageArea;
    document.querySelector("#property-purchase-price").value = property.purchasePrice;
    document.querySelector("#property-purchase-date").value = property.purchaseDate;
    document.querySelector("#property-construction-year").value = property.constructionYear;
    document.querySelector("#property-energy").value = property.energyRating;
    updateComparableFilterDefaults();
    clearComparableValuation();
    renderPropertyProfile();
    renderListings();
    elements.backupStatus.textContent = "Sauvegarde restaurée.";
    await loadMarketData();
  } catch (error) {
    console.error("La sauvegarde n'a pas pu être restaurée.", error);
    elements.backupStatus.textContent = `Restauration impossible : ${error.message}`;
  }
}

function validateBackup(backup) {
  if (
    !backup ||
    backup.app !== "Maison & Marché" ||
    ![1, BACKUP_VERSION].includes(backup.schemaVersion) ||
    !Array.isArray(backup.listings)
  ) {
    throw new Error("Ce fichier n'est pas une sauvegarde Maison & Marché reconnue.");
  }
  const location = backup.location;
  if (
    !location ||
    typeof location.label !== "string" ||
    !location.label.trim() ||
    !Number.isFinite(location.latitude) ||
    !Number.isFinite(location.longitude) ||
    location.latitude < -90 ||
    location.latitude > 90 ||
    location.longitude < -180 ||
    location.longitude > 180 ||
    !/^(?:\d{2,3}|2[AB])$/.test(location.departmentCode ?? "") ||
    !/^[0-9A-Z]{5,6}$/.test(location.cityCode ?? "")
  ) {
    throw new Error("Les coordonnées de localisation de cette sauvegarde sont invalides.");
  }
  const backupProperty = backup.property
    ? { ...DEFAULT_PROPERTY, ...backup.property }
    : null;
  if (
    !backupProperty ||
    !Number.isFinite(backupProperty.livingArea) ||
    backupProperty.livingArea <= 0 ||
    !Number.isFinite(backupProperty.garageArea) ||
    backupProperty.garageArea < 0 ||
    !Number.isFinite(backupProperty.landArea) ||
    backupProperty.landArea < 0 ||
    !Number.isFinite(backupProperty.rooms) ||
    backupProperty.rooms < 1 ||
    !Number.isInteger(backupProperty.constructionYear) ||
    backupProperty.constructionYear < 1600 ||
    backupProperty.constructionYear > new Date().getFullYear() ||
    !Number.isFinite(backupProperty.purchasePrice) ||
    backupProperty.purchasePrice < 0 ||
    (backupProperty.purchaseDate !== "" && !validDateString(backupProperty.purchaseDate)) ||
    ![..."ABCDEFG", "Inconnu"].includes(backupProperty.energyRating)
  ) {
    throw new Error("Le profil immobilier de cette sauvegarde est invalide.");
  }
  if (backup.listings.length > 1000) {
    throw new Error("La sauvegarde contient trop d'annonces.");
  }
  const listings = backup.listings.map((listing) => {
    if (!listing || typeof listing !== "object" || Array.isArray(listing)) {
      throw new Error("Une annonce de cette sauvegarde est invalide.");
    }
    const normalized = normalizeListing(listing);
    let url;
    try {
      url = new URL(normalized.url);
    } catch {
      throw new Error("Une annonce contient un lien invalide.");
    }
    if (
      typeof normalized.title !== "string" ||
      !normalized.title.trim() ||
      !Number.isFinite(normalized.price) ||
      normalized.price <= 0 ||
      !Number.isFinite(normalized.area) ||
      normalized.area <= 0 ||
      !["Maison", "Appartement", "Terrain"].includes(normalized.kind) ||
      !["À acheter", "À vendre"].includes(normalized.intent) ||
      (url.protocol !== "https:" && url.protocol !== "http:") ||
      typeof normalized.id !== "string" ||
      !normalized.id ||
      (listing.rooms != null && (!Number.isFinite(listing.rooms) || listing.rooms < 1)) ||
      (listing.landArea != null && (!Number.isFinite(listing.landArea) || listing.landArea < 0)) ||
      (listing.constructionYear != null && (
        !Number.isInteger(listing.constructionYear) ||
        listing.constructionYear < 1600 ||
        listing.constructionYear > new Date().getFullYear()
      ))
    ) {
      throw new Error("Une annonce de cette sauvegarde contient des informations invalides.");
    }
    return normalized;
  });
  return {
    location: {
      label: location.label.trim(),
      latitude: location.latitude,
      longitude: location.longitude,
      departmentCode: location.departmentCode,
      cityCode: location.cityCode,
    },
    property: backupProperty,
    listings,
  };
}

async function handleLocationSubmit(event) {
  event.preventDefault();
  const address = document.querySelector("#address-input").value.trim();
  const message = document.querySelector("#location-message");
  const submitButton = event.currentTarget.querySelector('button[type="submit"]');
  submitButton.disabled = true;
  message.textContent = "Recherche de l'adresse…";
  try {
    const url = new URL(ADDRESS_API);
    url.searchParams.set("q", address);
    url.searchParams.set("limit", "1");
    const response = await fetchJson(url.toString());
    const feature = response.features?.[0];
    if (!feature) {
      message.textContent = "Aucun résultat trouvé. Vérifiez l'adresse et réessayez.";
      return;
    }
    const [longitude, latitude] = feature.geometry.coordinates;
    const location = {
      label: feature.properties.city,
      latitude,
      longitude,
      departmentCode: feature.properties.depcode,
      cityCode: feature.properties.citycode,
    };
    localStorage.setItem(LOCATION_STORAGE_KEY, JSON.stringify(location));
    home = location;
    elements.location.textContent = location.label;
    elements.locationDialog.close();
    await loadMarketData();
  } catch (error) {
    console.error("La localisation n'a pas pu être mise à jour.", error);
    message.textContent = "La recherche a échoué. Vérifiez votre connexion et réessayez.";
  } finally {
    submitButton.disabled = false;
  }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => {
    const entities = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
    return entities[character];
  });
}
