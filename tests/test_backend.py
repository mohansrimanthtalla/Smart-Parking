import sqlite3
import tempfile
import unittest
from pathlib import Path
from datetime import date
from unittest.mock import patch

from backend import create_app


class BackendTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        database_path = (Path(self.temp_dir.name) / "test.sqlite").as_posix()
        self.app = create_app({
            "TESTING": True,
            "DATABASE_URL": f"sqlite:///{database_path}",
            "SECRET_KEY": "test-secret",
            "SESSION_COOKIE_SECURE": False,
        })
        self.client = self.app.test_client()

    def tearDown(self):
        self.temp_dir.cleanup()

    def test_public_state_does_not_expose_accounts_or_bookings(self):
        response = self.client.get("/api/state")
        self.assertEqual(response.status_code, 200)
        data = response.get_json()
        self.assertEqual(data["state"]["users"], [])
        self.assertEqual(data["state"]["bookings"], [])
        self.assertNotIn("pw", data["state"])
        self.assertEqual(data["state"]["bookingCount"], 9)

    def test_login_returns_role_scoped_state_and_hash_is_not_exposed(self):
        response = self.client.post("/api/auth/login", json={
            "email": "driver@parking.com",
            "password": "driver123",
            "role": "login",
        })
        self.assertEqual(response.status_code, 200)
        state = self.client.get("/api/state").get_json()["state"]
        self.assertEqual(state["users"][0]["role"], "driver")
        self.assertEqual(len(state["bookings"]), 9)
        self.assertNotIn("password_hash", state["users"][0])

    def test_driver_cannot_change_lots_and_can_add_owned_vehicle(self):
        self.client.post("/api/auth/login", json={
            "email": "driver@parking.com",
            "password": "driver123",
            "role": "login",
        })
        response = self.client.get("/api/state").get_json()
        state = response["state"]
        state["lots"][0]["name"] = "Tampered lot"
        denied = self.client.put("/api/state", json={
            "revision": response["revision"], "state": state,
        })
        self.assertEqual(denied.status_code, 400)

        response = self.client.get("/api/state").get_json()
        state = response["state"]
        owner_id = state["users"][0]["id"]
        state["vehicles"].append({
            "id": 99, "uid": owner_id, "plate": "AP10 XY 1234", "type": "Bike",
        })
        saved = self.client.put("/api/state", json={
            "revision": response["revision"], "state": state,
        })
        self.assertEqual(saved.status_code, 200, saved.get_json())
        self.assertEqual(len(self.client.get("/api/state").get_json()["state"]["vehicles"]), 2)

    def test_state_revision_rejects_stale_write(self):
        self.client.post("/api/auth/login", json={
            "email": "admin@parking.com",
            "password": "admin123",
            "role": "admin-login",
        })
        response = self.client.get("/api/state").get_json()
        state = response["state"]
        state["prices"]["Bike"] = 12
        first = self.client.put("/api/state", json={
            "revision": response["revision"], "state": state,
        })
        self.assertEqual(first.status_code, 200)
        stale = self.client.put("/api/state", json={
            "revision": response["revision"], "state": state,
        })
        self.assertEqual(stale.status_code, 409)

    def test_driver_can_reserve_and_check_in(self):
        self.client.post("/api/auth/login", json={
            "email": "driver@parking.com",
            "password": "driver123",
            "role": "login",
        })
        response = self.client.get("/api/state").get_json()
        state = response["state"]
        user = state["users"][0]
        slot = next(slot for slot in state["slots"] if slot["st"] == "A")
        base_rate = state["prices"]["Car"]
        occupancy = sum(
            item["st"] in ("O", "R") for item in state["slots"] if item["lot"] == slot["lot"]
        ) / sum(item["lot"] == slot["lot"] for item in state["slots"])
        rate = round(base_rate * (1.2 if occupancy > 0.8 else 1))
        booking = {
            "id": "BKTEST01", "uid": user["id"], "lot": slot["lot"], "slot": slot["id"],
            "plate": "AP39 AB 1234", "type": "Car", "date": date.today().isoformat(),
            "start": "10:00", "hrs": 2, "rate": rate, "amt": rate * 2, "status": "Reserved",
        }
        state["bookings"].append(booking)
        slot["st"] = "R"
        state["audit"].insert(0, {
            "t": "2026-01-01 10:00", "who": user["name"], "uid": user["id"],
            "msg": "Booking created",
        })
        saved = self.client.put("/api/state", json={
            "revision": response["revision"], "state": state,
        })
        self.assertEqual(saved.status_code, 200, saved.get_json())

        response = self.client.get("/api/state").get_json()
        state = response["state"]
        booking = next(item for item in state["bookings"] if item["id"] == "BKTEST01")
        booking.update(status="Parked", cin="2026-01-01 10:10")
        next(item for item in state["slots"] if item["id"] == slot["id"])["st"] = "O"
        state["audit"].insert(0, {
            "t": "2026-01-01 10:10", "who": user["name"], "uid": user["id"],
            "msg": "Checked in",
        })
        saved = self.client.put("/api/state", json={
            "revision": response["revision"], "state": state,
        })
        self.assertEqual(saved.status_code, 200, saved.get_json())

        response = self.client.get("/api/state").get_json()
        state = response["state"]
        booking = next(item for item in state["bookings"] if item["id"] == "BKTEST01")
        booking.update(status="Payment Due", ahrs=2, final=rate * 2)
        next(item for item in state["slots"] if item["id"] == slot["id"])["st"] = "A"
        state["audit"].insert(0, {
            "t": "2026-01-01 11:00", "who": user["name"], "uid": user["id"],
            "msg": "Checked out",
        })
        saved = self.client.put("/api/state", json={
            "revision": response["revision"], "state": state,
        })
        self.assertEqual(saved.status_code, 200, saved.get_json())

        response = self.client.get("/api/state").get_json()
        state = response["state"]
        state["pay"].append({
            "ref": "PAYTEST01", "bid": "BKTEST01", "amt": rate * 2,
            "method": "UPI", "status": "Failed", "t": "test",
        })
        saved = self.client.put("/api/state", json={
            "revision": response["revision"], "state": state,
        })
        self.assertEqual(saved.status_code, 200, saved.get_json())

        response = self.client.get("/api/state").get_json()
        state = response["state"]
        booking = next(item for item in state["bookings"] if item["id"] == "BKTEST01")
        booking["status"] = "Completed"
        state["pay"].append({
            "ref": "PAYTEST02", "bid": "BKTEST01", "amt": rate * 2,
            "method": "Card", "status": "Success", "t": "test",
        })
        saved = self.client.put("/api/state", json={
            "revision": response["revision"], "state": state,
        })
        self.assertEqual(saved.status_code, 200, saved.get_json())

    def test_registration_hashes_password(self):
        response = self.client.post("/api/auth/register", json={
            "name": "New Driver",
            "phone": "9123456789",
            "email": "new@example.com",
            "password": "secure123",
        })
        self.assertEqual(response.status_code, 201)
        database_path = Path(self.temp_dir.name) / "test.sqlite"
        connection = sqlite3.connect(database_path)
        try:
            user = connection.execute(
                "SELECT password_hash FROM app_users WHERE email = ?",
                ("new@example.com",),
            ).fetchone()
            state = connection.execute("SELECT id FROM parking_state WHERE id = 1").fetchone()
        finally:
            connection.close()
        self.assertNotEqual(user[0], "secure123")
        self.assertIsNotNone(state)

    def test_default_database_is_local_sqlite(self):
        with patch("backend.ROOT", Path(self.temp_dir.name)):
            app = create_app({"TESTING": True, "SECRET_KEY": "test-secret"})
            self.assertTrue(app.config["DATABASE_URL"].endswith("smart_parking.sqlite"))
            response = app.test_client().get("/api/state")
            self.assertEqual(response.status_code, 200)
            self.assertTrue((Path(self.temp_dir.name) / "smart_parking.sqlite").exists())


if __name__ == "__main__":
    unittest.main()
