# Smart Parking System

The vanilla HTML/CSS/JavaScript frontend is served by a Flask backend. User accounts and parking data are stored locally in SQLite, so PostgreSQL or a separate database server is not required.

## Run locally on Windows

1. In PowerShell, create and activate a virtual environment and install dependencies:

   ```powershell
   py -m venv .venv
   .\.venv\Scripts\Activate.ps1
   pip install -r requirements.txt
   ```

2. Start the app from this folder:

   ```powershell
   python backend.py
   ```

3. Open `http://127.0.0.1:5000`. Do not open `index.html` directly; API requests need to go to the Flask server.

The app creates `smart_parking.sqlite`, its database tables, and demo data on first startup. By default, the database file is in the project folder and is excluded from Git. Demo accounts:

| Role | Email | Password |
|---|---|---|
| Driver | `driver@parking.com` | `driver123` |
| Admin | `admin@parking.com` | `admin123` |

Change the demo passwords before exposing the app beyond local development.

## Configuration

By default, the app uses `smart_parking.sqlite` in the project folder and generates a temporary session-signing key when it starts. To choose another SQLite file, set `DATABASE_URL`, for example:

```text
sqlite:///C:/data/smart_parking.sqlite
```

For stable sessions across server restarts, optionally set `SECRET_KEY` to a long random value. For HTTPS deployments, set `SESSION_COOKIE_SECURE=1` and use a securely managed secret. See `.env.example` for optional settings.

## Backend API

- `GET /api/state` — public parking summary or authenticated user's data.
- `POST /api/auth/login`, `POST /api/auth/register`, `POST /api/auth/logout`
- `PUT /api/profile`, `POST /api/profile/password`
- `PUT /api/state` — saves application changes with an optimistic revision check; driver updates are scoped to their own vehicles and bookings.

Passwords are stored as salted Werkzeug hashes. The browser does not store application data in localStorage.

## Project files

- `index.html`: page shell.
- `assets/css/style.css`: styles.
- `assets/js/app.js`: screens, routing, and API integration.
- `backend.py`: Flask routes, SQLite setup/seeding, authentication, and state validation.
