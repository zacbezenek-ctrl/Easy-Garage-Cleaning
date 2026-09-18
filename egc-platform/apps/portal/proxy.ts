import { timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";

function secureEqual(actual: string, expected: string) {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length &&
    timingSafeEqual(actualBytes, expectedBytes);
}

function unauthorized() {
  return new Response("Authentication required", {
    status: 401,
    headers: {
      "WWW-Authenticate": 'Basic realm="Easy Garage Cleaning Ops", charset="UTF-8"',
      "Cache-Control": "no-store"
    }
  });
}

export function proxy(request: NextRequest) {
  const expectedUser = process.env.PORTAL_BASIC_USER;
  const expectedPassword = process.env.PORTAL_BASIC_PASSWORD;

  if (!expectedUser || !expectedPassword) {
    return new Response("Portal authentication is not configured", {
      status: 503,
      headers: { "Cache-Control": "no-store" }
    });
  }

  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Basic ")) return unauthorized();

  try {
    const decoded = Buffer.from(authorization.slice(6), "base64").toString("utf8");
    const separator = decoded.indexOf(":");
    if (separator < 0) return unauthorized();

    const username = decoded.slice(0, separator);
    const password = decoded.slice(separator + 1);

    if (
      !secureEqual(username, expectedUser) ||
      !secureEqual(password, expectedPassword)
    ) {
      return unauthorized();
    }
  } catch {
    return unauthorized();
  }
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"]
};
