export default {
  async fetch(request, env) {
    /* ---------- BASIC AUTH ---------- */
    const auth = request.headers.get("Authorization");
    if (!auth || !checkAuth(auth, env)) {
      return new Response("Unauthorized", {
        status: 401,
        headers: {
          "WWW-Authenticate": 'Basic realm="Zotero WebDAV"',
        },
      });
    }

    const url = new URL(request.url);

    if (!url.pathname.startsWith("/zotero/")) {
      return new Response("Not Found", { status: 404 });
    }

    const path = decodeURIComponent(
      url.pathname.replace(/^\/zotero\//, "").replace(/^\/+/, "")
    );

    const method = request.method;

    /* ---------- ROUTING ---------- */
    switch (method) {
      case "GET":
      case "HEAD":
        return handleGetHead(env, path, method);

      case "PUT":
        return handlePut(env, path, request);

      case "MOVE":
        return handleMove(env, path, request);

      case "COPY":
        return handleCopy(env, path, request);

      case "DELETE":
        return handleDelete(env, path);

      case "MKCOL":
        return handleMkcol(env, path);

      case "PROPFIND":
        return handlePropfind(env, path, request);

      case "OPTIONS":
        return handleOptions();

      default:
        return new Response("Method Not Allowed", { status: 405 });
    }
  },
};

/* ---------- AUTH ---------- */

function checkAuth(authHeader, env) {
  if (!authHeader.startsWith("Basic ")) return false;

  const encoded = authHeader.slice(6);
  let decoded;
  try {
    decoded = atob(encoded);
  } catch {
    return false;
  }

  const sep = decoded.indexOf(":");
  if (sep === -1) return false;

  const user = decoded.slice(0, sep);
  const pass = decoded.slice(sep + 1);

  return user === env.WEBDAV_USER && pass === env.WEBDAV_PASS;
}

/* ---------- HANDLERS ---------- */

async function handleGetHead(env, key, method) {
  const obj = await env.BUCKET.get(key);
  if (!obj) return new Response("Not Found", { status: 404 });

  const headers = new Headers();
  headers.set("Content-Length", obj.size);
  headers.set("ETag", obj.etag);

  if (method === "HEAD") {
    return new Response(null, { headers });
  }

  return new Response(obj.body, { headers });
}

async function handlePut(env, key, request) {
  await env.BUCKET.put(key, request.body);
  return new Response(null, { status: 201 });
}

async function handleMove(env, srcKey, request) {
  const dest = request.headers.get("Destination");
  if (!dest) {
    return new Response("Bad Request", { status: 400 });
  }

  const destUrl = new URL(dest);
  if (!destUrl.pathname.startsWith("/zotero/")) {
    return new Response("Forbidden", { status: 403 });
  }

  const destKey = decodeURIComponent(
    destUrl.pathname.replace(/^\/zotero\//, "").replace(/^\/+/, "")
  );

  const obj = await env.BUCKET.get(srcKey);
  if (!obj) {
    return new Response("Not Found", { status: 404 });
  }

  await env.BUCKET.put(destKey, obj.body, {
    httpMetadata: obj.httpMetadata,
  });

  await env.BUCKET.delete(srcKey);

  return new Response(null, { status: 201 });
}

async function handleCopy(env, srcKey, request) {
  const dest = request.headers.get("Destination");
  if (!dest) {
    return new Response("Bad Request", { status: 400 });
  }

  const destUrl = new URL(dest);
  if (!destUrl.pathname.startsWith("/zotero/")) {
    return new Response("Forbidden", { status: 403 });
  }

  const destKey = decodeURIComponent(
    destUrl.pathname.replace(/^\/zotero\//, "").replace(/^\/+/, "")
  );

  const obj = await env.BUCKET.get(srcKey);
  if (!obj) {
    return new Response("Not Found", { status: 404 });
  }

  await env.BUCKET.put(destKey, obj.body, {
    httpMetadata: obj.httpMetadata,
  });

  return new Response(null, { status: 201 });
}

async function handleDelete(env, key) {
  await env.BUCKET.delete(key);
  return new Response(null, { status: 204 });
}

async function handleMkcol(env, key) {
  /* WebDAV collections are virtual in R2.
     Zotero only checks that MKCOL succeeds. */
  return new Response(null, { status: 201 });
}

/* ---------- PROPFIND ---------- */

async function handlePropfind(env, path, request) {
  const depth = request.headers.get("Depth") || "0";
  const baseUrl = new URL(request.url);

  const responses = [];

  // Normalize
  const prefix = path.endsWith("/") ? path : path + "/";

  // Depth 0: just the requested resource
  if (depth === "0") {
    const obj = path ? await env.BUCKET.get(path) : null;

    responses.push(
      buildPropResponse({
        href: baseUrl.pathname,
        isCollection: !obj,
        obj,
      })
    );
  } else {
    // Depth 1: list children
    const list = await env.BUCKET.list({ prefix });

    // Parent collection
    responses.push(
      buildPropResponse({
        href: baseUrl.pathname.endsWith("/")
          ? baseUrl.pathname
          : baseUrl.pathname + "/",
        isCollection: true,
      })
    );

    for (const o of list.objects) {
      responses.push(
        buildPropResponse({
          href: new URL("/zotero/" + o.key, baseUrl).pathname,
          isCollection: false,
          obj: o,
        })
      );
    }
  }

  return new Response(
    `<?xml version="1.0" encoding="UTF-8"?>
<d:multistatus xmlns:d="DAV:">
${responses.join("\n")}
</d:multistatus>`,
    {
      status: 207,
      headers: {
        "Content-Type": "application/xml; charset=utf-8",
      },
    }
  );
}

function buildPropResponse({ href, isCollection, obj }) {
  const lastModified = obj?.uploaded
    ? new Date(obj.uploaded).toUTCString()
    : new Date().toUTCString();

  return `
  <d:response>
    <d:href>${href}</d:href>
    <d:propstat>
      <d:prop>
        <d:resourcetype>
          ${isCollection ? "<d:collection/>" : ""}
        </d:resourcetype>
        ${obj ? `<d:getcontentlength>${obj.size}</d:getcontentlength>` : ""}
        ${obj ? `<d:getetag>"${obj.etag}"</d:getetag>` : ""}
        <d:getlastmodified>${lastModified}</d:getlastmodified>
      </d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>`;
}

/* ---------- OPTIONS ---------- */

function handleOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      Allow: "OPTIONS, GET, HEAD, PUT, DELETE, MKCOL, PROPFIND, MOVE, COPY",
      DAV: "1,2",
      "MS-Author-Via": "DAV",
    },
  });
}

/* ---------- XML ---------- */

function buildPropfindResponse(items, baseUrl) {
  const responses = items
    .map(
      (item) => `
    <d:response>
      <d:href>${new URL(item.key, baseUrl).pathname}</d:href>
      <d:propstat>
        <d:prop>
          <d:resourcetype/>
        </d:prop>
        <d:status>HTTP/1.1 200 OK</d:status>
      </d:propstat>
    </d:response>
  `
    )
    .join("");

  return `<?xml version="1.0" encoding="UTF-8"?>
  <d:multistatus xmlns:d="DAV:">
    ${responses}
  </d:multistatus>`;
}
