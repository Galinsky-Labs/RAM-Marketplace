import "server-only";
import type { NextRequest } from "next/server";

/** Read a small JSON or form body into a flat record; reports whether it was a form post. */
export async function readActionBody(request: NextRequest, maxBytes = 16_384): Promise<{ body: Record<string, unknown>; form: boolean }> {
  const type = request.headers.get("content-type") ?? "";
  if (type.includes("application/json")) {
    const text = await request.text();
    if (text.length > maxBytes) throw new Error("Request body too large");
    const value = JSON.parse(text || "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid request");
    return { body: value, form: false };
  }
  const data = await request.formData();
  const body: Record<string, unknown> = {};
  for (const [key, value] of data.entries()) if (typeof value === "string") body[key] = value;
  return { body, form: true };
}

export function errorStatus(message: string) {
  return /Authentication/.test(message) ? 401 : /Forbidden/.test(message) ? 403 : /not found/i.test(message) ? 404 : /Conflict/.test(message) ? 409 : 400;
}
