// Builds the arguments the App Router passes to a route handler, so tests can
// call GET/POST directly.

import { NextRequest } from "next/server";

export function fleetRequest(
  path: string,
  options: { apiKey?: string; method?: string; headers?: Record<string, string>; body?: unknown } = {},
): NextRequest {
  const headers = new Headers(options.headers);
  if (options.apiKey !== undefined) headers.set("authorization", `Bearer ${options.apiKey}`);
  let body: string | undefined;
  if (options.body !== undefined) {
    body = typeof options.body === "string" ? options.body : JSON.stringify(options.body);
    headers.set("content-type", "application/json");
  }
  return new NextRequest(new URL(path, "http://localhost:3000"), {
    method: options.method ?? "GET",
    headers,
    body,
  });
}

export function fleetParams(fleetId: string) {
  return { params: Promise.resolve({ fleetId }) };
}
