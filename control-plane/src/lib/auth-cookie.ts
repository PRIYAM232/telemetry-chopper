// The session cookie's name, on its own so src/proxy.ts can read it without
// importing the database client along with the rest of src/lib/auth.ts.
export const SESSION_COOKIE = "chopper_session";
