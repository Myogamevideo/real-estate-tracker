import datetime
import http.client
import importlib.util
import json
from pathlib import Path
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer

import server


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "generate_pages_data",
    ROOT / "scripts" / "generate_pages_data.py",
)
generator = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(generator)


class SnapshotFeatureTests(unittest.TestCase):
    def setUp(self):
        self.environment = {
            "HOME_LATITUDE": "45.736497",
            "HOME_LONGITUDE": "3.205874",
            "HOME_CITY_CODE": "63124",
            "HOME_DEPARTMENT_CODE": "63",
            "HOME_DEPARTMENTS": "63,03",
        }

    def test_configuration_defaults_to_construction_year_band(self):
        config = generator.read_configuration(self.environment)
        self.assertEqual(
            (
                config["filters"]["min_construction_year"],
                config["filters"]["max_construction_year"],
            ),
            (1963, 1983),
        )

    def test_configuration_rejects_fractional_construction_year(self):
        with self.assertRaisesRegex(ValueError, "année entière"):
            generator.read_configuration(
                {**self.environment, "COMPARABLE_MIN_CONSTRUCTION_YEAR": "1963.5"}
            )

    def test_construction_year_filter_uses_bdnb_parcel_data(self):
        sales = [
            {
                "price": 210000 + index * 1000,
                "date": f"2025-01-{index + 1:02}",
                "livingArea": 105,
                "rooms": 5,
                "landArea": 675,
                "parcelId": f"63124000BI{index:04}",
                "department": "63",
                "latitude": 45.73 + index * 0.001,
                "longitude": 3.2,
            }
            for index in range(7)
        ]
        years = dict(zip((sale["parcelId"] for sale in sales), [1960, 1963, 1968, 1973, 1978, 1983, 1985]))
        original_ensure = server.ensure_bdnb_department
        original_lookup = server.lookup_bdnb_parcel_data
        try:
            server.ensure_bdnb_department = lambda _department: None
            server.lookup_bdnb_parcel_data = lambda parcels: {
                parcel: {"dpe": "D", "constructionYear": years[parcel]}
                for parcel_ids in parcels.values()
                for parcel in parcel_ids
            }
            filters = {
                "min_area": 85,
                "max_area": 125,
                "min_rooms": 4,
                "max_rooms": 6,
                "min_land": 300,
                "max_land": 1200,
                "min_construction_year": 1963,
                "max_construction_year": 1983,
            }
            summary = server.summarize(sales, filters, "D")
        finally:
            server.ensure_bdnb_department = original_ensure
            server.lookup_bdnb_parcel_data = original_lookup

        self.assertEqual(summary["matched"], 5)
        self.assertEqual(
            {sale["constructionYear"] for sale in summary["transactions"]},
            {1963, 1968, 1973, 1978, 1983},
        )

    def test_old_bdnb_cache_schema_is_migrated(self):
        with tempfile.TemporaryDirectory() as directory:
            old_path = server.BDNB_CACHE_PATH
            try:
                server.BDNB_CACHE_PATH = Path(directory) / "old-cache.sqlite3"
                import sqlite3

                with sqlite3.connect(server.BDNB_CACHE_PATH) as connection:
                    connection.execute(
                        """
                        CREATE TABLE bdnb_parcel_dpe (
                            department TEXT NOT NULL,
                            version TEXT NOT NULL,
                            parcel_id TEXT NOT NULL,
                            dpe_class TEXT,
                            PRIMARY KEY (department, version, parcel_id)
                        )
                        """
                    )
                connection = server.connect_bdnb_cache()
                columns = {
                    row[1]
                    for row in connection.execute("PRAGMA table_info(bdnb_parcel_dpe)")
                }
                connection.close()
            finally:
                server.BDNB_CACHE_PATH = old_path
        self.assertIn("construction_year", columns)

    def test_snapshot_saves_coverage_and_replaces_same_day_history(self):
        config = generator.read_configuration(self.environment)
        sales = []
        original_load_sales = generator.load_sales
        original_summarize = server.summarize
        original_commune = generator.load_public_commune
        try:
            generator.load_sales = lambda _config: (
                sales,
                [2021, 2025],
                [{"department": "63", "years": [2021, 2025]}],
            )
            server.summarize = lambda *_args: {
                "suppressed": False,
                "matched": 5,
                "medianPrice": 220000,
                "medianPricePerM2": 2100,
                "transactions": [],
            }
            generator.load_public_commune = lambda _code: {
                "label": "Cournon-d'Auvergne",
                "latitude": 45.73,
                "longitude": 3.19,
                "departmentCode": "63",
                "cityCode": "63124",
            }
            with tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                site = root / "_site"
                history_path = root / "data" / "snapshot-history.json"
                timestamp = datetime.datetime(2026, 11, 3, tzinfo=datetime.timezone.utc)
                generator.prepare_site(site)
                generator.write_snapshot(config, site, timestamp, history_path)
                generator.write_snapshot(config, site, timestamp, history_path)
                snapshot = json.loads((site / "data" / "comparables.json").read_text())
                history = json.loads(history_path.read_text())
                site_history_exists = (site / "data" / "snapshot-history.json").exists()
        finally:
            generator.load_sales = original_load_sales
            server.summarize = original_summarize
            generator.load_public_commune = original_commune

        self.assertEqual(snapshot["years"], [2021, 2025])
        self.assertEqual(snapshot["coverage"][0]["department"], "63")
        self.assertEqual(snapshot["filters"]["constructionYear"], [1963, 1983])
        self.assertTrue(site_history_exists)
        self.assertEqual(len(history["snapshots"]), 1)

    def test_published_site_has_no_personal_purchase_profile(self):
        with tempfile.TemporaryDirectory() as directory:
            site = Path(directory) / "_site"
            generator.prepare_site(site)
            published = (site / "src" / "main.js").read_text(encoding="utf-8")
        self.assertNotIn("215000", published)
        self.assertNotIn("2026-04-27", published)


class LocalServerGuardTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.DashboardHandler)
        cls.port = cls.httpd.server_address[1]
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()

    def status(self, path, host=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        connection.putrequest("GET", path, skip_host=True)
        connection.putheader("Host", host or f"127.0.0.1:{self.port}")
        connection.endheaders()
        status = connection.getresponse().status
        connection.close()
        return status

    def test_foreign_host_header_is_refused(self):
        self.assertEqual(self.status("/", host="evil.example"), 403)
        self.assertEqual(self.status("/", host=f"evil.example:{self.port}"), 403)

    def test_local_host_headers_are_accepted(self):
        self.assertEqual(self.status("/"), 200)
        self.assertEqual(self.status("/", host=f"localhost:{self.port}"), 200)

    def test_only_application_files_are_served(self):
        for path in (
            "/.git/config",
            "/server.py",
            "/src/../.git/config",
            "/src/%2e%2e/.git/config",
            "/tests/test_snapshot_features.py",
        ):
            self.assertEqual(self.status(path), 403, path)
        self.assertEqual(self.status("/src/main.js"), 200)


if __name__ == "__main__":
    unittest.main()
