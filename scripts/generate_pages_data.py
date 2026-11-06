#!/usr/bin/env python3
"""Generate the public, periodically refreshed GitHub Pages snapshot."""

import concurrent.futures
import datetime
import json
import math
import os
from pathlib import Path
import re
import sys
import urllib.error
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import server


OUTPUT_DIRECTORY = ROOT / "_site"
HISTORY_PATH = ROOT / "data" / "snapshot-history.json"
HOME_RADIUS_KM = 20


def read_configuration(environ=os.environ):
    def number(name, default=None):
        raw_value = environ.get(name, default)
        if raw_value is None:
            raise ValueError(f"La variable {name} est obligatoire.")
        try:
            value = float(raw_value)
        except ValueError as error:
            raise ValueError(f"La variable {name} doit être numérique.") from error
        if not math.isfinite(value):
            raise ValueError(f"La variable {name} doit être finie.")
        return value

    def year(name, default):
        value = number(name, default)
        if not value.is_integer():
            raise ValueError(f"La variable {name} doit être une année entière.")
        return int(value)

    city_code = environ.get("HOME_CITY_CODE", "")
    department = environ.get("HOME_DEPARTMENT_CODE", "")
    departments = list(dict.fromkeys(environ.get("HOME_DEPARTMENTS", "").split(",")))
    if not re.fullmatch(r"\d{5}", city_code):
        raise ValueError("HOME_CITY_CODE doit être un code commune INSEE à cinq chiffres.")
    if not re.fullmatch(r"(?:\d{2,3}|2[AB])", department):
        raise ValueError("HOME_DEPARTMENT_CODE est invalide.")
    if (
        not departments
        or len(departments) > 10
        or any(not re.fullmatch(r"(?:\d{2,3}|2[AB])", code) for code in departments)
    ):
        raise ValueError("HOME_DEPARTMENTS doit contenir au plus 10 codes département valides.")

    config = {
        "latitude": number("HOME_LATITUDE"),
        "longitude": number("HOME_LONGITUDE"),
        "cityCode": city_code,
        "departmentCode": department,
        "departments": departments,
        "filters": {
            "min_area": number("COMPARABLE_MIN_AREA", "85"),
            "max_area": number("COMPARABLE_MAX_AREA", "125"),
            "min_rooms": number("COMPARABLE_MIN_ROOMS", "4"),
            "max_rooms": number("COMPARABLE_MAX_ROOMS", "6"),
            "min_land": number("COMPARABLE_MIN_LAND", "300"),
            "max_land": number("COMPARABLE_MAX_LAND", "1200"),
            "min_construction_year": year("COMPARABLE_MIN_CONSTRUCTION_YEAR", "1963"),
            "max_construction_year": year("COMPARABLE_MAX_CONSTRUCTION_YEAR", "1983"),
        },
        "dpe": environ.get("COMPARABLE_DPE", "D"),
    }
    if not re.fullmatch(r"[A-G]", config["dpe"]):
        raise ValueError("COMPARABLE_DPE doit être une classe comprise entre A et G.")

    query = urllib.parse.urlencode(
        {
            "lat": config["latitude"],
            "lon": config["longitude"],
            "radius": HOME_RADIUS_KM,
            "departments": ",".join(departments),
            "min_area": config["filters"]["min_area"],
            "max_area": config["filters"]["max_area"],
            "min_rooms": config["filters"]["min_rooms"],
            "max_rooms": config["filters"]["max_rooms"],
            "min_land": config["filters"]["min_land"],
            "max_land": config["filters"]["max_land"],
            "min_construction_year": config["filters"]["min_construction_year"],
            "max_construction_year": config["filters"]["max_construction_year"],
            "dpe": config["dpe"],
            "dpe_limit": server.MAX_DPE_LOOKUPS,
        }
    )
    _, _, _, _, config["filters"], config["dpe"], _ = server.parse_query(query)
    return config


def load_public_commune(city_code):
    url = f"https://geo.api.gouv.fr/communes/{city_code}?fields=nom,code,centre"
    request = urllib.request.Request(
        url,
        headers={"User-Agent": "MaisonEtMarche/1.0 (scheduled public snapshot)"},
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            commune = json.load(response)
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as error:
        raise RuntimeError("Le centre public de la commune est indisponible.") from error

    coordinates = commune.get("centre", {}).get("coordinates", [])
    if (
        len(coordinates) != 2
        or not all(isinstance(value, (int, float)) and math.isfinite(value) for value in coordinates)
    ):
        raise RuntimeError("L'API géographique n'a pas fourni le centre de la commune.")
    return {
        "label": commune["nom"],
        "latitude": coordinates[1],
        "longitude": coordinates[0],
        "departmentCode": commune["code"][:2],
        "cityCode": commune["code"],
    }


def load_sales(config, transaction_loader=server.load_department_transactions):
    archive_jobs = [
        (year, department)
        for year in server.dvf_years()
        for department in config["departments"]
    ]
    archive_results = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as executor:
        futures = {
            executor.submit(
                transaction_loader,
                year,
                department,
                config["latitude"],
                config["longitude"],
                HOME_RADIUS_KM,
            ): (year, department)
            for year, department in archive_jobs
        }
        for future, key in futures.items():
            archive_results[key] = future.result()

    available_years = sorted(
        year
        for year in server.dvf_years()
        if any(archive_results[(year, department)] is not None for department in config["departments"])
    )
    if not available_years:
        raise RuntimeError("Aucune archive DVF géolocalisée n'est disponible pour cette zone.")
    department_coverage = [
        {
            "department": department,
            "years": [
                year
                for year in server.dvf_years()
                if archive_results[(year, department)] is not None
            ],
        }
        for department in config["departments"]
    ]
    sales = [
        sale
        for result in archive_results.values()
        if result is not None
        for sale in result
    ]
    return sales, available_years, department_coverage


def write_snapshot(
    config,
    output_directory=OUTPUT_DIRECTORY,
    now=None,
    history_path=HISTORY_PATH,
):
    sales, available_years, department_coverage = load_sales(config)
    summary = server.summarize(
        sales,
        config["filters"],
        config["dpe"],
        server.MAX_DPE_LOOKUPS,
    )
    generated_at = now or datetime.datetime.now(datetime.timezone.utc)
    public_filters = {
        "livingArea": [config["filters"]["min_area"], config["filters"]["max_area"]],
        "rooms": [config["filters"]["min_rooms"], config["filters"]["max_rooms"]],
        "landArea": [config["filters"]["min_land"], config["filters"]["max_land"]],
        "constructionYear": [
            config["filters"]["min_construction_year"],
            config["filters"]["max_construction_year"],
        ],
        "dpe": config["dpe"],
    }
    output_directory = Path(output_directory)
    data_directory = output_directory / "data"
    data_directory.mkdir(parents=True, exist_ok=True)
    payload = {
        "source": "DVF géolocalisé · DGFiP/data.gouv.fr",
        "generatedAt": generated_at.date().isoformat(),
        "generatedAtUtc": generated_at.isoformat(),
        "firstYear": available_years[0],
        "lastYear": available_years[-1],
        "years": available_years,
        "coverage": department_coverage,
        "filters": public_filters,
        "summary": summary,
    }
    (data_directory / "comparables.json").write_text(
        json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )

    history_path = Path(history_path)
    if history_path.exists():
        try:
            history = json.loads(history_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as error:
            raise RuntimeError("Le fichier d'historique des instantanés contient un JSON invalide.") from error
        if (
            not isinstance(history, dict)
            or history.get("schemaVersion") != 1
            or not isinstance(history.get("snapshots"), list)
        ):
            raise RuntimeError("Le fichier d'historique des instantanés a un format invalide.")
    else:
        history = {"schemaVersion": 1, "snapshots": []}
    history_item = {
        "generatedAt": generated_at.date().isoformat(),
        "matched": summary.get("matched"),
        "medianPrice": summary.get("medianPrice"),
        "medianPricePerM2": summary.get("medianPricePerM2"),
        "firstYear": available_years[0],
        "lastYear": available_years[-1],
        "years": available_years,
        "coverage": department_coverage,
        "filters": public_filters,
        "scope": {
            "cityCode": config["cityCode"],
            "departments": config["departments"],
        },
    }
    snapshots = [
        item for item in history["snapshots"] if item.get("generatedAt") != history_item["generatedAt"]
    ]
    snapshots.append(history_item)
    history = {
        "schemaVersion": 1,
        "snapshots": sorted(snapshots, key=lambda item: item["generatedAt"]),
    }
    history_path.parent.mkdir(parents=True, exist_ok=True)
    history_path.write_text(json.dumps(history, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    (data_directory / "snapshot-history.json").write_text(
        json.dumps(history, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )

    home = load_public_commune(config["cityCode"])
    static_config = (
        f"window.STATIC_DATA_MODE = true;\n"
        f"window.LOCAL_HOME = {json.dumps(home, ensure_ascii=False)};\n"
        "window.STATIC_COMPARABLE_FILTERS = "
        + json.dumps(
            {
                "minArea": config["filters"]["min_area"],
                "maxArea": config["filters"]["max_area"],
                "minRooms": config["filters"]["min_rooms"],
                "maxRooms": config["filters"]["max_rooms"],
                "minLand": config["filters"]["min_land"],
                "maxLand": config["filters"]["max_land"],
                "minConstructionYear": config["filters"]["min_construction_year"],
                "maxConstructionYear": config["filters"]["max_construction_year"],
                "dpe": config["dpe"],
            },
            ensure_ascii=False,
        )
        + ";\n"
    )
    (output_directory / "static-config.js").write_text(static_config, encoding="utf-8")
    print(
        f"Generated public comparable snapshot: {summary.get('matched', 0)} sales, "
        f"years {available_years[0]}-{available_years[-1]}."
    )


def prepare_site(output_directory=OUTPUT_DIRECTORY):
    output_directory = Path(output_directory)
    output_directory.mkdir(parents=True, exist_ok=True)
    (output_directory / "src").mkdir(exist_ok=True)
    for relative_path in ("index.html", "src/main.js", "src/market.js", "src/styles.css"):
        source = ROOT / relative_path
        target = output_directory / relative_path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(source.read_bytes())
    (output_directory / ".nojekyll").touch()
    (output_directory / "index.html").write_text(
        (output_directory / "index.html")
        .read_text(encoding="utf-8")
        .replace(
            '<script src="./config.local.js"></script>',
            "",
        ),
        encoding="utf-8",
    )


if __name__ == "__main__":
    prepare_site()
    write_snapshot(read_configuration())
