// Optimistic sign-in redirect (issue #10).
//
// A page request without a session cookie goes to /login, carrying the page
// it wanted in ?next=. This only checks that a cookie exists: whether it is
// a live session, and what its operator may do, is decided by
// requireOperator() in every page and Server Action (src/lib/auth.ts).
//
// /api/* is excluded: the collector-facing API authenticates each fleet
// with its own bearer key (src/lib/fleet-auth.ts).

import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth-cookie";

const PUBLIC_PATHS = new Set(["/login"]);

export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  if (PUBLIC_PATHS.has(pathname) || request.cookies.has(SESSION_COOKIE)) {
    return NextResponse.next();
  }

  const login = new URL("/login", request.url);
  if (pathname !== "/") login.searchParams.set("next", pathname + search);
  return NextResponse.redirect(login);
}

export const config = {
  // Everything except the API, Next.js internals and static files.
  matcher: ["/((?!api/|_next/static|_next/image|favicon\\.ico|.*\\.[a-z0-9]+$).*)"],
};
