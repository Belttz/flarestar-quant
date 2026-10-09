-- Cloud deployment authentication: single-row table holding the terminal
-- operator's login (scrypt password hash + per-user random salt). The plaintext
-- password is never stored; bootstrap seeding happens in auth-store.ts.
CREATE TABLE auth_user (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  username TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
