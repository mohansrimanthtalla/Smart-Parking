import json
import os
import re
import secrets
import sqlite3
from datetime import date, datetime, timedelta
from pathlib import Path

from dotenv import load_dotenv
from flask import Flask, current_app, g, jsonify, request, send_from_directory, session
from werkzeug.security import check_password_hash, generate_password_hash


ROOT = Path(__file__).resolve().parent
load_dotenv(ROOT / ".env")


def _connect():
    url = current_app.config["DATABASE_URL"]
    if url.startswith("sqlite:///"):
        filename = url[len("sqlite:///"):]
        Path(filename).parent.mkdir(parents=True, exist_ok=True)
        return sqlite3.connect(filename)
    raise RuntimeError("DATABASE_URL must use a SQLite connection string (sqlite:///path/to/file.sqlite).")


def _connection():
    if "database" not in g:
        g.database = _connect()
        if isinstance(g.database, sqlite3.Connection):
            g.database.row_factory = sqlite3.Row
    return g.database


def _query(sql, parameters=()):
    return _connection().execute(sql, parameters)


def _commit():
    _connection().commit()


def _rollback():
    _connection().rollback()


def _row_dict(row):
    return dict(row) if row is not None else None


def _get_user(user_id):
    row = _query(
        "SELECT id, name, email, password_hash, role, phone FROM app_users WHERE id = ?",
        (user_id,),
    ).fetchone()
    return _row_dict(row)


def _state_record():
    row = _query("SELECT revision, data FROM parking_state WHERE id = 1").fetchone()
    if row is None:
        raise RuntimeError("Parking state is not initialized.")
    result = _row_dict(row)
    if isinstance(result["data"], str):
        result["data"] = json.loads(result["data"])
    return result


def _json_value(value):
    return json.dumps(value)


def _stamp():
    return datetime.now().astimezone().strftime("%Y-%m-%d %H:%M")


def _seed_state():
    lots = [
        {"id": 1, "name": "City Mall Parking", "addr": "MG Road, Vijayawada"},
        {"id": 2, "name": "Govt General Hospital", "addr": "Hospital Road, Guntur"},
        {"id": 3, "name": "Railway Station Lot", "addr": "Station Road, Vijayawada"},
    ]
    slots = []
    for lot in lots:
        for i in range(24):
            status_num = (i * 7 + lot["id"] * 3) % 10
            status = "O" if status_num < 4 else "M" if status_num == 9 else "A"
            if lot["id"] == 3:
                status = "O" if status_num < 9 else "M"
            slots.append({
                "id": lot["id"] * 100 + i,
                "lot": lot["id"],
                "no": "ABC"[i >> 3] + str(i % 8 + 1),
                "st": status,
            })

    bookings, payments = [], []
    types = ["Bike", "Car", "SUV"]
    prices = {"Bike": 10, "Car": 30, "SUV": 40}
    for i in range(9):
        lot_id, vehicle_type = i % 3 + 1, types[i % 3]
        hours, rate = 1 + i % 4, prices[vehicle_type]
        booked_date = (date.today() - timedelta(days=i)).isoformat()
        booking_id = f"BK{1000 + i}"
        bookings.append({
            "id": booking_id, "uid": 2, "lot": lot_id, "slot": lot_id * 100 + i,
            "plate": f"AP{10 + i} ZX {2000 + i}", "type": vehicle_type,
            "date": booked_date, "start": "10:00", "hrs": hours, "rate": rate,
            "amt": rate * hours, "status": "Completed",
        })
        payments.append({
            "ref": f"PAY{5000 + i}", "bid": booking_id, "amt": rate * hours,
            "method": ["UPI", "Card", "Cash"][i % 3], "status": "Success",
            "t": f"{booked_date} 12:00",
        })
    return {
        "vehicles": [{"id": 1, "uid": 2, "plate": "AP39 AB 1234", "type": "Car"}],
        "lots": lots,
        "slots": slots,
        "prices": prices,
        "bookings": bookings,
        "pay": payments,
        "audit": [{"t": _stamp(), "who": "System", "uid": None, "msg": "Demo data created"}],
    }


def _public_user(user):
    return {
        "id": user["id"], "name": user["name"], "email": user["email"],
        "role": user["role"], "phone": user["phone"],
    }


def _current_user():
    user_id = session.get("user_id")
    return _get_user(user_id) if user_id is not None else None


def _state_for(user, data):
    result = {key: value for key, value in data.items()}
    if user is None:
        result.update({"vehicles": [], "bookings": [], "pay": [], "audit": []})
    elif user["role"] == "driver":
        owned_bookings = [b for b in data["bookings"] if b.get("uid") == user["id"]]
        booking_ids = {b["id"] for b in owned_bookings}
        result.update({
            "vehicles": [v for v in data["vehicles"] if v.get("uid") == user["id"]],
            "bookings": owned_bookings,
            "pay": [p for p in data["pay"] if p.get("bid") in booking_ids],
            "audit": [a for a in data["audit"] if a.get("uid") == user["id"]],
        })
    result["bookingCount"] = len(data["bookings"])
    result["users"] = [_public_user(user)] if user else []
    return result


def _bad(message, status=400):
    return jsonify(error=message), status


def _body():
    body = request.get_json(silent=True)
    return body if isinstance(body, dict) else {}


def _is_int(value):
    return isinstance(value, int) and not isinstance(value, bool)


def _validate_driver_update(old, incoming, user):
    if not isinstance(incoming, dict):
        return "Invalid state payload."
    for key in ("lots", "prices"):
        if incoming.get(key) != old[key]:
            return "Drivers cannot change parking lots or prices."

    old_vehicles = {v["id"]: v for v in old["vehicles"]}
    vehicles = incoming.get("vehicles")
    if not isinstance(vehicles, list):
        return "Invalid vehicle list."
    if any(not isinstance(v, dict) or v.get("uid") != user["id"] for v in vehicles):
        return "Vehicle ownership is invalid."
    if len({v.get("id") for v in vehicles}) != len(vehicles):
        return "Vehicle IDs must be unique."
    if any(not _is_int(v.get("id")) or v.get("type") not in ("Bike", "Car", "SUV")
           or not isinstance(v.get("plate"), str) or len(v["plate"].strip()) < 4 for v in vehicles):
        return "Invalid vehicle details."
    global_plates = {
        v["plate"].casefold() for v in old["vehicles"] if v.get("uid") != user["id"]
    }
    normalized_plates = [v["plate"].casefold() for v in vehicles]
    if any(plate in global_plates for plate in normalized_plates) or len(set(normalized_plates)) != len(normalized_plates):
        return "That registration number is already in use."
    for vehicle in vehicles:
        previous = old_vehicles.get(vehicle["id"])
        if previous and previous.get("uid") != user["id"]:
            return "Vehicle ownership is invalid."

    old_bookings = {b["id"]: b for b in old["bookings"]}
    old_owned_bookings = {bid for bid, booking in old_bookings.items() if booking.get("uid") == user["id"]}
    bookings = incoming.get("bookings")
    if not isinstance(bookings, list) or any(
        not isinstance(b, dict) or b.get("uid") != user["id"] for b in bookings
    ):
        return "Booking ownership is invalid."
    if len({b.get("id") for b in bookings}) != len(bookings):
        return "Booking IDs must be unique."

    lots = {l["id"] for l in old["lots"]}
    slots = {s["id"]: s for s in old["slots"]}
    owned_vehicles = {v["plate"]: v["type"] for v in vehicles}
    booking_fields = {
        "id", "uid", "lot", "slot", "plate", "type", "date", "start",
        "hrs", "rate", "amt", "status", "cin", "ahrs", "final",
    }
    new_bookings = []
    changed_bookings = {}
    newly_reserved_slots = set()
    for booking in bookings:
        bid = booking.get("id")
        if (set(booking) - booking_fields or not isinstance(bid, str)
                or not re.fullmatch(r"BK[A-Z0-9]{4,12}", bid) or booking.get("lot") not in lots):
            return "Invalid booking."
        previous = old_bookings.get(bid)
        if previous:
            if previous.get("uid") != user["id"]:
                return "Booking ownership is invalid."
            if any(booking.get(key) != previous.get(key) for key in
                   ("id", "uid", "lot", "slot", "plate", "type", "date", "start", "hrs", "rate", "amt")):
                return "Existing booking details cannot be changed."
            allowed = {
                "Reserved": {"Reserved", "Parked", "Cancelled"},
                "Parked": {"Parked", "Payment Due", "Cancelled"},
                "Payment Due": {"Payment Due", "Completed"},
                "Completed": {"Completed"},
                "Cancelled": {"Cancelled"},
            }
            if booking.get("status") not in allowed.get(previous.get("status"), set()):
                return "Invalid booking status change."
            if booking.get("status") == "Parked":
                if any(key in booking for key in ("ahrs", "final")):
                    return "Parked booking details are invalid."
                if previous.get("status") == "Reserved":
                    if not isinstance(booking.get("cin"), str) or not booking["cin"]:
                        return "Check-in time is required."
                elif booking.get("cin") != previous.get("cin"):
                    return "Check-in time cannot be changed."
            elif booking.get("status") == "Reserved":
                if any(key in booking for key in ("cin", "ahrs", "final")):
                    return "Reserved booking details are invalid."
            elif booking.get("status") == "Payment Due":
                hours = booking.get("ahrs")
                if not _is_int(hours) or not 1 <= hours <= 72:
                    return "Parked duration is invalid."
                if booking.get("final") != booking["rate"] * hours:
                    return "Final booking amount is invalid."
                if not isinstance(booking.get("cin"), str) or booking.get("cin") != previous.get("cin"):
                    return "Check-in time cannot be changed."
                if previous.get("status") == "Payment Due" and any(
                    booking.get(key) != previous.get(key) for key in ("ahrs", "final")
                ):
                    return "Checked-out booking details cannot be changed."
            elif booking.get("status") == "Completed":
                if previous.get("status") == "Payment Due":
                    hours = booking.get("ahrs")
                    if (not _is_int(hours) or not 1 <= hours <= 72
                            or booking.get("final") != booking["rate"] * hours
                            or booking.get("cin") != previous.get("cin")):
                        return "Completed booking details are invalid."
                elif any(
                    booking.get(key) != previous.get(key) for key in ("ahrs", "final", "cin")
                ):
                    return "Completed booking details cannot be changed."
            elif any(key in booking for key in ("ahrs", "final")):
                return "Booking details are invalid."
            changed_bookings[bid] = booking
        else:
            if bid in old_bookings or booking.get("status") != "Reserved":
                return "Invalid new booking."
            if (set(booking) != booking_fields - {"cin", "ahrs", "final"}
                    or owned_vehicles.get(booking.get("plate")) != booking.get("type")
                    or booking.get("type") not in ("Bike", "Car", "SUV")
                    or booking.get("slot") not in slots
                    or not _is_int(booking.get("hrs")) or booking["hrs"] not in range(1, 73)
                    or not _is_int(booking.get("rate")) or not _is_int(booking.get("amt"))
                    or not isinstance(booking.get("start"), str)
                    or not re.fullmatch(r"(?:[01]\d|2[0-3]):[0-5]\d", booking["start"])):
                return "Booking details are invalid."
            try:
                if date.fromisoformat(booking.get("date")) < date.today():
                    return "Bookings must be for today or a future date."
            except (TypeError, ValueError):
                return "Booking date is invalid."
            slot = slots[booking["slot"]]
            if slot["lot"] != booking["lot"] or slot["st"] != "A" or slot["id"] in newly_reserved_slots:
                return "That parking slot is no longer available."
            lot_slot_ids = [s["id"] for s in old["slots"] if s["lot"] == booking["lot"]]
            occupancy = sum(slots[sid]["st"] in ("O", "R") for sid in lot_slot_ids) / max(1, len(lot_slot_ids))
            base_rate = old["prices"].get(booking["type"])
            expected_rate = round(base_rate * (1.2 if occupancy > 0.8 else 1))
            if booking.get("rate") != expected_rate or booking.get("amt") != expected_rate * booking["hrs"]:
                return "Booking price is invalid."
            new_bookings.append(booking)
            changed_bookings[bid] = booking
            newly_reserved_slots.add(slot["id"])
    if old_owned_bookings - {b["id"] for b in bookings}:
        return "Existing bookings cannot be deleted."

    old_payments = {p["ref"]: p for p in old["pay"]}
    payments = incoming.get("pay")
    if not isinstance(payments, list):
        return "Invalid payment list."
    if len({p.get("ref") for p in payments if isinstance(p, dict)}) != len(payments):
        return "Payment references must be unique."
    old_owned_payment_refs = {
        p["ref"] for p in old["pay"]
        if p.get("bid") in old_owned_bookings
    }
    if old_owned_payment_refs - {p.get("ref") for p in payments if isinstance(p, dict)}:
        return "Existing payments cannot be deleted."
    booking_map = {b["id"]: b for b in bookings}
    for payment in payments:
        if (not isinstance(payment, dict)
                or set(payment) != {"ref", "bid", "amt", "method", "status", "t"}
                or payment.get("bid") not in booking_map
                or not isinstance(payment.get("ref"), str)
                or not re.fullmatch(r"PAY[A-Z0-9]{4,12}", payment["ref"])):
            return "Payment ownership is invalid."
        booking = booking_map[payment["bid"]]
        if payment["bid"] in old_bookings and old_bookings[payment["bid"]]["uid"] != user["id"]:
            return "Payment ownership is invalid."
        previous = old_payments.get(payment.get("ref"))
        if previous:
            if payment != previous:
                return "Existing payments cannot be changed."
            continue
        if (payment.get("method") not in ("UPI", "Card", "Cash")
                or payment.get("status") not in ("Success", "Failed")
                or not _is_int(payment.get("amt"))
                or payment.get("amt") != booking.get("final", booking.get("amt"))):
            return "Payment details are invalid."
        if payment["status"] == "Success" and booking.get("status") != "Completed":
            return "A successful payment requires a completed booking."
        if payment["status"] == "Failed" and booking.get("status") != "Payment Due":
            return "A failed payment requires a payment-due booking."
        payment["t"] = _stamp()

    for booking_id, booking in changed_bookings.items():
        old_booking = old_bookings.get(booking_id)
        if old_booking and old_booking.get("status") == "Payment Due" and booking.get("status") == "Completed":
            if not any(p.get("bid") == booking_id and p.get("status") == "Success" for p in payments):
                return "A completed booking requires a successful payment."

    slot_updates = {}
    for booking_id, booking in changed_bookings.items():
        old_booking = old_bookings.get(booking_id)
        if old_booking and old_booking.get("status") == booking.get("status"):
            continue
        slot = slots.get(booking.get("slot"))
        if not slot:
            return "Booking slot does not exist."
        expected = {
            "Reserved": "R", "Parked": "O", "Payment Due": "A",
            "Completed": "A", "Cancelled": "A",
        }.get(booking.get("status"))
        slot_updates[slot["id"]] = expected
    incoming_slots = incoming.get("slots")
    if not isinstance(incoming_slots, list) or len(incoming_slots) != len(old["slots"]):
        return "Invalid slot list."
    old_slots = {s["id"]: s for s in old["slots"]}
    for slot in incoming_slots:
        if not isinstance(slot, dict) or slot.get("id") not in old_slots:
            return "Slot records cannot be added or removed by a driver."
        previous = old_slots[slot["id"]]
        if any(slot.get(k) != previous.get(k) for k in ("id", "lot", "no")):
            return "Slot details cannot be changed by a driver."
        expected_status = slot_updates.get(slot["id"], previous["st"])
        if slot.get("st") != expected_status:
            return "Slot status does not match the booking."

    old_audit = [a for a in old["audit"] if a.get("uid") == user["id"]]
    audit = incoming.get("audit")
    if not isinstance(audit, list) or len(audit) < len(old_audit):
        return "Audit history cannot be removed."
    additions = audit[:len(audit) - len(old_audit)]
    if audit[len(additions):] != old_audit or any(
        not isinstance(item, dict) or set(item) != {"t", "who", "uid", "msg"}
        or item.get("uid") != user["id"] or item.get("who") != user["name"]
        or not isinstance(item.get("t"), str)
        or not re.fullmatch(r"[A-Za-z0-9, :/.-]{1,64}", item["t"])
        or not isinstance(item.get("msg"), str) or len(item["msg"]) > 300
        for item in additions
    ):
        return "Audit entries are invalid."

    merged = dict(old)
    merged["vehicles"] = [v for v in old["vehicles"] if v.get("uid") != user["id"]] + vehicles
    merged["bookings"] = [b for b in old["bookings"] if b.get("uid") != user["id"]] + bookings
    owned_booking_ids = {b["id"] for b in bookings}
    merged["pay"] = [p for p in old["pay"] if p.get("bid") not in owned_booking_ids] + payments
    merged["slots"] = incoming_slots
    merged["audit"] = additions + old["audit"]
    return merged


def create_app(test_config=None):
    app = Flask(__name__, static_folder=None)
    default_database = f"sqlite:///{(ROOT / 'smart_parking.sqlite').as_posix()}"
    database_url = (test_config or {}).get("DATABASE_URL") or os.getenv("DATABASE_URL", default_database)
    secret_key = (test_config or {}).get("SECRET_KEY") or os.getenv("SECRET_KEY") or secrets.token_hex(32)
    app.config.update(
        DATABASE_URL=database_url,
        SECRET_KEY=secret_key,
        SESSION_COOKIE_HTTPONLY=True,
        SESSION_COOKIE_SAMESITE="Lax",
        SESSION_COOKIE_SECURE=os.getenv("SESSION_COOKIE_SECURE", "0") == "1",
        MAX_CONTENT_LENGTH=1024 * 1024,
        PERMANENT_SESSION_LIFETIME=timedelta(days=7),
    )
    if test_config:
        app.config.update(test_config)

    @app.teardown_appcontext
    def close_database(_error=None):
        connection = g.pop("database", None)
        if connection is not None:
            connection.close()

    with app.app_context():
        connection = _connection()
        connection.executescript("""
            CREATE TABLE IF NOT EXISTS app_users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                email TEXT NOT NULL UNIQUE,
                password_hash TEXT NOT NULL,
                role TEXT NOT NULL,
                phone TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS parking_state (
                id INTEGER PRIMARY KEY,
                revision INTEGER NOT NULL,
                data TEXT NOT NULL
            );
        """)
        if _query("SELECT id FROM parking_state WHERE id = 1").fetchone() is None:
            _query(
                "INSERT INTO parking_state (id, revision, data) VALUES (1, 1, ?)",
                (_json_value(_seed_state()),),
            )
        if _query("SELECT id FROM app_users LIMIT 1").fetchone() is None:
            seed_users = [
                ("Admin", "admin@parking.com", generate_password_hash("admin123"), "admin", "9000000001"),
                ("Demo Driver", "driver@parking.com", generate_password_hash("driver123"), "driver", "9000000002"),
            ]
            for name, email, password_hash, role, phone in seed_users:
                _query(
                    "INSERT INTO app_users (name, email, password_hash, role, phone) VALUES (?, ?, ?, ?, ?)",
                    (name, email, password_hash, role, phone),
                )
        _commit()

    @app.get("/")
    def index():
        return send_from_directory(ROOT, "index.html")

    @app.get("/assets/<path:filename>")
    def assets(filename):
        return send_from_directory(ROOT / "assets", filename)

    @app.get("/api/state")
    def get_state():
        record = _state_record()
        user = _current_user()
        return jsonify(state=_state_for(user, record["data"]), revision=record["revision"])

    @app.post("/api/auth/login")
    def login():
        body = _body()
        email = str(body.get("email", "")).strip().lower()
        password = body.get("password", "")
        role = body.get("role")
        user = _row_dict(_query(
            "SELECT id, name, email, password_hash, role, phone FROM app_users WHERE email = ?",
            (email,),
        ).fetchone())
        expected_role = "admin" if role == "admin-login" else "driver"
        if (not user or user["role"] != expected_role or not isinstance(password, str)
                or len(password) > 1024 or not check_password_hash(user["password_hash"], password)):
            return _bad("Wrong email or password for this login.", 401)
        session.clear()
        session.permanent = True
        session["user_id"] = user["id"]
        return jsonify(user=_public_user(user))

    @app.post("/api/auth/register")
    def register():
        body = _body()
        name = str(body.get("name", "")).strip()
        phone = str(body.get("phone", ""))
        email = str(body.get("email", "")).strip().lower()
        password = body.get("password", "")
        if not 2 <= len(name) <= 100 or not re.fullmatch(r"\d{10}", phone):
            return _bad("Enter a valid name and 10-digit phone number.")
        if len(email) > 254 or not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", email):
            return _bad("Enter a valid email address.")
        if not isinstance(password, str) or not 6 <= len(password) <= 1024:
            return _bad("Password must have at least 6 characters.")
        if _query("SELECT id FROM app_users WHERE email = ?", (email,)).fetchone() is not None:
            return _bad("This email is already registered.", 409)
        password_hash = generate_password_hash(password)
        cursor = _query(
            "INSERT INTO app_users (name, email, password_hash, role, phone) VALUES (?, ?, ?, ?, ?)",
            (name, email, password_hash, "driver", phone),
        )
        user_id = cursor.lastrowid
        _commit()
        user = _get_user(user_id)
        session.clear()
        session.permanent = True
        session["user_id"] = user["id"]
        return jsonify(user=_public_user(user)), 201

    @app.post("/api/auth/logout")
    def logout():
        session.clear()
        return "", 204

    @app.put("/api/profile")
    def update_profile():
        user = _current_user()
        if not user:
            return _bad("Please log in again.", 401)
        body = _body()
        name, phone = str(body.get("name", "")).strip(), str(body.get("phone", ""))
        if not 2 <= len(name) <= 100 or not re.fullmatch(r"\d{10}", phone):
            return _bad("Enter a valid name and 10-digit phone number.")
        _query("UPDATE app_users SET name = ?, phone = ? WHERE id = ?", (name, phone, user["id"]))
        _commit()
        user.update(name=name, phone=phone)
        return jsonify(user=_public_user(user))

    @app.post("/api/profile/password")
    def change_password():
        user = _current_user()
        if not user:
            return _bad("Please log in again.", 401)
        body = _body()
        current, new = body.get("current", ""), body.get("new", "")
        if not isinstance(current, str) or not check_password_hash(user["password_hash"], current):
            return _bad("Current password is wrong.")
        if not isinstance(new, str) or not 6 <= len(new) <= 1024:
            return _bad("Use at least 6 characters.")
        _query("UPDATE app_users SET password_hash = ? WHERE id = ?",
               (generate_password_hash(new), user["id"]))
        _commit()
        return jsonify(ok=True)

    @app.put("/api/state")
    def put_state():
        user = _current_user()
        if not user:
            return _bad("Please log in again.", 401)
        body = _body()
        revision = body.get("revision")
        incoming = body.get("state")
        if not _is_int(revision) or not isinstance(incoming, dict):
            return _bad("Invalid state update.")
        _connection().execute("BEGIN IMMEDIATE")
        record = _state_record()
        if revision != record["revision"]:
            _rollback()
            return _bad("The data changed in another session. Refresh and try again.", 409)
        if user["role"] == "admin":
            for key in ("vehicles", "lots", "slots", "prices", "bookings", "pay", "audit"):
                if not isinstance(incoming.get(key), (dict, list)):
                    return _bad("Invalid state update.")
            if not isinstance(incoming.get("vehicles"), list) or not isinstance(incoming.get("lots"), list):
                return _bad("Invalid state update.")
            if not isinstance(incoming.get("slots"), list) or not isinstance(incoming.get("bookings"), list):
                return _bad("Invalid state update.")
            if not isinstance(incoming.get("pay"), list) or not isinstance(incoming.get("audit"), list):
                return _bad("Invalid state update.")
            if not isinstance(incoming.get("prices"), dict) or any(
                not isinstance(incoming["prices"].get(kind), (int, float)) or incoming["prices"][kind] <= 0
                for kind in ("Bike", "Car", "SUV")
            ):
                return _bad("Invalid price list.")
            new_data = {key: incoming[key] for key in ("vehicles", "lots", "slots", "prices", "bookings", "pay", "audit")}
        else:
            new_data = _validate_driver_update(record["data"], incoming, user)
            if isinstance(new_data, str):
                return _bad(new_data)
        next_revision = record["revision"] + 1
        cursor = _query(
            "UPDATE parking_state SET data = ?, revision = ? WHERE id = ? AND revision = ?",
            (_json_value(new_data), next_revision, 1, revision),
        )
        if cursor.rowcount != 1:
            _rollback()
            return _bad("The data changed in another session. Refresh and try again.", 409)
        _commit()
        return jsonify(revision=next_revision)

    @app.errorhandler(413)
    def request_too_large(_error):
        return _bad("Request is too large.", 413)

    return app


if __name__ == "__main__":
    application = create_app()
    application.run(host="127.0.0.1", port=int(os.getenv("PORT", "5000")),
                    debug=os.getenv("FLASK_DEBUG", "0") == "1")
