export const SEARCH_RADIUS_KM = 20;

const EARTH_RADIUS_KM = 6371;

export function distanceInKm(pointA, pointB) {
  const radians = (degrees) => (degrees * Math.PI) / 180;
  const latitudeDifference = radians(pointB.latitude - pointA.latitude);
  const longitudeDifference = radians(pointB.longitude - pointA.longitude);
  const latitudeA = radians(pointA.latitude);
  const latitudeB = radians(pointB.latitude);
  const haversine =
    Math.sin(latitudeDifference / 2) ** 2 +
    Math.cos(latitudeA) *
      Math.cos(latitudeB) *
      Math.sin(longitudeDifference / 2) ** 2;

  return 2 * EARTH_RADIUS_KM * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine));
}

export function filterCommunesByRadius(communes, home, radiusKm = SEARCH_RADIUS_KM) {
  return communes
    .filter((commune) => commune.centre?.coordinates?.length === 2)
    .map((commune) => {
      const [longitude, latitude] = commune.centre.coordinates;
      return {
        ...commune,
        latitude,
        longitude,
        distanceKm: distanceInKm(home, { latitude, longitude }),
      };
    })
    .filter((commune) => commune.distanceKm <= radiusKm)
    .sort((a, b) => a.distanceKm - b.distanceKm);
}

function getPropertyValues(row, propertyType) {
  if (propertyType === "house") {
    return { count: Number(row.m) || 0, price: Number(row.m_m) || null };
  }
  if (propertyType === "apartment") {
    return { count: Number(row.a) || 0, price: Number(row.m_a) || null };
  }
  return { count: Number(row.am) || 0, price: Number(row.m_am) || null };
}

function summarizeRows(rows, propertyType) {
  let sales = 0;
  let pricedSales = 0;
  let weightedPrice = 0;

  for (const row of rows) {
    const { count, price } = getPropertyValues(row, propertyType);
    if (count === 0) continue;
    sales += count;
    if (price === null) continue;
    pricedSales += count;
    weightedPrice += count * price;
  }

  return {
    sales,
    price: pricedSales > 0 ? Math.round(weightedPrice / pricedSales) : null,
  };
}

export function buildMarketSummary(communeData, propertyType = "all") {
  const rowsByMonth = new Map();
  const communes = [];

  for (const { commune, rows } of communeData) {
    const monthlyRows = rows.filter((row) => row.d).sort((a, b) => a.d.localeCompare(b.d));
    communes.push({ commune, rows: monthlyRows });
    for (const row of monthlyRows) {
      const monthlyCommunes = rowsByMonth.get(row.d) ?? [];
      monthlyCommunes.push(row);
      rowsByMonth.set(row.d, monthlyCommunes);
    }
  }

  const months = [...rowsByMonth.keys()].sort();
  const series = months.map((month) => ({
    month,
    ...summarizeRows(rowsByMonth.get(month), propertyType),
  }));
  const recentMonths = new Set(months.slice(-12));
  const priorMonths = new Set(months.slice(-24, -12));
  const recentRows = [];
  const priorRows = [];

  for (const { rows } of communes) {
    for (const row of rows) {
      if (recentMonths.has(row.d)) recentRows.push(row);
      if (priorMonths.has(row.d)) priorRows.push(row);
    }
  }

  const recent = summarizeRows(recentRows, propertyType);
  const prior = summarizeRows(priorRows, propertyType);
  const changePercent =
    recent.price !== null && prior.price !== null && prior.price > 0
      ? ((recent.price - prior.price) / prior.price) * 100
      : null;

  const communeSummaries = communes.map(({ commune, rows }) => {
    const recentRowsForCommune = rows.filter((row) => recentMonths.has(row.d));
    return {
      commune,
      ...summarizeRows(recentRowsForCommune, propertyType),
    };
  });

  return {
    series: series.slice(-24),
    recent,
    changePercent,
    communeSummaries,
    lastUpdatedMonth: months.at(-1) ?? null,
  };
}

export function buildAreaSummary(communes, propertyType = "all") {
  const countField = propertyType === "house" ? "m" : propertyType === "apartment" ? "a" : "am";
  const priceField = propertyType === "house" ? "m_m" : propertyType === "apartment" ? "m_a" : "m_am";
  let sales = 0;
  let pricedSales = 0;
  let weightedPrice = 0;

  const communeSummaries = communes.map(({ commune, summary }) => {
    const communeSales = Number(summary[countField]) || 0;
    const communePrice = Number(summary[priceField]) || null;
    sales += communeSales;
    if (communeSales > 0 && communePrice !== null) {
      pricedSales += communeSales;
      weightedPrice += communeSales * communePrice;
    }
    return {
      commune,
      sales: communeSales,
      price: communeSales > 0 ? communePrice : null,
    };
  });

  return {
    recent: {
      sales,
      price: pricedSales > 0 ? Math.round(weightedPrice / pricedSales) : null,
    },
    communeSummaries,
  };
}
