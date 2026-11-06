import assert from "node:assert/strict";
import test from "node:test";
import { buildAreaSummary, buildMarketSummary, distanceInKm, filterCommunesByRadius } from "../../src/market.js";

const month = (index) => `${2024 + Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}`;

test("buildMarketSummary compare les 12 derniers mois aux 12 précédents", () => {
  const rows = Array.from({ length: 24 }, (_, index) => ({
    d: month(index),
    m: 10,
    m_m: 1000 + index * 10,
  }));
  const summary = buildMarketSummary([{ commune: {}, rows }], "house");
  assert.equal(summary.recent.price, 1175);
  assert.ok(Math.abs(summary.changePercent - ((1175 - 1055) / 1055) * 100) < 1e-9);
  assert.equal(summary.series.length, 24);
});

test("buildMarketSummary renvoie null sans historique suffisant", () => {
  const rows = [{ d: "2025-01", m: 3, m_m: 2000 }];
  assert.equal(buildMarketSummary([{ commune: {}, rows }], "house").changePercent, null);
});

test("buildAreaSummary pondère le prix par le nombre de ventes", () => {
  const communes = [
    { commune: {}, summary: { m: 1, m_m: 1000 } },
    { commune: {}, summary: { m: 3, m_m: 2000 } },
  ];
  assert.equal(buildAreaSummary(communes, "house").recent.price, 1750);
});

test("filterCommunesByRadius garde les communes à 20 km et les trie", () => {
  const home = { latitude: 45.74, longitude: 3.19 };
  const communes = [
    { nom: "Loin", centre: { coordinates: [4.5, 46.5] } },
    { nom: "Près", centre: { coordinates: [3.2, 45.75] } },
    { nom: "Sans centre" },
  ];
  assert.deepEqual(filterCommunesByRadius(communes, home).map((commune) => commune.nom), ["Près"]);
  assert.ok(distanceInKm(home, { latitude: 45.74, longitude: 3.19 }) < 1e-9);
});
