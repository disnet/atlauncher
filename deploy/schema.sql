-- State for the deployed demo: the shell's account lists, the app's popup
-- relay, and the mock PDS's codes and tokens, one namespace each. See
-- lib/store.ts and deploy/d1.ts.
CREATE TABLE IF NOT EXISTS kv (
  ns TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  expires INTEGER NOT NULL,
  PRIMARY KEY (ns, key)
);
