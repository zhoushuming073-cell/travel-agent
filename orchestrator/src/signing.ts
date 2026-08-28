export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function hmacHex(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function signedHeaders(secret: string, method: string, path: string, body: string): Promise<Record<string, string>> {
  const timestamp = String(Date.now());
  const requestId = crypto.randomUUID();
  const bodyHash = await sha256Hex(body);
  const canonical = `${method.toUpperCase()}\n${path}\n${timestamp}\n${requestId}\n${bodyHash}`;
  return {
    "content-type": "application/json",
    "x-travel-timestamp": timestamp,
    "x-travel-request-id": requestId,
    "x-travel-body-sha256": bodyHash,
    "x-travel-signature": await hmacHex(secret, canonical),
  };
}

export async function verifySignedRequest(request: Request, secret: string, maxSkewMs = 300_000): Promise<boolean> {
  if (!secret) return false;
  const timestamp = request.headers.get("x-travel-timestamp") || "";
  const requestId = request.headers.get("x-travel-request-id") || "";
  const bodyHash = request.headers.get("x-travel-body-sha256") || "";
  const supplied = request.headers.get("x-travel-signature") || "";
  if (!timestamp || !requestId || !bodyHash || !supplied || Math.abs(Date.now() - Number(timestamp)) > maxSkewMs) return false;
  const body = await request.clone().text();
  if (await sha256Hex(body) !== bodyHash) return false;
  const url = new URL(request.url);
  const canonical = `${request.method.toUpperCase()}\n${url.pathname}${url.search}\n${timestamp}\n${requestId}\n${bodyHash}`;
  const expected = await hmacHex(secret, canonical);
  if (expected.length !== supplied.length) return false;
  let different = 0;
  for (let index = 0; index < expected.length; index += 1) different |= expected.charCodeAt(index) ^ supplied.charCodeAt(index);
  return different === 0;
}
