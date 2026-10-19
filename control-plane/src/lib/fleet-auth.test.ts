import * as crypto from "node:crypto";
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { authenticateFleet } from "@/lib/fleet-auth";
import { createFleet } from "@test/db";
import { fleetRequest } from "@test/request";

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return { ...actual, timingSafeEqual: vi.fn(actual.timingSafeEqual) };
});

async function failure(result: Awaited<ReturnType<typeof authenticateFleet>>) {
  if (result.ok) throw new Error("expected authentication to fail");
  const { response } = result;
  return {
    status: response.status,
    headers: Object.fromEntries(response.headers),
    body: await response.text(),
  };
}

describe("authenticateFleet", () => {
  it("accepts the fleet's own key", async () => {
    const fleet = await createFleet();
    const result = await authenticateFleet(fleetRequest("/", { apiKey: fleet.apiKey }), fleet.id);
    expect(result).toEqual({ ok: true, fleetId: fleet.id });
  });

  it("accepts any capitalization of the Bearer scheme", async () => {
    const fleet = await createFleet();
    const request = fleetRequest("/", { headers: { authorization: `bearer ${fleet.apiKey}` } });
    expect((await authenticateFleet(request, fleet.id)).ok).toBe(true);
  });

  it("answers an unknown fleet exactly like a wrong key", async () => {
    const fleet = await createFleet();
    const wrongKey = await failure(
      await authenticateFleet(fleetRequest("/", { apiKey: `${fleet.apiKey}x` }), fleet.id),
    );
    const unknownFleet = await failure(
      await authenticateFleet(fleetRequest("/", { apiKey: fleet.apiKey }), randomUUID()),
    );

    expect(wrongKey.status).toBe(401);
    expect(wrongKey.headers["www-authenticate"]).toBe("Bearer");
    expect(unknownFleet).toEqual(wrongKey);
  });

  it("rejects another fleet's key", async () => {
    const [a, b] = [await createFleet("a"), await createFleet("b")];
    const result = await authenticateFleet(fleetRequest("/", { apiKey: b.apiKey }), a.id);
    expect((await failure(result)).status).toBe(401);
  });

  it.each([
    ["no Authorization header", {}],
    ["a non-Bearer scheme", { authorization: "Basic Zm9vOmJhcg==" }],
    ["an empty Bearer token", { authorization: "Bearer " }],
  ])("returns 401 for %s", async (_, headers) => {
    const fleet = await createFleet();
    const result = await authenticateFleet(fleetRequest("/", { headers }), fleet.id);
    expect((await failure(result)).status).toBe(401);
  });

  it("returns 400 for a fleetId that isn't a UUID, before touching credentials", async () => {
    const result = await authenticateFleet(fleetRequest("/", { apiKey: "anything" }), "not-a-uuid");
    const { status, body } = await failure(result);
    expect(status).toBe(400);
    expect(JSON.parse(body)).toEqual({ error: "fleetId must be a UUID" });
  });

  it("compares same-length keys with timingSafeEqual", async () => {
    const fleet = await createFleet();
    const spy = vi.mocked(crypto.timingSafeEqual);
    spy.mockClear();
    // Same length as the real key, last character different.
    const wrong = fleet.apiKey.slice(0, -1) + (fleet.apiKey.endsWith("0") ? "1" : "0");

    const result = await authenticateFleet(fleetRequest("/", { apiKey: wrong }), fleet.id);

    expect(result.ok).toBe(false);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("rejects a key of a different length without throwing", async () => {
    const fleet = await createFleet();
    const result = await authenticateFleet(fleetRequest("/", { apiKey: "short" }), fleet.id);
    expect((await failure(result)).status).toBe(401);
  });
});
