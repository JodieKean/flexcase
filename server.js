import { URLSearchParams } from "node:url";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import http from "node:http";
import crypto from "node:crypto";

function loadEnvFile(filepath) {
  if (!fs.existsSync(filepath)) return;
  const content = fs.readFileSync(filepath, "utf8");
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eqIndex = line.indexOf("=");
    if (eqIndex <= 0) continue;
    const key = line.slice(0, eqIndex).trim();
    let value = line.slice(eqIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

const SHOP = process.env.SHOPIFY_SHOP;
const CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;
const API_VERSION = process.env.SHOPIFY_API_VERSION || "2026-04";
const PORT = Number(process.env.PORT || 5501);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
loadEnvFile(path.join(__dirname, ".env"));

const SHOP_FROM_ENV = process.env.SHOPIFY_SHOP || SHOP;
const CLIENT_ID_FROM_ENV = process.env.SHOPIFY_CLIENT_ID || CLIENT_ID;
const CLIENT_SECRET_FROM_ENV = process.env.SHOPIFY_CLIENT_SECRET || CLIENT_SECRET;
const API_VERSION_FROM_ENV = process.env.SHOPIFY_API_VERSION || API_VERSION;
const PORT_FROM_ENV = Number(process.env.PORT || PORT);
const CUSTOMER_ACCOUNT_CLIENT_ID = process.env.SHOPIFY_CA_CLIENT_ID || "";
const CUSTOMER_ACCOUNT_CLIENT_SECRET = process.env.SHOPIFY_CA_CLIENT_SECRET || "";
const CUSTOMER_ACCOUNT_AUTHORIZATION_ENDPOINT = process.env.SHOPIFY_CA_AUTHORIZATION_ENDPOINT || "";
const CUSTOMER_ACCOUNT_TOKEN_ENDPOINT = process.env.SHOPIFY_CA_TOKEN_ENDPOINT || "";
const CUSTOMER_ACCOUNT_SCOPES =
  process.env.SHOPIFY_CA_SCOPES || "openid email customer-account-api:full";
const CUSTOMER_ACCOUNT_REDIRECT_URI =
  process.env.SHOPIFY_CA_REDIRECT_URI ||
  `http://127.0.0.1:${PORT_FROM_ENV}/api/customer/oauth/callback`;
const CUSTOMER_ACCOUNT_LOGOUT_ENDPOINT = process.env.SHOPIFY_CA_LOGOUT_ENDPOINT || "";
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || `http://127.0.0.1:${PORT_FROM_ENV}`;
const API_ORIGIN = process.env.API_ORIGIN || `http://127.0.0.1:${PORT_FROM_ENV}`;
const CORS_ALLOWED_ORIGINS = (process.env.CORS_ALLOWED_ORIGINS || "")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);
const ALLOWED_ORIGINS = new Set([FRONTEND_ORIGIN, ...CORS_ALLOWED_ORIGINS]);

if (!SHOP_FROM_ENV || !CLIENT_ID_FROM_ENV || !CLIENT_SECRET_FROM_ENV) {
  console.error(
    "Missing Shopify env vars. Set SHOPIFY_SHOP, SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET."
  );
}

let cachedToken = "";
let tokenExpiresAt = 0;
const STOREFRONT_ACCESS_TOKEN = process.env.SHOPIFY_STOREFRONT_ACCESS_TOKEN || "";
const oauthStateStore = new Map();
const customerSessions = new Map();

async function getAccessToken() {
  if (cachedToken && Date.now() < tokenExpiresAt - 60_000) return cachedToken;

  const response = await fetch(`https://${SHOP_FROM_ENV}.myshopify.com/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: CLIENT_ID_FROM_ENV,
      client_secret: CLIENT_SECRET_FROM_ENV,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Token request failed (${response.status}): ${body}`);
  }

  const json = await response.json();
  if (!json.access_token) throw new Error("No access token returned.");

  cachedToken = json.access_token;
  tokenExpiresAt = Date.now() + Number(json.expires_in || 86399) * 1000;
  return cachedToken;
}

async function adminGraphql(query, variables = {}) {
  const token = await getAccessToken();
  const response = await fetch(
    `https://${SHOP_FROM_ENV}.myshopify.com/admin/api/${API_VERSION_FROM_ENV}/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": token,
      },
      body: JSON.stringify({ query, variables }),
    }
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GraphQL request failed (${response.status}): ${body}`);
  }

  const payload = await response.json();
  if (payload.errors?.length) {
    throw new Error(payload.errors.map((e) => e.message).join(", "));
  }
  return payload.data;
}

async function storefrontGraphql(query, variables = {}) {
  if (!STOREFRONT_ACCESS_TOKEN) {
    throw new Error(
      "Missing SHOPIFY_STOREFRONT_ACCESS_TOKEN. Add a Storefront API access token to .env."
    );
  }

  const response = await fetch(
    `https://${SHOP_FROM_ENV}.myshopify.com/api/${API_VERSION_FROM_ENV}/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Storefront-Access-Token": STOREFRONT_ACCESS_TOKEN,
      },
      body: JSON.stringify({ query, variables }),
    }
  );

  if (!response.ok) {
    const body = await response.text();
    let parsed = null;
    try {
      parsed = JSON.parse(body);
    } catch (_) {
      parsed = null;
    }
    const errorCode = parsed?.errors?.[0]?.extensions?.code || "";
    if (response.status === 401 || errorCode === "UNAUTHORIZED") {
      throw new Error(
        "Storefront access token is unauthorized. Regenerate SHOPIFY_STOREFRONT_ACCESS_TOKEN from Shopify app Storefront API credentials, enable customer scopes (unauthenticated_read_customers and unauthenticated_write_customers), update .env, then restart server."
      );
    }
    throw new Error(`Storefront GraphQL request failed (${response.status}): ${body}`);
  }

  const payload = await response.json();
  if (payload.errors?.length) {
    const firstCode = payload.errors?.[0]?.extensions?.code || "";
    if (firstCode === "UNAUTHORIZED") {
      throw new Error(
        "Storefront access token is unauthorized. Regenerate SHOPIFY_STOREFRONT_ACCESS_TOKEN from Shopify app Storefront API credentials, enable customer scopes (unauthenticated_read_customers and unauthenticated_write_customers), update .env, then restart server."
      );
    }
    throw new Error(payload.errors.map((e) => e.message).join(", "));
  }
  return payload.data;
}

function mapProduct(node) {
  const variantEdges = node.variants?.edges || [];
  const variants = variantEdges.map((edge) => edge.node);
  const featuredImage = node.featuredImage
    ? {
        url: node.featuredImage.url,
        altText: node.featuredImage.altText || node.title,
      }
    : null;

  const imageEdges = node.images?.edges || [];
  const images = imageEdges.map((edge) => ({
    url: edge.node.url,
    altText: edge.node.altText || node.title,
  }));

  return {
    id: node.id,
    handle: node.handle,
    title: node.title,
    vendor: node.vendor,
    description: node.description || "",
    totalInventory: Number(node.totalInventory || 0),
    featuredImage,
    images,
    priceRange: {
      minVariantPrice: {
        amount: variants[0]?.price || "0",
        currencyCode: variants[0]?.inventoryItem?.unitCost?.currencyCode || "USD",
      },
    },
    compareAtPriceRange: {
      minVariantPrice: {
        amount: variants[0]?.compareAtPrice || null,
        currencyCode: variants[0]?.inventoryItem?.unitCost?.currencyCode || "USD",
      },
    },
    variants: {
      nodes: variants.map((variant) => ({
        id: variant.id,
        title: variant.title,
        availableForSale: !!variant.inventoryQuantity && variant.inventoryQuantity > 0,
        quantityAvailable: Number(variant.inventoryQuantity || 0),
        price: {
          amount: variant.price || "0",
          currencyCode: variant.inventoryItem?.unitCost?.currencyCode || "USD",
        },
        compareAtPrice: variant.compareAtPrice
          ? {
              amount: variant.compareAtPrice,
              currencyCode: variant.inventoryItem?.unitCost?.currencyCode || "USD",
            }
          : null,
      })),
    },
  };
}

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function parseCookies(req) {
  const header = String(req.headers.cookie || "");
  if (!header) return {};
  const out = {};
  for (const part of header.split(";")) {
    const token = part.trim();
    const idx = token.indexOf("=");
    if (idx <= 0) continue;
    const key = token.slice(0, idx);
    const value = decodeURIComponent(token.slice(idx + 1));
    out[key] = value;
  }
  return out;
}

function createSessionCookie(sessionId, maxAgeSeconds = 60 * 60 * 24 * 30) {
  const secureSuffix = FRONTEND_ORIGIN.startsWith("https://") ? "; Secure" : "";
  return `flexcase_customer_session=${encodeURIComponent(
    sessionId
  )}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secureSuffix}`;
}

function clearSessionCookie() {
  const secureSuffix = FRONTEND_ORIGIN.startsWith("https://") ? "; Secure" : "";
  return `flexcase_customer_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secureSuffix}`;
}

function parseJwtPayload(idToken) {
  if (!idToken || typeof idToken !== "string") return null;
  const parts = idToken.split(".");
  if (parts.length < 2) return null;
  try {
    const body = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = body.padEnd(Math.ceil(body.length / 4) * 4, "=");
    const jsonText = Buffer.from(padded, "base64").toString("utf8");
    return JSON.parse(jsonText);
  } catch (_) {
    return null;
  }
}

function cleanExpiredAuthState() {
  const now = Date.now();
  for (const [key, value] of oauthStateStore.entries()) {
    if (value.expiresAt <= now) oauthStateStore.delete(key);
  }
}

function getCustomerSession(req) {
  const sid = parseCookies(req).flexcase_customer_session;
  if (!sid) return null;
  const session = customerSessions.get(sid);
  if (!session) return null;
  if (session.expiresAt && session.expiresAt <= Date.now()) {
    customerSessions.delete(sid);
    return null;
  }
  return { sid, session };
}

function applyCors(req, res) {
  const origin = String(req.headers.origin || "");
  if (!origin || !ALLOWED_ORIGINS.has(origin)) return;
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 1_000_000) {
        reject(new Error("Request body too large."));
      }
    });
    req.on("end", () => {
      if (!raw.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(new Error("Invalid JSON request body."));
      }
    });
    req.on("error", reject);
  });
}

async function handleCatalog(req, res) {
  const reqUrl = new URL(req.url, "http://localhost");
  const first = Math.min(Number(reqUrl.searchParams.get("first") || 24), 100);
  const query = `
    query Products($first: Int!) {
      products(first: $first) {
        edges {
          node {
            id
            handle
            title
            vendor
            featuredImage {
              url
              altText
            }
            variants(first: 10) {
              edges {
                node {
                  id
                  title
                  price
                  compareAtPrice
                  inventoryQuantity
                  inventoryItem {
                    unitCost {
                      currencyCode
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  `;
  try {
    const data = await adminGraphql(query, { first });
    const products =
      data?.products?.edges?.map((edge) => mapProduct(edge.node)).filter(Boolean) || [];
    json(res, 200, { products });
  } catch (error) {
    json(res, 500, { error: error.message });
  }
}

async function handleProduct(req, res, handle) {
  const query = `
    query ProductByHandle($query: String!) {
      products(first: 1, query: $query) {
        edges {
          node {
            id
            handle
            title
            vendor
            description
            totalInventory
            featuredImage {
              url
              altText
            }
            images(first: 8) {
              edges {
                node {
                  url
                  altText
                }
              }
            }
            variants(first: 50) {
              edges {
                node {
                  id
                  title
                  price
                  compareAtPrice
                  inventoryQuantity
                  selectedOptions {
                    name
                    value
                  }
                  inventoryItem {
                    unitCost {
                      currencyCode
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  `;
  try {
    const data = await adminGraphql(query, { query: `handle:${handle}` });
    const node = data?.products?.edges?.[0]?.node;
    if (!node) {
      json(res, 404, { error: "Product not found." });
      return;
    }
    json(res, 200, { product: mapProduct(node) });
  } catch (error) {
    json(res, 500, { error: error.message });
  }
}

function handleCustomerOauthStart(req, res) {
  if (
    !CUSTOMER_ACCOUNT_CLIENT_ID ||
    !CUSTOMER_ACCOUNT_AUTHORIZATION_ENDPOINT ||
    !CUSTOMER_ACCOUNT_TOKEN_ENDPOINT
  ) {
    json(res, 500, {
      error:
        "Missing Customer Account API env vars. Set SHOPIFY_CA_CLIENT_ID, SHOPIFY_CA_AUTHORIZATION_ENDPOINT, and SHOPIFY_CA_TOKEN_ENDPOINT.",
    });
    return;
  }

  const reqUrl = new URL(req.url, "http://localhost");
  const mode = reqUrl.searchParams.get("mode") === "signup" ? "signup" : "signin";
  const keep = reqUrl.searchParams.get("keep") === "1";
  const state = crypto.randomBytes(24).toString("hex");
  cleanExpiredAuthState();
  oauthStateStore.set(state, {
    mode,
    keep,
    expiresAt: Date.now() + 10 * 60_000,
  });

  const authorizeUrl = new URL(CUSTOMER_ACCOUNT_AUTHORIZATION_ENDPOINT);
  authorizeUrl.searchParams.set("client_id", CUSTOMER_ACCOUNT_CLIENT_ID);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("redirect_uri", CUSTOMER_ACCOUNT_REDIRECT_URI);
  authorizeUrl.searchParams.set("scope", CUSTOMER_ACCOUNT_SCOPES);
  authorizeUrl.searchParams.set("state", state);
  if (mode === "signup") authorizeUrl.searchParams.set("prompt", "login");

  res.writeHead(302, { Location: authorizeUrl.toString() });
  res.end();
}

async function handleCustomerOauthCallback(req, res) {
  try {
    const reqUrl = new URL(req.url, "http://localhost");
    const code = String(reqUrl.searchParams.get("code") || "");
    const state = String(reqUrl.searchParams.get("state") || "");
    if (!code || !state) {
      res.writeHead(302, {
        Location: `${FRONTEND_ORIGIN}/account.html?auth=error&message=Missing%20OAuth%20code.`,
      });
      res.end();
      return;
    }

    const stateValue = oauthStateStore.get(state);
    oauthStateStore.delete(state);
    if (!stateValue || stateValue.expiresAt <= Date.now()) {
      res.writeHead(302, {
        Location: `${FRONTEND_ORIGIN}/account.html?auth=error&message=Invalid%20OAuth%20state.`,
      });
      res.end();
      return;
    }

    const tokenBody = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: CUSTOMER_ACCOUNT_CLIENT_ID,
      code,
      redirect_uri: CUSTOMER_ACCOUNT_REDIRECT_URI,
    });
    const tokenHeaders = {
      "Content-Type": "application/x-www-form-urlencoded",
    };
    if (CUSTOMER_ACCOUNT_CLIENT_SECRET) {
      const basic = Buffer.from(
        `${CUSTOMER_ACCOUNT_CLIENT_ID}:${CUSTOMER_ACCOUNT_CLIENT_SECRET}`
      ).toString("base64");
      tokenHeaders.Authorization = `Basic ${basic}`;
    }

    const tokenResp = await fetch(CUSTOMER_ACCOUNT_TOKEN_ENDPOINT, {
      method: "POST",
      headers: tokenHeaders,
      body: tokenBody.toString(),
    });
    const raw = await tokenResp.text();
    let payload = {};
    try {
      payload = raw ? JSON.parse(raw) : {};
    } catch (_) {
      payload = {};
    }
    if (!tokenResp.ok) {
      const message = encodeURIComponent(
        payload.error_description || payload.error || `Token exchange failed (${tokenResp.status}).`
      );
      res.writeHead(302, { Location: `${FRONTEND_ORIGIN}/account.html?auth=error&message=${message}` });
      res.end();
      return;
    }

    const idPayload = parseJwtPayload(payload.id_token || "");
    const customer = {
      id: idPayload?.sub || "",
      firstName: idPayload?.given_name || "",
      lastName: idPayload?.family_name || "",
      email: idPayload?.email || "",
    };
    const sessionId = crypto.randomBytes(24).toString("hex");
    const expiresAtMs = payload.expires_in
      ? Date.now() + Number(payload.expires_in) * 1000
      : Date.now() + 12 * 60 * 60 * 1000;
    customerSessions.set(sessionId, {
      customer,
      mode: stateValue.mode,
      createdAt: Date.now(),
      expiresAt: expiresAtMs,
      token: {
        accessToken: payload.access_token || "",
        refreshToken: payload.refresh_token || "",
        idToken: payload.id_token || "",
        tokenType: payload.token_type || "",
      },
    });

    res.writeHead(302, {
      Location: `${FRONTEND_ORIGIN}/account.html?auth=success`,
      "Set-Cookie": createSessionCookie(sessionId, stateValue.keep ? 60 * 60 * 24 * 30 : 60 * 60 * 12),
    });
    res.end();
  } catch (error) {
    const message = encodeURIComponent(error.message || "OAuth callback failed.");
    res.writeHead(302, { Location: `${FRONTEND_ORIGIN}/account.html?auth=error&message=${message}` });
    res.end();
  }
}

function handleCustomerSession(req, res) {
  const current = getCustomerSession(req);
  if (!current) {
    json(res, 200, { authenticated: false });
    return;
  }
  json(res, 200, { authenticated: true, customer: current.session.customer });
}

async function handleCustomerEmailExists(req, res) {
  try {
    const reqUrl = new URL(req.url, "http://localhost");
    const email = String(reqUrl.searchParams.get("email") || "")
      .trim()
      .toLowerCase();
    if (!email) {
      json(res, 400, { error: "Email is required." });
      return;
    }

    const customer = await findCustomerByEmail(email);
    json(res, 200, {
      exists: Boolean(customer?.id),
    });
  } catch (error) {
    json(res, 500, { error: error.message });
  }
}

async function findCustomerByEmail(email) {
  const normalized = String(email || "").trim().toLowerCase();
  if (!normalized) return null;
  const query = `
    query CustomerByEmail($query: String!) {
      customers(first: 1, query: $query) {
        edges {
          node {
            id
            firstName
            lastName
            email
            phone
          }
        }
      }
    }
  `;
  const data = await adminGraphql(query, { query: `email:${normalized}` });
  return data?.customers?.edges?.[0]?.node || null;
}

async function handleCustomerPreRegister(req, res) {
  try {
    const body = await readJsonBody(req);
    const firstName = String(body.firstName || "").trim();
    const lastName = String(body.lastName || "").trim();
    const email = String(body.email || "")
      .trim()
      .toLowerCase();
    const phoneRaw = String(body.phone || "").trim();
    const phone = phoneRaw ? phoneRaw.replace(/\s+/g, "") : "";
    const acceptsMarketingEmail = Boolean(body.acceptsMarketingEmail);

    if (!firstName || !lastName || !email) {
      json(res, 400, { error: "First name, last name, and email are required." });
      return;
    }

    const existing = await findCustomerByEmail(email);
    if (existing?.id) {
      json(res, 200, { exists: true, created: false, customer: existing });
      return;
    }

    const mutation = `
      mutation CustomerCreate($input: CustomerInput!) {
        customerCreate(input: $input) {
          customer {
            id
            firstName
            lastName
            email
            phone
          }
          userErrors {
            field
            message
          }
        }
      }
    `;
    const data = await adminGraphql(mutation, {
      input: {
        firstName,
        lastName,
        email,
        phone: phone || null,
        emailMarketingConsent: acceptsMarketingEmail
          ? {
              marketingState: "SUBSCRIBED",
              marketingOptInLevel: "SINGLE_OPT_IN",
            }
          : {
              marketingState: "NOT_SUBSCRIBED",
              marketingOptInLevel: "SINGLE_OPT_IN",
            },
      },
    });
    const payload = data?.customerCreate;
    if (payload?.userErrors?.length) {
      json(res, 400, {
        error: payload.userErrors.map((e) => e.message).join(", "),
      });
      return;
    }
    if (!payload?.customer?.id) {
      json(res, 500, { error: "Unable to create customer profile." });
      return;
    }

    json(res, 200, {
      exists: false,
      created: true,
      customer: payload.customer,
    });
  } catch (error) {
    json(res, 500, { error: error.message });
  }
}

async function handleCustomerAccountData(req, res) {
  try {
    const current = getCustomerSession(req);
    if (!current?.session?.customer?.email) {
      json(res, 401, { error: "Not authenticated." });
      return;
    }
    const email = String(current.session.customer.email || "")
      .trim()
      .toLowerCase();
    if (!email) {
      json(res, 400, { error: "Authenticated customer email is missing." });
      return;
    }

    const query = `
      query CustomerAccountData($query: String!) {
        customers(first: 1, query: $query) {
          edges {
            node {
              id
              firstName
              lastName
              email
              phone
              defaultAddress {
                id
                firstName
                lastName
                address1
                address2
                city
                province
                zip
                country
              }
              addresses(first: 20) {
                edges {
                  node {
                    id
                    firstName
                    lastName
                    address1
                    address2
                    city
                    province
                    zip
                    country
                  }
                }
              }
              orders(first: 20, sortKey: PROCESSED_AT, reverse: true) {
                edges {
                  node {
                    id
                    name
                    processedAt
                    displayFinancialStatus
                    displayFulfillmentStatus
                    currentTotalPriceSet {
                      shopMoney {
                        amount
                        currencyCode
                      }
                    }
                    lineItems(first: 5) {
                      edges {
                        node {
                          title
                          quantity
                          variantTitle
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    `;
    const data = await adminGraphql(query, { query: `email:${email}` });
    const customerNode = data?.customers?.edges?.[0]?.node;
    if (!customerNode) {
      json(res, 404, { error: "Customer record not found." });
      return;
    }

    const addresses =
      customerNode.addresses?.edges?.map((edge) => edge?.node).filter(Boolean) || [];
    const defaultAddressId = customerNode.defaultAddress?.id || "";
    const orders =
      customerNode.orders?.edges?.map((edge) => edge?.node).filter(Boolean) || [];

    json(res, 200, {
      customer: {
        id: customerNode.id,
        firstName: customerNode.firstName || "",
        lastName: customerNode.lastName || "",
        email: customerNode.email || email,
        phone: customerNode.phone || "",
      },
      addresses: addresses.map((a) => ({
        id: a.id,
        firstName: a.firstName || "",
        lastName: a.lastName || "",
        address1: a.address1 || "",
        address2: a.address2 || "",
        city: a.city || "",
        province: a.province || "",
        zip: a.zip || "",
        country: a.country || "",
        isDefault: a.id === defaultAddressId,
      })),
      orders: orders.map((o) => ({
        id: o.id,
        name: o.name || "",
        processedAt: o.processedAt || "",
        financialStatus: o.displayFinancialStatus || "",
        fulfillmentStatus: o.displayFulfillmentStatus || "",
        total: o.currentTotalPriceSet?.shopMoney || null,
        items:
          o.lineItems?.edges?.map((itemEdge) => itemEdge?.node).filter(Boolean).map((item) => ({
            title: item.title || "",
            quantity: Number(item.quantity || 0),
            variantTitle: item.variantTitle || "",
          })) || [],
      })),
    });
  } catch (error) {
    json(res, 500, { error: error.message });
  }
}

function handleCustomerLogout(req, res) {
  const current = getCustomerSession(req);
  if (current?.sid) customerSessions.delete(current.sid);
  const returnTo = `${FRONTEND_ORIGIN}/account.html`;
  const location = CUSTOMER_ACCOUNT_LOGOUT_ENDPOINT
    ? `${CUSTOMER_ACCOUNT_LOGOUT_ENDPOINT}${
        CUSTOMER_ACCOUNT_LOGOUT_ENDPOINT.includes("?") ? "&" : "?"
      }post_logout_redirect_uri=${encodeURIComponent(returnTo)}`
    : returnTo;
  res.writeHead(302, {
    Location: location,
    "Set-Cookie": clearSessionCookie(),
  });
  res.end();
}

function handleCustomerLogoutApi(req, res) {
  const current = getCustomerSession(req);
  if (current?.sid) customerSessions.delete(current.sid);
  res.writeHead(200, {
    "Set-Cookie": clearSessionCookie(),
    "Content-Type": "application/json; charset=utf-8",
  });
  res.end(JSON.stringify({ ok: true }));
}

async function handleCustomerLogin(req, res) {
  const reqUrl = new URL(req.url, "http://localhost");
  const mode = reqUrl.searchParams.get("mode") === "signup" ? "signup" : "signin";
  const keep = reqUrl.searchParams.get("keep") === "1";
  res.writeHead(302, {
    Location: `${API_ORIGIN}/api/customer/oauth/start?mode=${mode}&keep=${keep ? "1" : "0"}`,
  });
  res.end();
}

async function handleCustomerRegister(req, res) {
  const reqUrl = new URL(req.url, "http://localhost");
  const keep = reqUrl.searchParams.get("keep") === "1";
  res.writeHead(302, {
    Location: `${API_ORIGIN}/api/customer/oauth/start?mode=signup&keep=${keep ? "1" : "0"}`,
  });
  res.end();
}

async function handleCustomerLoginPost(req, res) {
  try {
    await readJsonBody(req);
    json(res, 410, {
      error:
        "Direct credential login is disabled. Use OAuth login at /api/customer/oauth/start?mode=signin.",
    });
  } catch (error) {
    json(res, 500, { error: error.message });
  }
}

async function handleCustomerRegisterPost(req, res) {
  try {
    await readJsonBody(req);
    json(res, 410, {
      error:
        "Direct credential signup is disabled. Use OAuth signup at /api/customer/oauth/start?mode=signup.",
    });
  } catch (error) {
    json(res, 500, { error: error.message });
  }
}

function serveStatic(req, res) {
  const reqUrl = new URL(req.url, "http://localhost");
  let pathname = decodeURIComponent(reqUrl.pathname);
  if (pathname === "/") pathname = "/index.html";

  const safePath = path.normalize(path.join(__dirname, pathname));
  if (!safePath.startsWith(__dirname)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  if (!fs.existsSync(safePath) || fs.statSync(safePath).isDirectory()) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }

  const ext = path.extname(safePath).toLowerCase();
  const contentTypes = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
  };
  res.writeHead(200, { "Content-Type": contentTypes[ext] || "application/octet-stream" });
  fs.createReadStream(safePath).pipe(res);
}

const server = http.createServer(async (req, res) => {
  applyCors(req, res);
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const reqUrl = new URL(req.url, "http://localhost");
  if (req.method === "POST" && reqUrl.pathname === "/api/customer/register") {
    await handleCustomerRegisterPost(req, res);
    return;
  }
  if (req.method === "POST" && reqUrl.pathname === "/api/customer/login") {
    await handleCustomerLoginPost(req, res);
    return;
  }
  if (req.method === "POST" && reqUrl.pathname === "/api/customer/logout") {
    handleCustomerLogoutApi(req, res);
    return;
  }
  if (req.method === "POST" && reqUrl.pathname === "/api/customer/pre-register") {
    await handleCustomerPreRegister(req, res);
    return;
  }

  if (req.method !== "GET") {
    res.writeHead(405);
    res.end("Method Not Allowed");
    return;
  }

  if (reqUrl.pathname === "/api/health") {
    json(res, 200, {
      ok: true,
      shop: SHOP_FROM_ENV,
      apiVersion: API_VERSION_FROM_ENV,
      storefrontTokenConfigured: Boolean(STOREFRONT_ACCESS_TOKEN),
      customerAccountConfigured: Boolean(
        CUSTOMER_ACCOUNT_CLIENT_ID &&
          CUSTOMER_ACCOUNT_AUTHORIZATION_ENDPOINT &&
          CUSTOMER_ACCOUNT_TOKEN_ENDPOINT
      ),
    });
    return;
  }
  if (reqUrl.pathname === "/api/customer/oauth/start") {
    handleCustomerOauthStart(req, res);
    return;
  }
  if (reqUrl.pathname === "/api/customer/oauth/callback") {
    await handleCustomerOauthCallback(req, res);
    return;
  }
  if (reqUrl.pathname === "/api/customer/session") {
    handleCustomerSession(req, res);
    return;
  }
  if (reqUrl.pathname === "/api/customer/check-email") {
    await handleCustomerEmailExists(req, res);
    return;
  }
  if (reqUrl.pathname === "/api/customer/account-data") {
    await handleCustomerAccountData(req, res);
    return;
  }
  if (reqUrl.pathname === "/api/customer/logout") {
    handleCustomerLogout(req, res);
    return;
  }
  if (reqUrl.pathname === "/api/customer/login") {
    await handleCustomerLogin(req, res);
    return;
  }
  if (reqUrl.pathname === "/api/customer/register") {
    await handleCustomerRegister(req, res);
    return;
  }
  if (reqUrl.pathname === "/api/catalog") {
    await handleCatalog(req, res);
    return;
  }
  if (reqUrl.pathname.startsWith("/api/product/")) {
    const handle = reqUrl.pathname.replace("/api/product/", "").trim();
    await handleProduct(req, res, handle);
    return;
  }

  serveStatic(req, res);
});

server.listen(PORT_FROM_ENV, () => {
  console.log(`Flexcase server running on http://127.0.0.1:${PORT_FROM_ENV}`);
});

