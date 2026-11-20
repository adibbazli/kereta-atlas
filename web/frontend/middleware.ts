// Vercel Routing Middleware: forwards /api/* and /do/* to the Flask backend named by the
// BACKEND_SERVER env var (e.g. https://backend.example.com). Locally, vite.config.ts's dev
// proxy does the same job; this file is only used on Vercel.

export const config = {
  matcher: ["/api/:path*", "/do/:path*"],
};

// Hop-by-hop / transport headers that must not be copied between connections.
const STRIP_REQUEST = ["host", "connection", "content-length", "accept-encoding"];
// fetch() already decoded the body, so the original encoding/length no longer apply.
const STRIP_RESPONSE = ["content-encoding", "content-length", "transfer-encoding", "connection"];

export default async function middleware(request: Request): Promise<Response> {
  const backend = process.env.BACKEND_SERVER;
  if (!backend) return new Response("BACKEND_SERVER is not set", { status: 500 });

  const url = new URL(request.url);
  const target = new URL(url.pathname + url.search, backend);

  const headers = new Headers(request.headers);
  for (const h of STRIP_REQUEST) headers.delete(h);
  headers.set("x-forwarded-host", url.host);
  headers.set("x-forwarded-proto", url.protocol.replace(":", ""));

  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  const upstream = await fetch(target, {
    method: request.method,
    headers,
    body: hasBody ? await request.arrayBuffer() : undefined,
    redirect: "manual", // let the browser see backend redirects (and their Set-Cookie)
  });

  const resHeaders = new Headers(upstream.headers);
  for (const h of STRIP_RESPONSE) resHeaders.delete(h);
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: resHeaders,
  });
}
