export const LISTING_STATUSES = ["À suivre", "Contact pris", "Visite prévue", "Offre en cours", "Clôturée"];

export const BACKUP_VERSION = 2;

// Valeurs neutres : le profil réel vit dans le navigateur ou dans config.local.js (LOCAL_HOME.property).
export const DEFAULT_PROPERTY = {
  energyRating: "D",
  livingArea: 100,
  garageArea: 0,
  landArea: 500,
  rooms: 5,
  purchasePrice: 0,
  purchaseDate: "",
  constructionYear: 1975,
};

export function todayDate() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

export function validDateString(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00`));
}

export function normalizeListing(listing) {
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

export function validateBackup(backup) {
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

export function getListingPriceDrop(listing) {
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

export function matchListing(listing, ranges, dpe) {
  if (listing.kind !== "Maison") return { matches: false, complete: false };
  if (listing.area < ranges.area[0] || listing.area > ranges.area[1]) {
    return { matches: false, complete: false };
  }
  const criteria = [
    { value: listing.rooms, range: ranges.rooms },
    { value: listing.landArea, range: ranges.landArea },
    { value: listing.constructionYear, range: ranges.constructionYear },
  ];
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
