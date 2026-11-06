#!/usr/bin/env python3
"""Local static server with an on-demand, privacy-preserving DVF comparer."""

import csv
import datetime
from collections import OrderedDict
from functools import lru_cache
import gzip
import io
import json
import math
import os
import posixpath
import re
import sqlite3
import statistics
import threading
import time
import urllib.error
import urllib.request
import zipfile
from concurrent.futures import ThreadPoolExecutor
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse


ROOT = Path(__file__).resolve().parent
DVF_ARCHIVE = "https://files.data.gouv.fr/geo-dvf/latest/csv"
BDNB_VERSION = os.environ.get("BDNB_VERSION", "2026-02-b")
if not re.fullmatch(r"\d{4}-\d{2}(?:-[a-z])?", BDNB_VERSION):
    raise ValueError("BDNB_VERSION doit respecter le format AAAA-MM[-lettre].")
BDNB_CACHE_VERSION = f"{BDNB_VERSION}-construction-v1"
BDNB_ARCHIVE_ROOT = (
    "https://open-data.s3.fr-par.scw.cloud/"
    f"bdnb_millesime_{BDNB_VERSION}"
)
BDNB_CACHE_PATH = ROOT / ".cache" / "bdnb-dpe.sqlite3"
BDNB_CACHE_TTL_SECONDS = int(os.environ.get("BDNB_CACHE_TTL_DAYS", "90")) * 86400
if BDNB_CACHE_TTL_SECONDS < 0:
    raise ValueError("BDNB_CACHE_TTL_DAYS ne peut pas être négatif.")
AVAILABLE_YEARS = tuple(range(2021, datetime.date.today().year + 1))
EARTH_RADIUS_KM = 6371
MIN_PUBLISHABLE_SALES = 5
MAX_DPE_LOOKUPS = 10000
DPE_CLASSES = frozenset("ABCDEFG")
BDNB_CACHE_LOCK = threading.Lock()
HTTP_RANGE_BLOCK_SIZE = 1024 * 1024
HTTP_RANGE_CACHE_BLOCKS = 4
SERVED_FILES = frozenset({"/", "/index.html", "/static-config.js", "/config.local.js"})
SERVED_DIRECTORIES = ("/src/", "/data/")


def parse_number(value):
    if value is None:
        return None
    try:
        result = float(value.strip().replace(",", "."))
        return result if math.isfinite(result) else None
    except (AttributeError, ValueError):
        return None


class HttpRangeReader:
    """Seekable read-only file backed by bounded HTTP Range requests."""

    def __init__(self, url):
        request = urllib.request.Request(
            url,
            method="HEAD",
            headers={"User-Agent": "MaisonEtMarche/1.0 (local BDNB index)"},
        )
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                self.size = int(response.headers["Content-Length"])
                if "bytes" not in response.headers.get("Accept-Ranges", "").lower():
                    raise RuntimeError("Le serveur BDNB ne prend pas en charge les téléchargements par plages.")
        except (urllib.error.URLError, KeyError, ValueError, TimeoutError) as error:
            raise RuntimeError("Les métadonnées de l'archive BDNB sont indisponibles.") from error
        self.url = url
        self.position = 0
        self.cache = OrderedDict()

    def seek(self, offset, whence=0):
        if whence == 0:
            position = offset
        elif whence == 1:
            position = self.position + offset
        elif whence == 2:
            position = self.size + offset
        else:
            raise ValueError(f"Mode de déplacement invalide : {whence}.")
        if position < 0:
            raise ValueError("Impossible de se déplacer avant le début de l'archive.")
        self.position = position
        return position

    def tell(self):
        return self.position

    def readable(self):
        return True

    def seekable(self):
        return True

    def read(self, size=-1):
        if size is None or size < 0:
            size = self.size - self.position
        end = min(self.position + size, self.size)
        chunks = []
        while self.position < end:
            block_number = self.position // HTTP_RANGE_BLOCK_SIZE
            block = self.cache.get(block_number)
            if block is None:
                start = block_number * HTTP_RANGE_BLOCK_SIZE
                block_end = min(start + HTTP_RANGE_BLOCK_SIZE, self.size) - 1
                request = urllib.request.Request(
                    self.url,
                    headers={
                        "Range": f"bytes={start}-{block_end}",
                        "User-Agent": "MaisonEtMarche/1.0 (local BDNB index)",
                    },
                )
                try:
                    with urllib.request.urlopen(request, timeout=45) as response:
                        content_range = response.headers.get("Content-Range", "")
                        if response.status != 206 or not content_range.startswith(
                            f"bytes {start}-{block_end}/"
                        ):
                            raise RuntimeError(
                                "Le serveur BDNB n'a pas respecté une requête de téléchargement partiel."
                            )
                        block = response.read()
                except (urllib.error.URLError, TimeoutError) as error:
                    raise RuntimeError("Le téléchargement ciblé de l'archive BDNB a échoué.") from error
                if len(block) != block_end - start + 1:
                    raise RuntimeError("L'archive BDNB a renvoyé un bloc incomplet.")
                self.cache[block_number] = block
                if len(self.cache) > HTTP_RANGE_CACHE_BLOCKS:
                    self.cache.popitem(last=False)
            else:
                self.cache.move_to_end(block_number)

            offset = self.position - block_number * HTTP_RANGE_BLOCK_SIZE
            chunk = block[offset : min(len(block), offset + end - self.position)]
            if not chunk:
                break
            chunks.append(chunk)
            self.position += len(chunk)
        return b"".join(chunks)


def connect_bdnb_cache():
    BDNB_CACHE_PATH.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(BDNB_CACHE_PATH, timeout=30)
    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS bdnb_department_cache (
            department TEXT NOT NULL,
            version TEXT NOT NULL,
            refreshed_at REAL NOT NULL,
            PRIMARY KEY (department, version)
        )
        """
    )
    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS bdnb_parcel_dpe (
            department TEXT NOT NULL,
            version TEXT NOT NULL,
            parcel_id TEXT NOT NULL,
            dpe_class TEXT,
            construction_year INTEGER,
            PRIMARY KEY (department, version, parcel_id)
        )
        """
    )
    columns = {
        row[1] for row in connection.execute("PRAGMA table_info(bdnb_parcel_dpe)")
    }
    if "construction_year" not in columns:
        connection.execute("ALTER TABLE bdnb_parcel_dpe ADD COLUMN construction_year INTEGER")
    return connection


def csv_rows_from_zip(archive, filename, columns):
    with archive.open(filename) as binary:
        text = io.TextIOWrapper(binary, encoding="utf-8-sig", newline="")
        reader = csv.reader(text, delimiter=";")
        header = next(reader, None)
        if header is None:
            raise RuntimeError(f"La table BDNB {filename} est vide.")
        try:
            indices = [header.index(column) for column in columns]
        except ValueError as error:
            raise RuntimeError(f"Le schéma de la table BDNB {filename} est inattendu.") from error
        for row in reader:
            if len(row) >= max(indices) + 1:
                yield tuple(row[index] for index in indices)


def import_bdnb_table(connection, archive, filename, columns, statement, normalize=None):
    batch = []
    for row in csv_rows_from_zip(archive, filename, columns):
        if normalize is not None:
            row = normalize(row)
            if row is None:
                continue
        batch.append(row)
        if len(batch) == 2000:
            connection.executemany(statement, batch)
            batch.clear()
    if batch:
        connection.executemany(statement, batch)


def refresh_bdnb_department(connection, department):
    archive_path = (
        f"{BDNB_ARCHIVE_ROOT}/millesime_{BDNB_VERSION}_dep{department}/"
        f"open_data_millesime_{BDNB_VERSION}_dep{department}_csv.zip"
    )
    remote_archive = HttpRangeReader(archive_path)
    try:
        archive = zipfile.ZipFile(remote_archive)
    except zipfile.BadZipFile as error:
        raise RuntimeError("L'archive BDNB téléchargée n'est pas un ZIP valide.") from error

    with archive:
        connection.execute(
            "CREATE TEMP TABLE temp_bdnb_dpe (identifiant_dpe TEXT PRIMARY KEY, classe TEXT)"
        )
        connection.execute(
            """
            CREATE TEMP TABLE temp_bdnb_building_dpe (
                building_id TEXT NOT NULL,
                dpe_id TEXT NOT NULL,
                PRIMARY KEY (building_id, dpe_id)
            )
            """
        )
        connection.execute(
            """
            CREATE TEMP TABLE temp_bdnb_building_parcel (
                building_id TEXT NOT NULL,
                parcel_id TEXT NOT NULL,
                PRIMARY KEY (building_id, parcel_id)
            )
            """
        )
        connection.execute(
            """
            CREATE TEMP TABLE temp_bdnb_building_year (
                building_id TEXT NOT NULL,
                construction_year INTEGER,
                PRIMARY KEY (building_id, construction_year)
            )
            """
        )
        connection.execute(
            "CREATE INDEX temp_bdnb_building_dpe_id ON temp_bdnb_building_dpe(building_id)"
        )
        connection.execute(
            "CREATE INDEX temp_bdnb_building_parcel_id ON temp_bdnb_building_parcel(building_id)"
        )

        def normalize_dpe(row):
            identifier, dpe_class = row
            if not identifier:
                return None
            dpe_class = dpe_class.strip().upper()
            return identifier, dpe_class if dpe_class in DPE_CLASSES else None

        import_bdnb_table(
            connection,
            archive,
            "csv/dpe_logement.csv",
            ("identifiant_dpe", "classe_bilan_dpe"),
            "INSERT OR REPLACE INTO temp_bdnb_dpe VALUES (?, ?)",
            normalize_dpe,
        )
        import_bdnb_table(
            connection,
            archive,
            "csv/rel_batiment_groupe_dpe_logement.csv",
            ("batiment_groupe_id", "identifiant_dpe"),
            "INSERT OR IGNORE INTO temp_bdnb_building_dpe VALUES (?, ?)",
            lambda row: row if all(row) else None,
        )
        import_bdnb_table(
            connection,
            archive,
            "csv/rel_batiment_groupe_parcelle.csv",
            ("batiment_groupe_id", "parcelle_id"),
            "INSERT OR IGNORE INTO temp_bdnb_building_parcel VALUES (?, ?)",
            lambda row: row if all(row) else None,
        )

        def normalize_construction_year(row):
            building_id, raw_year = row
            if not building_id:
                return None
            try:
                year = int(raw_year)
            except (TypeError, ValueError):
                return building_id, None
            if not 1600 <= year <= datetime.date.today().year:
                return building_id, None
            return building_id, year

        import_bdnb_table(
            connection,
            archive,
            "csv/batiment_groupe_ffo_bat.csv",
            ("batiment_groupe_id", "annee_construction"),
            "INSERT OR IGNORE INTO temp_bdnb_building_year VALUES (?, ?)",
            normalize_construction_year,
        )

    refreshed_at = time.time()
    connection.execute(
        "DELETE FROM bdnb_parcel_dpe WHERE department = ?",
        (department,),
    )
    connection.execute(
        """
        INSERT INTO bdnb_parcel_dpe (
            department, version, parcel_id, dpe_class, construction_year
        )
        SELECT ?, ?, parcel.parcel_id,
               CASE WHEN COUNT(DISTINCT building_dpe.dpe_id) = 1
                    THEN MAX(dpe.classe)
                    ELSE NULL
               END,
               CASE WHEN COUNT(DISTINCT building_year.construction_year) = 1
                    THEN MAX(building_year.construction_year)
                    ELSE NULL
               END
        FROM temp_bdnb_building_parcel AS parcel
        LEFT JOIN temp_bdnb_building_dpe AS building_dpe
          ON building_dpe.building_id = parcel.building_id
        LEFT JOIN temp_bdnb_dpe AS dpe
          ON dpe.identifiant_dpe = building_dpe.dpe_id
        LEFT JOIN temp_bdnb_building_year AS building_year
          ON building_year.building_id = parcel.building_id
        GROUP BY parcel.parcel_id
        """,
        (department, BDNB_CACHE_VERSION),
    )
    connection.execute(
        """
        INSERT OR REPLACE INTO bdnb_department_cache (department, version, refreshed_at)
        VALUES (?, ?, ?)
        """,
        (department, BDNB_CACHE_VERSION, refreshed_at),
    )
    connection.commit()


def ensure_bdnb_department(department):
    with BDNB_CACHE_LOCK:
        connection = connect_bdnb_cache()
        try:
            row = connection.execute(
                """
                SELECT refreshed_at FROM bdnb_department_cache
                WHERE department = ? AND version = ?
                """,
                (department, BDNB_CACHE_VERSION),
            ).fetchone()
            is_fresh = (
                row is not None
                and BDNB_CACHE_TTL_SECONDS > 0
                and time.time() - row[0] < BDNB_CACHE_TTL_SECONDS
            )
            if not is_fresh:
                try:
                    refresh_bdnb_department(connection, department)
                except (urllib.error.HTTPError, zipfile.BadZipFile, KeyError, csv.Error, sqlite3.Error) as error:
                    connection.rollback()
                    raise RuntimeError(
                        f"Le jeu BDNB {BDNB_VERSION} du département {department} n'a pas pu être indexé."
                    ) from error
        finally:
            connection.close()


def lookup_bdnb_parcel_data(parcels_by_department):
    results = {}
    connection = connect_bdnb_cache()
    try:
        for department, parcel_ids in parcels_by_department.items():
            for start in range(0, len(parcel_ids), 500):
                batch = parcel_ids[start : start + 500]
                placeholders = ",".join("?" for _ in batch)
                rows = connection.execute(
                    f"""
                    SELECT parcel_id, dpe_class, construction_year FROM bdnb_parcel_dpe
                    WHERE department = ? AND version = ?
                      AND parcel_id IN ({placeholders})
                    """,
                    (department, BDNB_CACHE_VERSION, *batch),
                )
                results.update(
                    (parcel_id, {"dpe": dpe_class, "constructionYear": construction_year})
                    for parcel_id, dpe_class, construction_year in rows
                )
    finally:
        connection.close()
    return results


def lookup_bdnb_parcel_dpe(parcels_by_department):
    return {
        parcel_id: parcel_data["dpe"]
        for parcel_id, parcel_data in lookup_bdnb_parcel_data(parcels_by_department).items()
    }


def distance_in_km(latitude, longitude, other_latitude, other_longitude):
    radians = math.radians
    lat_difference = radians(other_latitude - latitude)
    lon_difference = radians(other_longitude - longitude)
    haversine = (
        math.sin(lat_difference / 2) ** 2
        + math.cos(radians(latitude))
        * math.cos(radians(other_latitude))
        * math.sin(lon_difference / 2) ** 2
    )
    return 2 * EARTH_RADIUS_KM * math.atan2(math.sqrt(haversine), math.sqrt(1 - haversine))


def percentile(values, fraction):
    ordered = sorted(values)
    position = (len(ordered) - 1) * fraction
    lower = math.floor(position)
    upper = math.ceil(position)
    if lower == upper:
        return ordered[lower]
    return ordered[lower] + (ordered[upper] - ordered[lower]) * (position - lower)


@lru_cache(maxsize=64)
def load_department_transactions(year, department, latitude, longitude, radius):
    url = f"{DVF_ARCHIVE}/{year}/departements/{department}.csv.gz"
    request = urllib.request.Request(
        url,
        headers={"User-Agent": "MaisonEtMarche/1.0 (local DVF comparer)"},
    )
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            compressed = response.read()
    except urllib.error.HTTPError as error:
        if error.code == 404 and year == datetime.date.today().year:
            return None
        raise RuntimeError(
            f"Le fichier DVF géolocalisé {year} du département {department} est indisponible."
        ) from error
    except (urllib.error.URLError, TimeoutError) as error:
        raise RuntimeError(
            f"Le fichier DVF géolocalisé {year} du département {department} est indisponible."
        ) from error

    transactions = {}
    with gzip.GzipFile(fileobj=io.BytesIO(compressed)) as decoded:
        text = io.TextIOWrapper(decoded, encoding="utf-8-sig", newline="")
        for row in csv.DictReader(text):
            if row.get("nature_mutation") != "Vente":
                continue
            transaction_id = row.get("id_mutation")
            price = parse_number(row.get("valeur_fonciere"))
            row_latitude = parse_number(row.get("latitude"))
            row_longitude = parse_number(row.get("longitude"))
            if (
                not transaction_id
                or not price
                or row_latitude is None
                or row_longitude is None
                or distance_in_km(latitude, longitude, row_latitude, row_longitude) > radius
            ):
                continue

            transaction = transactions.setdefault(
                transaction_id,
                {
                    "price": price,
                    "date": row.get("date_mutation"),
                    "homes": {},
                    "other_homes": set(),
                    "land": {},
                },
            )
            parcel_id = row.get("id_parcelle")
            land_area = parse_number(row.get("surface_terrain"))
            if parcel_id and land_area and land_area > 0:
                transaction["land"][parcel_id] = max(
                    land_area, transaction["land"].get(parcel_id, 0)
                )

            local_type = row.get("type_local")
            if local_type not in ("Maison", "Appartement"):
                continue
            built_area = parse_number(row.get("surface_reelle_bati"))
            rooms = parse_number(row.get("nombre_pieces_principales"))
            if not built_area or built_area <= 0 or rooms is None or rooms <= 0:
                continue

            signature = (
                round(row_latitude, 4),
                round(row_longitude, 4),
                built_area,
                rooms,
            )
            if local_type == "Maison":
                home = transaction["homes"].setdefault(
                    signature,
                    {
                        "livingArea": built_area,
                        "rooms": rooms,
                        "latitude": row_latitude,
                        "longitude": row_longitude,
                        "parcels": set(),
                    },
                )
                if parcel_id:
                    home["parcels"].add(parcel_id)
            else:
                transaction["other_homes"].add(signature)

    sales = []
    for transaction in transactions.values():
        if len(transaction["homes"]) != 1 or transaction["other_homes"]:
            continue
        home = next(iter(transaction["homes"].values()))
        land_area = sum(transaction["land"].values()) or None
        sales.append(
            {
                "price": transaction["price"],
                "date": transaction["date"],
                "livingArea": home["livingArea"],
                "rooms": home["rooms"],
                "landArea": land_area,
                "parcelId": next(iter(home["parcels"])) if len(home["parcels"]) == 1 else None,
                "latitude": home["latitude"],
                "longitude": home["longitude"],
                "department": department,
            }
        )
    return sales


def summarize(sales, filters, dpe_class=None, dpe_lookup_limit=MAX_DPE_LOOKUPS):
    comparable_sales = [
        sale
        for sale in sales
        if filters["min_area"] <= sale["livingArea"] <= filters["max_area"]
        and filters["min_rooms"] <= sale["rooms"] <= filters["max_rooms"]
        and sale["landArea"] is not None
        and filters["min_land"] <= sale["landArea"] <= filters["max_land"]
    ]

    min_construction_year = filters.get("min_construction_year")
    max_construction_year = filters.get("max_construction_year")
    construction_filter_active = (
        min_construction_year is not None or max_construction_year is not None
    )
    dpe_sample = None
    construction_sample = None
    parcel_data = {}
    if dpe_class is not None or construction_filter_active:
        parcel_sales = {}
        for sale in comparable_sales:
            if sale["parcelId"] is not None:
                parcel_sales.setdefault(sale["parcelId"], []).append(sale)
        all_parcels = sorted(parcel_sales)
        area_center = (filters["min_area"] + filters["max_area"]) / 2
        rooms_center = (filters["min_rooms"] + filters["max_rooms"]) / 2
        land_center = (filters["min_land"] + filters["max_land"]) / 2
        area_scale = max(filters["max_area"] - filters["min_area"], 1)
        rooms_scale = max(filters["max_rooms"] - filters["min_rooms"], 1)
        land_scale = max(filters["max_land"] - filters["min_land"], 1)
        parcel_distance = {}
        for parcel_id, parcel_transactions in parcel_sales.items():
            representative = parcel_transactions[0]
            parcel_distance[parcel_id] = sum(
                [
                    ((representative["livingArea"] - area_center) / area_scale) ** 2,
                    ((representative["rooms"] - rooms_center) / rooms_scale) ** 2,
                    ((representative["landArea"] - land_center) / land_scale) ** 2,
                ]
            )
        parcel_ids = sorted(all_parcels, key=lambda parcel: (parcel_distance[parcel], parcel))
        checked_parcels = parcel_ids[: min(dpe_lookup_limit, MAX_DPE_LOOKUPS)]
        checked_parcel_set = set(checked_parcels)
        checked_by_department = {}
        for sale in comparable_sales:
            if sale["parcelId"] in checked_parcel_set:
                checked_by_department.setdefault(sale["department"], set()).add(sale["parcelId"])
        for department in sorted(checked_by_department):
            ensure_bdnb_department(department)
        parcel_data = lookup_bdnb_parcel_data(
            {
                department: sorted(parcel_ids)
                for department, parcel_ids in checked_by_department.items()
            }
        )
        if dpe_class is not None:
            comparable_sales = [
                sale
                for sale in comparable_sales
                if parcel_data.get(sale["parcelId"], {}).get("dpe") == dpe_class
            ]
            dpe_sample = {
                "checkedParcels": len(checked_parcels),
                "eligibleParcels": len(all_parcels),
                "maximumLookups": min(len(all_parcels), MAX_DPE_LOOKUPS),
                "version": BDNB_VERSION,
            }
        if construction_filter_active:
            comparable_sales = [
                sale
                for sale in comparable_sales
                if (construction_year := parcel_data.get(sale["parcelId"], {}).get("constructionYear"))
                is not None
                and (min_construction_year is None or construction_year >= min_construction_year)
                and (max_construction_year is None or construction_year <= max_construction_year)
            ]
            construction_sample = {
                "checkedParcels": len(checked_parcels),
                "eligibleParcels": len(all_parcels),
                "maximumLookups": min(len(all_parcels), MAX_DPE_LOOKUPS),
                "version": BDNB_VERSION,
            }

    if len(comparable_sales) < MIN_PUBLISHABLE_SALES:
        summary = {
            "suppressed": True,
            "minimumRequired": MIN_PUBLISHABLE_SALES,
            "matched": None,
        }
        if dpe_sample is not None:
            summary["dpeSample"] = dpe_sample
        if construction_sample is not None:
            summary["constructionSample"] = construction_sample
        return summary

    prices = [sale["price"] for sale in comparable_sales]
    prices_per_m2 = [sale["price"] / sale["livingArea"] for sale in comparable_sales]
    areas = [sale["livingArea"] for sale in comparable_sales]
    land_areas = [sale["landArea"] for sale in comparable_sales]
    rooms = [sale["rooms"] for sale in comparable_sales]

    summary = {
        "suppressed": False,
        "matched": len(comparable_sales),
        "medianPrice": round(statistics.median(prices)),
        "priceRange": [
            round(percentile(prices, 0.25)),
            round(percentile(prices, 0.75)),
        ],
        "medianPricePerM2": round(statistics.median(prices_per_m2)),
        "medianLivingArea": round(statistics.median(areas)),
        "medianLandArea": round(statistics.median(land_areas)),
        "medianRooms": round(statistics.median(rooms)),
    }
    if dpe_sample is not None:
        summary["dpeSample"] = dpe_sample
    if construction_sample is not None:
        summary["constructionSample"] = construction_sample
    if dpe_sample is not None or construction_sample is not None:
        summary["transactions"] = [
            {
                "date": sale["date"],
                "price": round(sale["price"]),
                "livingArea": sale["livingArea"],
                "landArea": sale["landArea"],
                "rooms": sale["rooms"],
                "pricePerM2": round(sale["price"] / sale["livingArea"]),
                "dpe": parcel_data.get(sale["parcelId"], {}).get("dpe"),
                "constructionYear": parcel_data.get(sale["parcelId"], {}).get("constructionYear"),
                "parcelId": sale["parcelId"],
                "latitude": sale["latitude"],
                "longitude": sale["longitude"],
            }
            for sale in sorted(
                comparable_sales,
                key=lambda sale: (sale["date"] or "", sale["price"]),
                reverse=True,
            )
        ]
    return summary


def parse_query(query):
    params = parse_qs(query, strict_parsing=True)

    def number(name, minimum, maximum):
        try:
            value = float(params[name][0])
        except (KeyError, ValueError, IndexError) as error:
            raise ValueError(f"Paramètre invalide : {name}.") from error
        if not math.isfinite(value) or not minimum <= value <= maximum:
            raise ValueError(f"Valeur hors limites : {name}.")
        return value

    latitude = number("lat", -90, 90)
    longitude = number("lon", -180, 180)
    radius = number("radius", 1, 20)
    departments = params.get("departments", [""])[0].split(",")
    departments = list(dict.fromkeys(departments))
    if (
        not departments
        or len(departments) > 10
        or any(not re.fullmatch(r"(?:\d{2,3}|2[AB])", code) for code in departments)
    ):
        raise ValueError("La liste des départements est invalide.")

    filters = {
        "min_area": number("min_area", 20, 1000),
        "max_area": number("max_area", 20, 1000),
        "min_rooms": number("min_rooms", 1, 30),
        "max_rooms": number("max_rooms", 1, 30),
        "min_land": number("min_land", 0, 100000),
        "max_land": number("max_land", 0, 100000),
    }
    for parameter, filter_name in (
        ("min_construction_year", "min_construction_year"),
        ("max_construction_year", "max_construction_year"),
    ):
        raw_year = params.get(parameter, [None])[0]
        if raw_year is None:
            filters[filter_name] = None
            continue
        try:
            year = int(raw_year)
        except ValueError as error:
            raise ValueError(f"Paramètre invalide : {parameter}.") from error
        if not 1600 <= year <= datetime.date.today().year:
            raise ValueError(f"Valeur hors limites : {parameter}.")
        filters[filter_name] = year
    if filters["min_area"] > filters["max_area"]:
        raise ValueError("La surface habitable minimale dépasse le maximum.")
    if filters["min_rooms"] > filters["max_rooms"]:
        raise ValueError("Le nombre de pièces minimal dépasse le maximum.")
    if filters["min_land"] > filters["max_land"]:
        raise ValueError("La surface de terrain minimale dépasse le maximum.")
    if (
        filters["min_construction_year"] is not None
        and filters["max_construction_year"] is not None
        and filters["min_construction_year"] > filters["max_construction_year"]
    ):
        raise ValueError("L'année de construction minimale dépasse le maximum.")

    dpe_class = params.get("dpe", ["all"])[0]
    if dpe_class not in (*"ABCDEFG", "all"):
        raise ValueError("La classe DPE doit être comprise entre A et G.")
    try:
        dpe_lookup_limit = int(params.get("dpe_limit", [str(MAX_DPE_LOOKUPS)])[0])
    except (ValueError, IndexError) as error:
        raise ValueError("Le nombre de parcelles DPE demandé est invalide.") from error
    if not 1 <= dpe_lookup_limit <= MAX_DPE_LOOKUPS:
        raise ValueError("Le nombre de parcelles DPE demandé dépasse la limite autorisée.")

    return latitude, longitude, radius, departments, filters, (
        None if dpe_class == "all" else dpe_class
    ), dpe_lookup_limit


class DashboardHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def log_message(self, _format, *args):
        return

    def send_json(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def is_request_allowed(self):
        # Refuse foreign Host headers (DNS rebinding) and anything but the app's own files.
        port = self.server.server_address[1]
        if self.headers.get("Host") not in {f"127.0.0.1:{port}", f"localhost:{port}"}:
            return False
        path = posixpath.normpath(unquote(urlparse(self.path).path))
        if path == "/api/dvf-comparables":
            return True
        return path in SERVED_FILES or path.startswith(SERVED_DIRECTORIES)

    def do_HEAD(self):
        if not self.is_request_allowed():
            return self.send_error(403)
        return super().do_HEAD()

    def do_GET(self):
        if not self.is_request_allowed():
            return self.send_error(403)
        parsed_url = urlparse(self.path)
        if parsed_url.path != "/api/dvf-comparables":
            return super().do_GET()

        try:
            latitude, longitude, radius, departments, filters, dpe_class, dpe_lookup_limit = parse_query(parsed_url.query)
            archive_jobs = [
                (year, department)
                for year in AVAILABLE_YEARS
                for department in departments
            ]
            archive_results = {}
            with ThreadPoolExecutor(max_workers=4) as executor:
                futures = {
                    executor.submit(
                        load_department_transactions,
                        year,
                        department,
                        latitude,
                        longitude,
                        radius,
                    ): (year, department)
                    for year, department in archive_jobs
                }
                for future, (year, department) in futures.items():
                    archive_results[(year, department)] = future.result()
            available_years = sorted(
                year
                for year in AVAILABLE_YEARS
                if any(archive_results[(year, department)] is not None for department in departments)
            )
            coverage = [
                {
                    "department": department,
                    "years": [
                        year
                        for year in AVAILABLE_YEARS
                        if archive_results[(year, department)] is not None
                    ],
                }
                for department in departments
            ]
            generated_at = datetime.datetime.now(datetime.timezone.utc)
            sales = [
                sale
                for result in archive_results.values()
                if result is not None
                for sale in result
            ]
            if not available_years:
                raise RuntimeError("Aucune archive DVF géolocalisée n'est disponible pour cette zone.")
            self.send_json(
                200,
                {
                    "source": "DVF géolocalisé · DGFiP/data.gouv.fr",
                    "generatedAt": generated_at.date().isoformat(),
                    "generatedAtUtc": generated_at.isoformat(),
                    "firstYear": available_years[0],
                    "lastYear": available_years[-1],
                    "years": available_years,
                    "coverage": coverage,
                    "filters": {
                        "livingArea": [filters["min_area"], filters["max_area"]],
                        "rooms": [filters["min_rooms"], filters["max_rooms"]],
                        "landArea": [filters["min_land"], filters["max_land"]],
                        "constructionYear": [
                            filters["min_construction_year"],
                            filters["max_construction_year"],
                        ],
                        "dpe": dpe_class,
                    },
                    "summary": summarize(sales, filters, dpe_class, dpe_lookup_limit),
                },
            )
        except ValueError as error:
            self.send_json(422, {"error": str(error)})
        except (RuntimeError, OSError, EOFError, csv.Error) as error:
            self.send_json(502, {"error": str(error) or "La source DVF détaillée est indisponible."})


if __name__ == "__main__":
    host = "127.0.0.1"
    port = int(os.environ.get("PORT", "8000"))
    print(f"Maison & Marché : http://{host}:{port}")
    ThreadingHTTPServer((host, port), DashboardHandler).serve_forever()
