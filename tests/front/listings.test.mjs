import assert from "node:assert/strict";
import test from "node:test";
import {
  BACKUP_VERSION,
  DEFAULT_PROPERTY,
  getListingPriceDrop,
  matchListing,
  normalizeListing,
  validateBackup,
} from "../../src/listings.js";

const listing = (overrides = {}) => ({
  id: "a1",
  title: "Maison test",
  price: 200000,
  area: 100,
  kind: "Maison",
  intent: "À acheter",
  url: "https://example.org/annonce",
  ...overrides,
});

const backup = (overrides = {}) => ({
  app: "Maison & Marché",
  schemaVersion: BACKUP_VERSION,
  location: { label: "Ville", latitude: 45.7, longitude: 3.2, departmentCode: "63", cityCode: "63124" },
  property: { ...DEFAULT_PROPERTY },
  listings: [listing()],
  ...overrides,
});

test("le profil par défaut ne contient ni prix ni date d'achat", () => {
  assert.equal(DEFAULT_PROPERTY.purchasePrice, 0);
  assert.equal(DEFAULT_PROPERTY.purchaseDate, "");
});

test("normalizeListing corrige statut, DPE et historique de prix", () => {
  const normalized = normalizeListing(listing({ status: "inconnu", energyRating: "Z", createdAt: "2026-01-02" }));
  assert.equal(normalized.status, "À suivre");
  assert.equal(normalized.energyRating, null);
  assert.deepEqual(normalized.priceHistory, [{ date: "2026-01-02", price: 200000 }]);
});

test("validateBackup accepte le profil neutre sans prix ni date d'achat", () => {
  const restored = validateBackup(backup());
  assert.equal(restored.listings.length, 1);
  assert.equal(restored.property.purchaseDate, "");
});

test("validateBackup refuse un lien javascript: et une sauvegarde étrangère", () => {
  assert.throws(() => validateBackup(backup({ listings: [listing({ url: "javascript:alert(1)" })] })));
  assert.throws(() => validateBackup(backup({ app: "autre" })));
});

test("matchListing distingue correspondance complète, partielle et hors critères", () => {
  const ranges = { area: [85, 125], rooms: [4, 6], landArea: [300, 1200], constructionYear: [1963, 1983] };
  const full = listing({ rooms: 5, landArea: 600, constructionYear: 1973, energyRating: "D" });
  assert.deepEqual(matchListing(full, ranges, "D"), { matches: true, complete: true });
  assert.deepEqual(matchListing(listing(), ranges, "D"), { matches: true, complete: false });
  assert.equal(matchListing(listing({ area: 60 }), ranges, "all").matches, false);
  assert.equal(matchListing(full, ranges, "A").matches, false);
  assert.equal(matchListing(listing({ kind: "Terrain" }), ranges, "all").matches, false);
});

test("getListingPriceDrop ne signale qu'une baisse", () => {
  const history = (...prices) => ({ priceHistory: prices.map((price, i) => ({ date: `2026-01-0${i + 1}`, price })) });
  assert.deepEqual(getListingPriceDrop(history(200000, 190000)), { amount: 10000, percent: 5 });
  assert.equal(getListingPriceDrop(history(190000, 200000)), null);
  assert.equal(getListingPriceDrop(history(200000)), null);
});
