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
const SESSION_SIGNING_SECRET =
  process.env.FLEXCASE_SESSION_SECRET ||
  CUSTOMER_ACCOUNT_CLIENT_SECRET ||
  CLIENT_SECRET_FROM_ENV ||
  "flexcase-dev-session-secret";
/** Session cookie + signed payload ceiling when "Keep me logged in" is unchecked. */
const SESSION_MAX_AGE_SHORT_SEC = 60 * 60 * 12;
/** When "Keep me logged in" is checked (cookie Max-Age + signed `expiresAt`). Capped at ~400d (browser norms). */
const _KEEP_ENV = Number(process.env.FLEXCASE_SESSION_KEEP_MAX_AGE_SEC);
const SESSION_MAX_AGE_KEEP_SEC =
  Number.isFinite(_KEEP_ENV) && _KEEP_ENV > 0
    ? Math.min(60 * 60 * 24 * 400, _KEEP_ENV)
    : 60 * 60 * 24 * 400;
const DEPLOY_COMMIT_SHA =
  process.env.RAILWAY_GIT_COMMIT_SHA ||
  process.env.VERCEL_GIT_COMMIT_SHA ||
  process.env.GITHUB_SHA ||
  process.env.COMMIT_SHA ||
  "";
const DEPLOY_BRANCH =
  process.env.RAILWAY_GIT_BRANCH ||
  process.env.VERCEL_GIT_COMMIT_REF ||
  process.env.GITHUB_REF_NAME ||
  process.env.BRANCH ||
  "";

if (!SHOP_FROM_ENV || !CLIENT_ID_FROM_ENV || !CLIENT_SECRET_FROM_ENV) {
  console.error(
    "Missing Shopify env vars. Set SHOPIFY_SHOP, SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET."
  );
}

let cachedToken = "";
let tokenExpiresAt = 0;
const STOREFRONT_ACCESS_TOKEN = process.env.SHOPIFY_STOREFRONT_ACCESS_TOKEN || "";
const JUDGE_ME_API_TOKEN = process.env.JUDGE_ME_API_TOKEN || "";
const JUDGE_ME_SHOP_DOMAIN =
  process.env.JUDGE_ME_SHOP_DOMAIN ||
  (SHOP_FROM_ENV
    ? String(SHOP_FROM_ENV).includes(".")
      ? String(SHOP_FROM_ENV)
      : `${String(SHOP_FROM_ENV)}.myshopify.com`
    : "");
/** Optional: paste Judge.me → Collect reviews → Review link if auto URLs fail on headless. */
const JUDGE_ME_REVIEW_LINK = String(process.env.JUDGE_ME_REVIEW_LINK || "").trim();

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

  const endpoint = `https://${SHOP_FROM_ENV}.myshopify.com/api/${API_VERSION_FROM_ENV}/graphql.json`;
  const token = String(STOREFRONT_ACCESS_TOKEN || "").trim();
  const primaryHeaderName = token.startsWith("shpat_")
    ? "Shopify-Storefront-Private-Token"
    : "X-Shopify-Storefront-Access-Token";
  const secondaryHeaderName =
    primaryHeaderName === "Shopify-Storefront-Private-Token"
      ? "X-Shopify-Storefront-Access-Token"
      : "Shopify-Storefront-Private-Token";

  async function callWithHeader(headerName) {
    return fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [headerName]: token,
      },
      body: JSON.stringify({ query, variables }),
    });
  }

  const MAX_ATTEMPTS = 3;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let response = await callWithHeader(primaryHeaderName);
    if (response.status === 401) {
      response = await callWithHeader(secondaryHeaderName);
    }

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
          "Storefront access token is unauthorized. Verify SHOPIFY_STOREFRONT_ACCESS_TOKEN belongs to this shop, then redeploy. If using a private storefront token, make sure it is the Storefront API token from your custom app."
        );
      }
      const isThrottled =
        response.status === 429 ||
        errorCode === "THROTTLED" ||
        /\bthrottled\b/i.test(body);
      if (isThrottled && attempt < MAX_ATTEMPTS) {
        const retryAfterHeader = Number(response.headers.get("retry-after") || "0");
        const waitMs =
          Number.isFinite(retryAfterHeader) && retryAfterHeader > 0
            ? Math.max(250, Math.floor(retryAfterHeader * 1000))
            : 250 * Math.pow(2, attempt - 1);
        await new Promise((resolve) => setTimeout(resolve, waitMs));
        continue;
      }
      throw new Error(`Storefront GraphQL request failed (${response.status}): ${body}`);
    }

    const payload = await response.json();
    if (payload.errors?.length) {
      const firstCode = payload.errors?.[0]?.extensions?.code || "";
      if (firstCode === "UNAUTHORIZED") {
        throw new Error(
          "Storefront access token is unauthorized. Verify SHOPIFY_STOREFRONT_ACCESS_TOKEN belongs to this shop, then redeploy. If using a private storefront token, make sure it is the Storefront API token from your custom app."
        );
      }
      const hasThrottledError = payload.errors.some((e) => {
        const code = String(e?.extensions?.code || "");
        const message = String(e?.message || "");
        return code === "THROTTLED" || /\bthrottled\b/i.test(message);
      });
      if (hasThrottledError && attempt < MAX_ATTEMPTS) {
        const waitMs = 250 * Math.pow(2, attempt - 1);
        await new Promise((resolve) => setTimeout(resolve, waitMs));
        continue;
      }
      throw new Error(payload.errors.map((e) => e.message).join(", "));
    }
    return payload.data;
  }

  throw new Error("Storefront request failed after retries.");
}

function parseShopifyTags(raw) {
  if (Array.isArray(raw)) {
    return raw.map((tag) => String(tag || "").trim()).filter(Boolean);
  }
  if (typeof raw === "string" && raw.trim()) {
    return raw.split(",").map((tag) => tag.trim()).filter(Boolean);
  }
  return [];
}

const SHOP_CURRENCY_CODE = String(process.env.SHOPIFY_CURRENCY || "MYR").trim() || "MYR";

let automaticDiscountCache = { fetchedAt: 0, byProductId: new Map() };
const AUTOMATIC_DISCOUNT_CACHE_MS = 5 * 60 * 1000;

const AUTOMATIC_DISCOUNTS_QUERY = `
  query FlexcaseAutomaticDiscounts {
    automaticDiscountNodes(first: 50) {
      edges {
        node {
          automaticDiscount {
            ... on DiscountAutomaticBasic {
              title
              status
              startsAt
              endsAt
              customerGets {
                value {
                  ... on DiscountPercentage {
                    percentage
                  }
                  ... on DiscountAmount {
                    amount {
                      amount
                      currencyCode
                    }
                  }
                }
                items {
                  ... on DiscountProducts {
                    products(first: 100) {
                      edges {
                        node {
                          id
                          handle
                        }
                      }
                    }
                  }
                  ... on DiscountCollections {
                    collections(first: 20) {
                      edges {
                        node {
                          products(first: 100) {
                            edges {
                              node {
                                id
                                handle
                              }
                            }
                          }
                        }
                      }
                    }
                  }
                  ... on AllDiscountItems {
                    allItems
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

function isDiscountActiveNow(discount) {
  if (!discount || String(discount.status || "").toUpperCase() !== "ACTIVE") return false;
  const now = Date.now();
  const starts = discount.startsAt ? Date.parse(discount.startsAt) : NaN;
  const ends = discount.endsAt ? Date.parse(discount.endsAt) : NaN;
  if (Number.isFinite(starts) && now < starts) return false;
  if (Number.isFinite(ends) && now > ends) return false;
  return true;
}

function pickBetterAutomaticDiscount(existing, next) {
  if (!existing) return next;
  if (existing.type === "percentage" && next.type === "percentage") {
    return next.percentage > existing.percentage ? next : existing;
  }
  return existing;
}

function registerDiscountForProduct(map, productId, handle, discount) {
  if (!productId && !handle) return;
  if (productId) {
    map.set(productId, pickBetterAutomaticDiscount(map.get(productId), discount));
  }
  if (handle) {
    map.set(`handle:${handle}`, pickBetterAutomaticDiscount(map.get(`handle:${handle}`), discount));
  }
}

async function getAutomaticDiscountByProductId() {
  const now = Date.now();
  if (
    automaticDiscountCache.fetchedAt &&
    now - automaticDiscountCache.fetchedAt < AUTOMATIC_DISCOUNT_CACHE_MS
  ) {
    return automaticDiscountCache.byProductId;
  }

  const map = new Map();
  try {
    const data = await adminGraphql(AUTOMATIC_DISCOUNTS_QUERY);
    const edges = data?.automaticDiscountNodes?.edges || [];
    for (const edge of edges) {
      const discount = edge?.node?.automaticDiscount;
      if (!isDiscountActiveNow(discount)) continue;

      const value = discount?.customerGets?.value;
      let parsed = null;
      if (value?.percentage != null) {
        parsed = { type: "percentage", percentage: Number(value.percentage) };
      } else if (value?.amount?.amount != null) {
        parsed = {
          type: "amount",
          amount: Number(value.amount.amount),
          currencyCode: value.amount.currencyCode || SHOP_CURRENCY_CODE,
        };
      }
      if (!parsed) continue;

      const items = discount?.customerGets?.items;
      if (items?.allItems) {
        map.set("__all__", pickBetterAutomaticDiscount(map.get("__all__"), parsed));
        continue;
      }

      for (const productEdge of items?.products?.edges || []) {
        const product = productEdge?.node;
        registerDiscountForProduct(map, product?.id, product?.handle, parsed);
      }

      for (const collectionEdge of items?.collections?.edges || []) {
        for (const productEdge of collectionEdge?.node?.products?.edges || []) {
          const product = productEdge?.node;
          registerDiscountForProduct(map, product?.id, product?.handle, parsed);
        }
      }
    }
  } catch (_) {
    /* ignore — catalog still works without automatic discounts */
  }

  automaticDiscountCache = { fetchedAt: now, byProductId: map };
  return map;
}

function applyAutomaticDiscountToPrice(priceAmount, discount) {
  const price = Number(priceAmount);
  if (!Number.isFinite(price) || price <= 0 || !discount) return null;
  if (discount.type === "percentage") {
    let pct = Number(discount.percentage || 0);
    if (pct > 0 && pct <= 1) pct *= 100;
    pct = Math.max(0, Math.min(100, pct));
    return Math.max(0, price * (1 - pct / 100));
  }
  if (discount.type === "amount") {
    const off = Math.max(0, Number(discount.amount || 0));
    return Math.max(0, price - off);
  }
  return null;
}

function resolveAutomaticDiscountForProduct(productId, handle, discountMap) {
  if (!discountMap || discountMap.size === 0) return null;
  return (
    discountMap.get(productId) ||
    discountMap.get(`handle:${handle}`) ||
    discountMap.get("__all__") ||
    null
  );
}

/** Lowest variant price; compare-at from that variant or Shopify automatic discount. */
function computeProductPriceRanges(variantNodes, productId, handle, discountMap) {
  const currencyCode = SHOP_CURRENCY_CODE;
  let minPrice = Infinity;
  let minVariant = null;

  for (const variant of variantNodes) {
    const price = Number(variant?.price || 0);
    if (!Number.isFinite(price) || price <= 0) continue;
    if (price < minPrice) {
      minPrice = price;
      minVariant = variant;
    }
  }

  if (!minVariant) {
    return {
      priceRange: { minVariantPrice: { amount: "0", currencyCode } },
      compareAtPriceRange: { minVariantPrice: null },
      onSale: false,
    };
  }

  const salePrice = Number(minVariant.price || 0);
  const compareAtRaw = minVariant.compareAtPrice ? Number(minVariant.compareAtPrice) : null;

  if (compareAtRaw && compareAtRaw > salePrice) {
    return {
      priceRange: { minVariantPrice: { amount: String(salePrice), currencyCode } },
      compareAtPriceRange: { minVariantPrice: { amount: String(compareAtRaw), currencyCode } },
      onSale: true,
      discountSource: "compare_at",
    };
  }

  const auto = resolveAutomaticDiscountForProduct(productId, handle, discountMap);
  const discounted = applyAutomaticDiscountToPrice(salePrice, auto);
  if (discounted != null && discounted < salePrice - 0.001) {
    return {
      priceRange: { minVariantPrice: { amount: discounted.toFixed(2), currencyCode } },
      compareAtPriceRange: { minVariantPrice: { amount: String(salePrice), currencyCode } },
      onSale: true,
      discountSource: "automatic",
    };
  }

  return {
    priceRange: { minVariantPrice: { amount: String(salePrice), currencyCode } },
    compareAtPriceRange: { minVariantPrice: null },
    onSale: false,
  };
}

function isActiveShopifyProduct(node) {
  return String(node?.status || "").toUpperCase() === "ACTIVE";
}

function parseShopifyResourceNumericId(gid, resource) {
  const s = String(gid || "");
  const re = new RegExp(`${resource}/(\\d+)`);
  const m = s.match(re);
  return m ? m[1] : "";
}

function judgeMeConfigured() {
  return Boolean(JUDGE_ME_API_TOKEN && JUDGE_ME_SHOP_DOMAIN);
}

async function judgeMeRequest(path, query = {}) {
  if (!judgeMeConfigured()) return null;
  const url = new URL(`https://judge.me/api/v1/${String(path).replace(/^\//, "")}`);
  url.searchParams.set("shop_domain", JUDGE_ME_SHOP_DOMAIN);
  url.searchParams.set("api_token", JUDGE_ME_API_TOKEN);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      "X-Api-Token": JUDGE_ME_API_TOKEN,
    },
  });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  if (!response.ok) {
    const msg =
      data?.error ||
      data?.message ||
      (typeof data?.raw === "string" ? data.raw.slice(0, 200) : null) ||
      `Judge.me HTTP ${response.status}`;
    throw new Error(msg);
  }
  return data;
}

async function judgeMePostJson(path, body = {}) {
  if (!judgeMeConfigured()) {
    throw new Error("Judge.me is not configured.");
  }
  const url = new URL(`https://judge.me/api/v1/${String(path).replace(/^\//, "")}`);
  const payload = { shop_domain: JUDGE_ME_SHOP_DOMAIN, ...body };
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-Api-Token": JUDGE_ME_API_TOKEN,
    },
    body: JSON.stringify(payload),
  });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  if (!response.ok) {
    const msg =
      data?.error ||
      data?.message ||
      (typeof data?.raw === "string" ? data.raw.slice(0, 200) : null) ||
      `Judge.me HTTP ${response.status}`;
    throw new Error(msg);
  }
  return data;
}

const REVIEW_MEDIA_DIR = path.join(__dirname, "data", "review-media");
const REVIEW_AUTHOR_OVERRIDES_PATH = path.join(__dirname, "data", "review-author-overrides.json");
const REVIEW_MEDIA_OVERRIDES_PATH = path.join(__dirname, "data", "review-media-overrides.json");
const REVIEW_BODY_HIDE_PATH = path.join(__dirname, "data", "review-body-hide.json");
const REVIEW_MEDIA_MAX_BYTES = 12 * 1024 * 1024;
const REVIEW_MEDIA_MAX_FILES = 2;
const REVIEW_MEDIA_ALLOWED_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
]);

function loadReviewAuthorOverrides() {
  try {
    if (!fs.existsSync(REVIEW_AUTHOR_OVERRIDES_PATH)) return {};
    const parsed = JSON.parse(fs.readFileSync(REVIEW_AUTHOR_OVERRIDES_PATH, "utf8"));
    if (!parsed || typeof parsed !== "object") return {};
    const cleaned = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (String(key).startsWith("email:")) continue;
      cleaned[key] = value;
    }
    return cleaned;
  } catch {
    return {};
  }
}

function saveReviewAuthorOverride(reviewId, displayName) {
  const id = String(reviewId || "").trim();
  const name = String(displayName || "").trim().slice(0, 120);
  if (!id || !name) return;
  const overrides = loadReviewAuthorOverrides();
  overrides[id] = name;
  fs.mkdirSync(path.dirname(REVIEW_AUTHOR_OVERRIDES_PATH), { recursive: true });
  fs.writeFileSync(REVIEW_AUTHOR_OVERRIDES_PATH, JSON.stringify(overrides, null, 2));
}

function loadReviewMediaOverrides() {
  try {
    if (!fs.existsSync(REVIEW_MEDIA_OVERRIDES_PATH)) return {};
    const parsed = JSON.parse(fs.readFileSync(REVIEW_MEDIA_OVERRIDES_PATH, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function normalizeReviewMediaBundle(value) {
  const pictures = Array.isArray(value?.pictures)
    ? value.pictures.map((url) => String(url || "").trim()).filter(Boolean)
    : [];
  return { pictures };
}

function loadReviewBodyHideIds() {
  try {
    if (!fs.existsSync(REVIEW_BODY_HIDE_PATH)) return new Set();
    const parsed = JSON.parse(fs.readFileSync(REVIEW_BODY_HIDE_PATH, "utf8"));
    const ids = Array.isArray(parsed) ? parsed : Object.keys(parsed || {});
    return new Set(ids.map((id) => String(id).trim()).filter(Boolean));
  } catch {
    return new Set();
  }
}

function saveReviewBodyHide(reviewId) {
  const id = String(reviewId || "").trim();
  if (!id) return;
  const hidden = loadReviewBodyHideIds();
  hidden.add(id);
  fs.mkdirSync(path.dirname(REVIEW_BODY_HIDE_PATH), { recursive: true });
  fs.writeFileSync(REVIEW_BODY_HIDE_PATH, JSON.stringify([...hidden], null, 2));
}

function saveReviewMediaOverride(reviewId, media = {}) {
  const id = String(reviewId || "").trim();
  const bundle = normalizeReviewMediaBundle(media);
  if (!id || !bundle.pictures.length) return;
  const overrides = loadReviewMediaOverrides();
  overrides[id] = bundle;
  fs.mkdirSync(path.dirname(REVIEW_MEDIA_OVERRIDES_PATH), { recursive: true });
  fs.writeFileSync(REVIEW_MEDIA_OVERRIDES_PATH, JSON.stringify(overrides, null, 2));
}

function mergeReviewMediaLists(primary = [], extra = []) {
  const seen = new Set();
  const merged = [];
  [...primary, ...extra].forEach((url) => {
    const value = String(url || "").trim();
    if (!value || seen.has(value)) return;
    seen.add(value);
    merged.push(value);
  });
  return merged;
}

function inferReviewMediaMimeType(mimeType, filename = "") {
  const normalized = String(mimeType || "").trim().toLowerCase();
  if (REVIEW_MEDIA_ALLOWED_TYPES.has(normalized)) return normalized;
  const ext = path.extname(filename).toLowerCase();
  const byExt = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
    ".gif": "image/gif",
  };
  return byExt[ext] || normalized;
}

function readMultipartBody(req, maxBytes = 15 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const contentType = String(req.headers["content-type"] || "");
    const boundaryMatch = contentType.match(/boundary=([^;]+)/i);
    if (!boundaryMatch) {
      reject(new Error("Expected multipart form data."));
      return;
    }
    const boundary = boundaryMatch[1].trim().replace(/^"|"$/g, "");
    const chunks = [];
    let total = 0;
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error("Upload too large."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(parseMultipartBuffer(Buffer.concat(chunks), boundary));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function parseMultipartBuffer(buffer, boundary) {
  const delimiter = Buffer.from(`--${boundary}`);
  const fields = {};
  const files = [];
  let offset = buffer.indexOf(delimiter);
  if (offset < 0) return { fields, files };

  offset += delimiter.length;
  if (buffer[offset] === 13 && buffer[offset + 1] === 10) offset += 2;
  else if (buffer[offset] === 45 && buffer[offset + 1] === 45) return { fields, files };

  while (offset < buffer.length) {
    const next = buffer.indexOf(delimiter, offset);
    const end = next < 0 ? buffer.length : next;
    let part = buffer.subarray(offset, end);
    if (part.length >= 2 && part[part.length - 2] === 13 && part[part.length - 1] === 10) {
      part = part.subarray(0, part.length - 2);
    }
    const headerEnd = part.indexOf("\r\n\r\n");
    if (headerEnd >= 0) {
      const headerText = part.subarray(0, headerEnd).toString("utf8");
      const body = part.subarray(headerEnd + 4);
      const nameMatch = headerText.match(/name="([^"]+)"/i);
      const filenameMatch = headerText.match(/filename="([^"]*)"/i);
      const typeMatch = headerText.match(/Content-Type:\s*([^\r\n]+)/i);
      const fieldName = nameMatch?.[1] || "field";
      if (filenameMatch && filenameMatch[1]) {
        files.push({
          fieldname: fieldName,
          filename: filenameMatch[1],
          mimeType: String(typeMatch?.[1] || "application/octet-stream").trim().toLowerCase(),
          buffer: body,
        });
      } else {
        fields[fieldName] = body.toString("utf8");
      }
    }
    if (next < 0) break;
    offset = next + delimiter.length;
    if (buffer[offset] === 13 && buffer[offset + 1] === 10) offset += 2;
    if (buffer[offset] === 45 && buffer[offset + 1] === 45) break;
  }
  return { fields, files };
}

function reviewMediaExtension(mimeType) {
  const map = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/gif": ".gif",
  };
  return map[mimeType] || "";
}

async function publishReviewImageToShopify(publicUrl) {
  const mutation = `
    mutation ReviewImageFileCreate($files: [FileCreateInput!]!) {
      fileCreate(files: $files) {
        files {
          fileStatus
          ... on MediaImage {
            image {
              url
            }
          }
        }
        userErrors {
          field
          message
        }
      }
    }
  `;
  const data = await adminGraphql(mutation, {
    files: [
      {
        alt: "Product review photo",
        contentType: "IMAGE",
        originalSource: publicUrl,
      },
    ],
  });
  const errors = data?.fileCreate?.userErrors || [];
  if (errors.length) {
    throw new Error(errors.map((item) => item.message).filter(Boolean).join(" ") || "Shopify file upload failed.");
  }
  const fileNode = data?.fileCreate?.files?.[0];
  const shopifyUrl = String(fileNode?.image?.url || "").trim();
  if (shopifyUrl) return shopifyUrl;
  return publicUrl;
}

async function saveReviewMediaFiles(files = []) {
  if (!files.length) {
    return { picturesForJudgeMe: [], picturesForDisplay: [] };
  }
  fs.mkdirSync(REVIEW_MEDIA_DIR, { recursive: true });
  const picturesForJudgeMe = [];
  const picturesForDisplay = [];
  for (const file of files.slice(0, REVIEW_MEDIA_MAX_FILES)) {
    if (!file?.buffer?.length) continue;
    if (file.buffer.length > REVIEW_MEDIA_MAX_BYTES) {
      throw new Error("Each photo must be 12 MB or smaller.");
    }
    const mimeType = inferReviewMediaMimeType(file.mimeType, file.filename);
    if (!REVIEW_MEDIA_ALLOWED_TYPES.has(mimeType)) {
      throw new Error("Only JPG, PNG, WebP, and GIF files are supported.");
    }
    const ext = reviewMediaExtension(mimeType) || path.extname(file.filename || "").toLowerCase();
    const filename = `${crypto.randomUUID()}${ext}`;
    const filepath = path.join(REVIEW_MEDIA_DIR, filename);
    fs.writeFileSync(filepath, file.buffer);
    const publicUrl = `${API_ORIGIN.replace(/\/$/, "")}/review-media/${filename}`;
    let remoteUrl = publicUrl;
    try {
      remoteUrl = await publishReviewImageToShopify(publicUrl);
    } catch (error) {
      console.warn("Shopify review image publish failed, using API URL:", error.message);
    }
    picturesForJudgeMe.push(remoteUrl);
    picturesForDisplay.push(publicUrl);
  }
  return {
    picturesForJudgeMe: mergeReviewMediaLists([], picturesForJudgeMe).slice(0, REVIEW_MEDIA_MAX_FILES),
    picturesForDisplay: mergeReviewMediaLists([], picturesForDisplay).slice(0, REVIEW_MEDIA_MAX_FILES),
  };
}

function serveReviewMedia(req, res, pathname) {
  const filename = path.basename(pathname.replace(/^\/review-media\//, ""));
  if (!filename || filename.includes("..")) {
    res.writeHead(400);
    res.end("Bad request");
    return;
  }
  const filepath = path.join(REVIEW_MEDIA_DIR, filename);
  if (!filepath.startsWith(REVIEW_MEDIA_DIR) || !fs.existsSync(filepath) || !fs.statSync(filepath).isFile()) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }
  const ext = path.extname(filepath).toLowerCase();
  const contentTypes = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
    ".gif": "image/gif",
  };
  res.writeHead(200, {
    "Content-Type": contentTypes[ext] || "application/octet-stream",
    "Cache-Control": "public, max-age=31536000, immutable",
  });
  fs.createReadStream(filepath).pipe(res);
}

function isPublishedJudgeMeReview(review) {
  if (!review || review.hidden) return false;
  const curated = String(review.curated || "").toLowerCase();
  return curated === "ok" || curated === "true";
}

function upgradeReviewPhotoUrl(url) {
  const value = String(url || "").trim();
  if (!value) return "";
  return value
    .replace(/\/(compact|small|thumb|mini)\//gi, "/original/")
    .replace(/_(compact|small|thumb|mini)\./gi, "_original.");
}

function normalizeReviewPictureItem(item) {
  if (!item) return null;
  if (typeof item === "string") {
    const url = String(item).trim();
    if (!url) return null;
    const full = upgradeReviewPhotoUrl(url);
    return { thumb: url, full };
  }
  const thumb = String(item.thumb || item.full || "").trim();
  const full = upgradeReviewPhotoUrl(String(item.full || item.thumb || "").trim());
  if (!thumb && !full) return null;
  return { thumb: thumb || full, full: full || thumb };
}

function mergeApiAndStoredPictures(apiPictures = [], storedPictures = []) {
  if (!apiPictures.length) return storedPictures;
  if (!storedPictures.length) return apiPictures;
  return apiPictures.map((api, index) => {
    const stored = storedPictures[index];
    if (!stored) return api;
    return {
      thumb: api.thumb || stored.thumb,
      full: stored.full || api.full,
    };
  });
}

function dedupeReviewPictureItems(items = []) {
  const seen = new Set();
  const merged = [];
  items.forEach((item) => {
    const normalized = normalizeReviewPictureItem(item);
    if (!normalized) return;
    const key = normalized.full || normalized.thumb;
    if (!key || seen.has(key)) return;
    seen.add(key);
    merged.push(normalized);
  });
  return merged;
}

function extractJudgeMePictures(review) {
  const raw = Array.isArray(review?.pictures) ? review.pictures : [];
  return dedupeReviewPictureItems(
    raw.map((pic) => {
      if (!pic) return null;
      const thumb = String(
        pic?.urls?.compact || pic?.urls?.small || pic?.urls?.huge || pic?.urls?.original || pic?.url || ""
      ).trim();
      const full = String(
        pic?.urls?.original || pic?.urls?.huge || pic?.urls?.compact || pic?.urls?.small || pic?.url || ""
      ).trim();
      if (!thumb && !full) return null;
      return {
        thumb: thumb || full,
        full: upgradeReviewPhotoUrl(full || thumb),
      };
    })
  );
}

async function enrichJudgeMeReviewDetails(rawReviews = []) {
  const list = Array.isArray(rawReviews) ? rawReviews : [];
  return Promise.all(
    list.map(async (review) => {
      const reviewId = String(review?.id || "").trim();
      if (!reviewId) return review;
      try {
        const data = await judgeMeRequest(`reviews/${reviewId}`);
        const full = data?.review || data;
        if (!full || typeof full !== "object") return review;
        return {
          ...review,
          ...full,
          pictures:
            Array.isArray(full.pictures) && full.pictures.length ? full.pictures : review.pictures,
        };
      } catch (error) {
        console.warn("Judge.me review detail lookup failed:", reviewId, error.message);
        return review;
      }
    })
  );
}

function stripJudgeMeHtml(value) {
  return String(value || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeReviewText(value) {
  return stripJudgeMeHtml(value).replace(/\s+/g, " ").trim();
}

function isGenericReviewTitle(title) {
  const value = normalizeReviewText(title).toLowerCase();
  return !value || value === "review" || value === "product review";
}

function reviewBodyForDisplay(title, body, hideBody = false) {
  if (hideBody) return "";
  const normalizedTitle = normalizeReviewText(title);
  const normalizedBody = normalizeReviewText(body);
  if (!normalizedBody) return "";
  if (isGenericReviewTitle(title)) return stripJudgeMeHtml(body);
  if (normalizedTitle && normalizedTitle === normalizedBody) return "";
  if (normalizedTitle && normalizedBody.startsWith(normalizedTitle)) {
    const remainder = normalizedBody.slice(normalizedTitle.length).trim();
    if (!remainder) return "";
  }
  return stripJudgeMeHtml(body);
}

function extractJudgeMeReviewerDisplayName(review) {
  const candidates = [
    review?.name,
    review?.reviewer_name,
    review?.public_reviewer_name,
    review?.display_name,
    review?.public_name,
    review?.customer_name,
    review?.reviewer_display_name,
    review?.reviewer?.display_name,
  ];
  for (const candidate of candidates) {
    const name = stripJudgeMeHtml(candidate);
    if (name) return name;
  }
  return "";
}

function sortJudgeMeReviewsNewestFirst(reviews = []) {
  return [...reviews].sort((a, b) => {
    const timeA = Date.parse(a?.created_at || a?.createdAt || "") || 0;
    const timeB = Date.parse(b?.created_at || b?.createdAt || "") || 0;
    if (timeB !== timeA) return timeB - timeA;
    return String(b?.id || "").localeCompare(String(a?.id || ""));
  });
}

function parseJudgeMeWidgetDisplayNames(widgetHtml, reviewIdsInOrder = []) {
  const namesByReviewId = {};
  const html = String(widgetHtml || "");
  if (!html) return namesByReviewId;

  const authors = [];
  const authorRegex = /class=["']jdgm-rev__author["'][^>]*>([^<]+)</gi;
  let authorMatch;
  while ((authorMatch = authorRegex.exec(html)) !== null) {
    const name = stripJudgeMeHtml(authorMatch[1]);
    if (name && name.toLowerCase() !== "anonymous") authors.push(name);
  }

  const idRegex = /data-review-id=["'](\d+)["']/gi;
  let idMatch;
  while ((idMatch = idRegex.exec(html)) !== null) {
    const reviewId = String(idMatch[1] || "").trim();
    if (!reviewId) continue;
    const slice = html.slice(idMatch.index, idMatch.index + 4000);
    const localAuthorMatch = slice.match(/jdgm-rev__author[^>]*>([^<]+)</i);
    if (!localAuthorMatch) continue;
    const name = stripJudgeMeHtml(localAuthorMatch[1]);
    if (!name || name.toLowerCase() === "anonymous") continue;
    namesByReviewId[reviewId] = name;
  }

  if (!Object.keys(namesByReviewId).length && authors.length) {
    const reviewIds = reviewIdsInOrder.map((id) => String(id || "").trim()).filter(Boolean);
    if (reviewIds.length === authors.length) {
      reviewIds.forEach((reviewId, index) => {
        namesByReviewId[reviewId] = authors[index];
      });
    }
  }

  return namesByReviewId;
}

function extractJudgeMeWidgetHtml(data) {
  if (!data || typeof data !== "object") return "";
  return String(
    data.widget || data.html || data.product_review || data.review_widget || data.body || ""
  ).trim();
}

async function fetchJudgeMeWidgetDisplayNames(externalId, handle = "", reviewIdsInOrder = []) {
  const merged = {};
  const attempts = [];
  const productId = String(externalId || "").trim();
  const safeHandle = String(handle || "").trim();
  if (productId) attempts.push({ external_id: productId });
  if (safeHandle) attempts.push({ handle: safeHandle });

  if (productId) {
    try {
      const productData = await judgeMeRequest("products/-1", { external_id: productId });
      const internalId = productData?.product?.id ?? productData?.id;
      if (internalId) attempts.push({ id: internalId });
    } catch (error) {
      console.warn("Judge.me product lookup for widget failed:", error.message);
    }
  }

  for (const params of attempts) {
    try {
      const data = await judgeMeRequest("widgets/product_review", {
        ...params,
        per_page: 100,
        page: 1,
      });
      const widgetHtml = extractJudgeMeWidgetHtml(data);
      const batch = parseJudgeMeWidgetDisplayNames(widgetHtml, reviewIdsInOrder);
      Object.assign(merged, batch);
      if (Object.keys(batch).length) break;
    } catch (error) {
      console.warn("Judge.me widget display names failed:", params, error.message);
    }
  }

  if (!Object.keys(merged).length) {
    console.warn("Judge.me widget returned no review display names for product", productId || safeHandle);
  }
  return merged;
}

async function fetchShopifyProductReviewDisplayNames(shopifyProductGid) {
  const productId = String(shopifyProductGid || "").trim();
  if (!productId) return [];
  const query = `
    query ProductReviewMetaobjects($first: Int!) {
      metaobjects(first: $first, type: "product_review") {
        edges {
          node {
            rating: field(key: "rating") { value }
            title: field(key: "title") { value }
            body: field(key: "body") { value }
            authorDisplayName: field(key: "author_display_name") { value }
            product: field(key: "product") { value }
          }
        }
      }
    }
  `;
  try {
    const data = await adminGraphql(query, { first: 100 });
    const edges = data?.metaobjects?.edges || [];
    return edges
      .map((edge) => edge?.node)
      .filter(Boolean)
      .map((node) => ({
        product: String(node?.product?.value || "").trim(),
        rating: String(node?.rating?.value || "").trim(),
        title: normalizeReviewText(node?.title?.value),
        body: normalizeReviewText(node?.body?.value),
        authorDisplayName: stripJudgeMeHtml(node?.authorDisplayName?.value),
      }))
      .filter((item) => item.product === productId && item.authorDisplayName);
  } catch (error) {
    console.warn("Shopify product_review metaobjects lookup failed:", error.message);
    return [];
  }
}

function matchShopifyReviewDisplayName(review, metaReviews = [], shopifyProductGid) {
  const productId = String(shopifyProductGid || "").trim();
  if (!productId) return "";
  const rating = String(Math.max(1, Math.min(5, Number(review?.rating) || 0)));
  const title = normalizeReviewText(review?.title);
  const body = normalizeReviewText(review?.body);
  const candidates = metaReviews.filter((item) => item.product === productId && item.rating === rating);
  if (!candidates.length) return "";

  let match = candidates.find((item) => item.title && title && item.title === title);
  if (!match && body) {
    match = candidates.find((item) => {
      if (!item.body) return false;
      if (body === item.body) return true;
      return body.startsWith(item.body) || item.body.startsWith(body);
    });
  }
  if (!match && candidates.length === 1) match = candidates[0];
  return match?.authorDisplayName || "";
}

async function augmentDisplayNamesFromShopifyMetaobjects(
  rawReviews = [],
  shopifyProductGid,
  displayNamesByReviewId = {}
) {
  const metaReviews = await fetchShopifyProductReviewDisplayNames(shopifyProductGid);
  if (!metaReviews.length) return displayNamesByReviewId;
  const merged = { ...displayNamesByReviewId };
  rawReviews.forEach((review) => {
    const reviewId = String(review?.id || "").trim();
    if (!reviewId || merged[reviewId]) return;
    const shopifyName = matchShopifyReviewDisplayName(review, metaReviews, shopifyProductGid);
    if (shopifyName) merged[reviewId] = shopifyName;
  });
  return merged;
}

function cacheReviewDisplayNames(displayNamesByReviewId = {}) {
  const entries = Object.entries(displayNamesByReviewId || {});
  if (!entries.length) return;
  const overrides = loadReviewAuthorOverrides();
  let changed = false;
  entries.forEach(([reviewId, name]) => {
    const id = String(reviewId || "").trim();
    const value = String(name || "").trim().slice(0, 120);
    if (!id || !value || overrides[id] === value) return;
    overrides[id] = value;
    changed = true;
  });
  if (!changed) return;
  fs.mkdirSync(path.dirname(REVIEW_AUTHOR_OVERRIDES_PATH), { recursive: true });
  fs.writeFileSync(REVIEW_AUTHOR_OVERRIDES_PATH, JSON.stringify(overrides, null, 2));
}

function buildJudgeMeDisplayNamesByReviewId(rawReviews = [], widgetNames = {}) {
  const displayNamesByReviewId = { ...widgetNames };
  rawReviews.forEach((review) => {
    const reviewId = String(review?.id || "").trim();
    if (!reviewId || displayNamesByReviewId[reviewId]) return;
    const apiName = extractJudgeMeReviewerDisplayName(review);
    if (apiName) displayNamesByReviewId[reviewId] = apiName;
  });
  return displayNamesByReviewId;
}

function resolveJudgeMeReviewAuthor(review, displayNamesByReviewId = {}, authorOverrides = {}) {
  const reviewId = String(review?.id || "").trim();
  const widgetName = reviewId ? stripJudgeMeHtml(displayNamesByReviewId[reviewId]) : "";
  const overrideName = reviewId ? stripJudgeMeHtml(authorOverrides[reviewId]) : "";
  const reviewLevelName = extractJudgeMeReviewerDisplayName(review);
  return widgetName || overrideName || reviewLevelName || "Customer";
}

async function buildJudgeMeWriteReviewUrl(handle, shopifyProductGid) {
  if (!judgeMeConfigured() || !handle) return "";
  if (JUDGE_ME_REVIEW_LINK) return JUDGE_ME_REVIEW_LINK;

  const externalId = parseShopifyResourceNumericId(shopifyProductGid, "Product");
  // Judge.me public forms resolve the shop from a Shopify URL, not the headless domain.
  const shopifyProductUrl = `https://${JUDGE_ME_SHOP_DOMAIN}/products/${encodeURIComponent(handle)}`;

  if (externalId) {
    try {
      const data = await judgeMeRequest("products/-1", { external_id: externalId });
      const product = data?.product || data;
      const direct =
        product?.review_link ||
        product?.public_review_url ||
        product?.reviews_url ||
        product?.new_review_url;
      if (direct && /^https?:\/\//i.test(String(direct))) {
        return String(direct);
      }
    } catch (error) {
      console.warn("Judge.me product lookup for review link failed:", error.message);
    }
  }

  const params = new URLSearchParams({
    shop_domain: JUDGE_ME_SHOP_DOMAIN,
    url: shopifyProductUrl,
    handle,
  });
  if (externalId) params.set("external_id", externalId);
  return `https://judge.me/reviews/new?${params.toString()}`;
}

function mapJudgeMeReviewBundle(rawReviews, handle, writeReviewUrl = "", displayNamesByReviewId = {}) {
  const authorOverrides = loadReviewAuthorOverrides();
  const mediaOverrides = loadReviewMediaOverrides();
  const bodyHideIds = loadReviewBodyHideIds();
  const items = rawReviews
    .filter(isPublishedJudgeMeReview)
    .map((review) => {
      const rating = Math.max(1, Math.min(5, Number(review.rating) || 0));
      const apiPictures = extractJudgeMePictures(review);
      const reviewId = String(review.id || "").trim();
      const storedMedia = normalizeReviewMediaBundle(reviewId && mediaOverrides[reviewId]);
      const storedPictures = dedupeReviewPictureItems(storedMedia.pictures);
      const pictures =
        apiPictures.length > 0
          ? mergeApiAndStoredPictures(apiPictures, storedPictures)
          : storedPictures;
      const author = resolveJudgeMeReviewAuthor(review, displayNamesByReviewId, authorOverrides);
      const displayTitle = stripJudgeMeHtml(review.title);
      return {
        id: review.id,
        rating,
        title: displayTitle,
        body: reviewBodyForDisplay(displayTitle, review.body, bodyHideIds.has(reviewId)),
        author,
        createdAt: review.created_at || null,
        verified: String(review.verified || "").toLowerCase() === "buyer",
        pictures,
      };
    })
    .filter((item) => item.rating > 0);

  const distribution = { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 };
  let sum = 0;
  items.forEach((item) => {
    sum += item.rating;
    distribution[item.rating] = (distribution[item.rating] || 0) + 1;
  });
  const count = items.length;
  const averageRating = count ? Math.round((sum / count) * 10) / 10 : null;

  return {
    configured: judgeMeConfigured(),
    averageRating,
    count,
    distribution,
    items,
    writeReviewUrl,
  };
}

function buildSubmittedReviewItem({
  reviewId,
  name,
  rating,
  title,
  reviewBody,
  hideDuplicateBody = false,
  picturesForDisplay = [],
}) {
  const displayTitle = title || "Review";
  const pictures = dedupeReviewPictureItems(
    picturesForDisplay
      .map((url) => {
        const value = String(url || "").trim();
        return value ? { thumb: value, full: value } : null;
      })
      .filter(Boolean)
  );
  return {
    id: reviewId || `pending-${Date.now()}`,
    rating,
    title: displayTitle,
    body: reviewBodyForDisplay(displayTitle, reviewBody, hideDuplicateBody),
    author: name,
    createdAt: new Date().toISOString(),
    verified: false,
    pictures,
  };
}

function upsertSubmittedReviewInBundle(bundle, submitted) {
  if (!submitted) return bundle;
  const items = Array.isArray(bundle?.items) ? bundle.items : [];
  const id = String(submitted.id || "");
  const merged = [
    submitted,
    ...items.filter((item) => String(item?.id || "") !== id),
  ];
  const distribution = { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 };
  let sum = 0;
  merged.forEach((item) => {
    const stars = Math.max(1, Math.min(5, Number(item.rating) || 0));
    sum += stars;
    distribution[stars] = (distribution[stars] || 0) + 1;
  });
  const count = merged.length;
  return {
    ...bundle,
    count,
    averageRating: count ? Math.round((sum / count) * 10) / 10 : null,
    distribution,
    items: merged,
  };
}

async function fetchJudgeMeReviewsForProduct(handle, shopifyProductGid) {
  const writeReviewUrl = await buildJudgeMeWriteReviewUrl(handle, shopifyProductGid);
  const empty = mapJudgeMeReviewBundle([], handle, writeReviewUrl);
  if (!judgeMeConfigured()) return empty;

  const externalId = parseShopifyResourceNumericId(shopifyProductGid, "Product");
  const attempts = [];
  if (externalId) attempts.push({ external_id: externalId });
  if (handle) attempts.push({ handle });

  let rawReviews = [];
  for (const extra of attempts) {
    try {
      const data = await judgeMeRequest("reviews", { per_page: 50, page: 1, ...extra });
      const batch = Array.isArray(data?.reviews) ? data.reviews : [];
      const filtered = batch.filter(isPublishedJudgeMeReview);
      if (filtered.length) {
        rawReviews = filtered;
        break;
      }
    } catch (error) {
      console.warn("Judge.me reviews query failed:", extra, error.message);
    }
  }

  if (!rawReviews.length && handle) {
    try {
      const data = await judgeMeRequest("reviews", { per_page: 100, page: 1 });
      rawReviews = (Array.isArray(data?.reviews) ? data.reviews : []).filter(
        (review) => String(review.product_handle || "") === handle && isPublishedJudgeMeReview(review)
      );
    } catch (error) {
      console.warn("Judge.me reviews fallback failed:", error.message);
      return empty;
    }
  }

  const sortedRawReviews = sortJudgeMeReviewsNewestFirst(rawReviews);
  const sortedReviewIds = sortedRawReviews.map((review) => String(review?.id || "").trim()).filter(Boolean);
  const widgetNames =
    externalId || handle
      ? await fetchJudgeMeWidgetDisplayNames(externalId, handle, sortedReviewIds)
      : {};
  const enrichedReviews = await enrichJudgeMeReviewDetails(rawReviews);
  let displayNamesByReviewId = buildJudgeMeDisplayNamesByReviewId(enrichedReviews, widgetNames);
  displayNamesByReviewId = await augmentDisplayNamesFromShopifyMetaobjects(
    enrichedReviews,
    shopifyProductGid,
    displayNamesByReviewId
  );
  cacheReviewDisplayNames(displayNamesByReviewId);
  return mapJudgeMeReviewBundle(enrichedReviews, handle, writeReviewUrl, displayNamesByReviewId);
}

async function resolveActiveProductNodeByHandle(handle) {
  const safeHandle = String(handle || "").trim();
  if (!safeHandle) return null;
  const query = `
    query ProductIdByHandle($query: String!) {
      products(first: 1, query: $query) {
        edges {
          node {
            id
            handle
            title
            status
          }
        }
      }
    }
  `;
  const data = await adminGraphql(query, { query: `handle:${safeHandle} status:active` });
  const node = data?.products?.edges?.[0]?.node;
  if (!node || !isActiveShopifyProduct(node)) return null;
  return node;
}

async function handleProductReviewSubmit(req, res, handle) {
  if (!judgeMeConfigured()) {
    json(res, 503, { error: "Reviews are not configured yet." });
    return;
  }

  const contentType = String(req.headers["content-type"] || "");
  let body = {};
  let mediaBundle = { picturesForJudgeMe: [], picturesForDisplay: [] };
  try {
    if (contentType.includes("multipart/form-data")) {
      const parsed = await readMultipartBody(req);
      body = parsed.fields || {};
      const mediaFiles = (parsed.files || []).filter((file) => {
        const field = String(file.fieldname || "").toLowerCase();
        return field === "media" || field === "media[]" || field.startsWith("media");
      });
      mediaBundle = await saveReviewMediaFiles(mediaFiles);
    } else {
      body = await readJsonBody(req);
      if (Array.isArray(body.picture_urls)) {
        const urls = body.picture_urls
          .map((url) => String(url || "").trim())
          .filter((url) => /^https?:\/\//i.test(url))
          .slice(0, REVIEW_MEDIA_MAX_FILES);
        mediaBundle.picturesForJudgeMe = urls;
        mediaBundle.picturesForDisplay = urls;
      }
    }
  } catch (error) {
    json(res, 400, { error: error.message || "Invalid request." });
    return;
  }

  if (String(body.website || "").trim()) {
    json(res, 200, {
      ok: true,
      message: "Thanks for Flexing.",
    });
    return;
  }

  const rating = Math.round(Number(body.rating));
  const name = String(body.name || "").trim().slice(0, 120);
  const email = String(body.email || "").trim().toLowerCase().slice(0, 254);
  const reviewBody = String(body.body || "").trim().slice(0, 5000);
  const titleInput = String(body.title || "").trim().slice(0, 200);
  const title =
    titleInput ||
    String(reviewBody || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 200);

  if (!name || !email || !reviewBody || rating < 1 || rating > 5) {
    json(res, 400, {
      error: "Please provide your name, email, a star rating, and review text.",
    });
    return;
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    json(res, 400, { error: "Please enter a valid email address." });
    return;
  }

  try {
    const node = await resolveActiveProductNodeByHandle(handle);
    if (!node) {
      json(res, 404, { error: "Product not found." });
      return;
    }

    const externalId = parseShopifyResourceNumericId(node.id, "Product");
    if (!externalId) {
      json(res, 400, { error: "Unable to resolve this product for reviews." });
      return;
    }

    const payload = {
      platform: "shopify",
      id: Number(externalId),
      name,
      reviewer_name: name,
      email,
      rating,
      title: title || "Review",
      body: reviewBody,
      reviewer_name_format: "",
    };
    if (mediaBundle.picturesForJudgeMe.length) {
      payload.picture_urls = mediaBundle.picturesForJudgeMe;
    }

    const created = await judgeMePostJson("reviews", payload);
    let reviewId = created?.review?.id ?? created?.id;
    if (!reviewId) {
      try {
        const listing = await judgeMeRequest("reviews", {
          external_id: Number(externalId),
          per_page: 20,
          page: 1,
        });
        const matches = (Array.isArray(listing?.reviews) ? listing.reviews : []).filter(
          (item) => String(item?.reviewer?.email || "").trim().toLowerCase() === email
        );
        reviewId = matches[0]?.id;
      } catch (error) {
        console.warn("Judge.me review id lookup after submit failed:", error.message);
      }
    }
    if (reviewId) saveReviewAuthorOverride(reviewId, name);
    if (reviewId && !titleInput) saveReviewBodyHide(reviewId);
    if (reviewId && mediaBundle.picturesForDisplay.length) {
      saveReviewMediaOverride(reviewId, {
        pictures: mediaBundle.picturesForDisplay,
      });
    }

    let reviews = await fetchJudgeMeReviewsForProduct(node.handle, node.id);
    const submitted = buildSubmittedReviewItem({
      reviewId,
      name,
      rating,
      title,
      reviewBody,
      hideDuplicateBody: !titleInput,
      picturesForDisplay: mediaBundle.picturesForDisplay,
    });
    reviews = upsertSubmittedReviewInBundle(reviews, submitted);

    json(res, 200, {
      ok: true,
      message: "Thanks for Flexing.",
      reviews,
    });
  } catch (error) {
    console.error("Judge.me review submit failed:", error.message);
    json(res, 502, { error: error.message || "Could not submit your review. Try again shortly." });
  }
}

function mapProduct(node, discountMap = new Map()) {
  if (!node || !isActiveShopifyProduct(node)) return null;

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
    productType: String(node.productType || "").trim(),
    tags: parseShopifyTags(node.tags),
    description: node.description || "",
    descriptionHtml: node.descriptionHtml || node.description || "",
    totalInventory: Number(node.totalInventory || 0),
    featuredImage,
    images,
    options: (Array.isArray(node.options) ? node.options : []).map((opt) => ({
      name: String(opt?.name || "").trim(),
      values: (Array.isArray(opt?.values) ? opt.values : [])
        .map((v) => String(v || "").trim())
        .filter(Boolean),
    })),
    ...computeProductPriceRanges(variants, node.id, node.handle, discountMap),
    variants: {
      nodes: variants.map((variant) => {
        const currencyCode = SHOP_CURRENCY_CODE;
        const priceAmount = Number(variant.price || 0);
        const compareAtAmount = variant.compareAtPrice ? Number(variant.compareAtPrice) : null;
        let price = { amount: String(priceAmount || 0), currencyCode };
        let compareAtPrice =
          compareAtAmount && compareAtAmount > priceAmount
            ? { amount: String(compareAtAmount), currencyCode }
            : null;

        if (!compareAtPrice) {
          const auto = resolveAutomaticDiscountForProduct(node.id, node.handle, discountMap);
          const discounted = applyAutomaticDiscountToPrice(priceAmount, auto);
          if (discounted != null && discounted < priceAmount - 0.001) {
            price = { amount: discounted.toFixed(2), currencyCode };
            compareAtPrice = { amount: String(priceAmount), currencyCode };
          }
        }

        return {
          id: variant.id,
          title: variant.title,
          selectedOptions: (Array.isArray(variant.selectedOptions) ? variant.selectedOptions : [])
            .map((opt) => ({
              name: String(opt?.name || "").trim(),
              value: String(opt?.value || "").trim(),
            }))
            .filter((opt) => opt.name && opt.value),
          availableForSale: !!variant.inventoryQuantity && variant.inventoryQuantity > 0,
          quantityAvailable: Number(variant.inventoryQuantity || 0),
          price,
          compareAtPrice,
        };
      }),
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

function signValue(value) {
  return crypto.createHmac("sha256", SESSION_SIGNING_SECRET).update(value).digest("base64url");
}

function encodeSignedPayload(payload) {
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = signValue(body);
  return `${body}.${signature}`;
}

function decodeSignedPayload(token) {
  if (!token || typeof token !== "string") return null;
  const splitIdx = token.lastIndexOf(".");
  if (splitIdx <= 0) return null;
  const body = token.slice(0, splitIdx);
  const signature = token.slice(splitIdx + 1);
  if (signValue(body) !== signature) return null;
  try {
    const parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch (_) {
    return null;
  }
}

function createSessionCookie(sessionPayload, maxAgeSeconds = 60 * 60 * 24 * 30) {
  const secureSuffix = FRONTEND_ORIGIN.startsWith("https://") ? "; Secure" : "";
  const token = encodeSignedPayload(sessionPayload);
  return `flexcase_customer_session=${encodeURIComponent(
    token
  )}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secureSuffix}`;
}

/** Cookie Max-Age for Set-Cookie refresh (e.g. profile update) without shortening an existing session. */
function sessionRemainingMaxAgeSec(session) {
  const exp = Number(session?.expiresAt || 0);
  if (!exp) return 60 * 60 * 24 * 30;
  const sec = Math.floor((exp - Date.now()) / 1000);
  return Math.max(60, Math.min(sec, SESSION_MAX_AGE_KEEP_SEC));
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

function getCustomerSession(req) {
  const token = parseCookies(req).flexcase_customer_session;
  if (!token) return null;
  const session = decodeSignedPayload(token);
  if (!session) return null;
  if (session.expiresAt && session.expiresAt <= Date.now()) {
    return null;
  }
  return { session };
}

function createOAuthState(mode, keep, expectedEmail = "", returnTo = "") {
  return encodeSignedPayload({
    mode,
    keep,
    expectedEmail: String(expectedEmail || "")
      .trim()
      .toLowerCase(),
    returnTo: String(returnTo || ""),
    expiresAt: Date.now() + 10 * 60_000,
    nonce: crypto.randomBytes(8).toString("hex"),
  });
}

function parseOAuthState(state) {
  const payload = decodeSignedPayload(state);
  if (!payload || payload.expiresAt <= Date.now()) return null;
  const mode = payload.mode === "signup" ? "signup" : "signin";
  return {
    mode,
    keep: payload.keep === true,
    expectedEmail: String(payload.expectedEmail || "")
      .trim()
      .toLowerCase(),
    returnTo: String(payload.returnTo || ""),
    expiresAt: Number(payload.expiresAt) || 0,
  };
}

// Whitelist post-OAuth return targets to the configured frontend origin to avoid
// open-redirect issues. Accepts absolute URLs or paths; returns "" when invalid.
function sanitizeOAuthReturnTo(input) {
  try {
    const raw = String(input || "").trim();
    if (!raw) return "";
    const candidate = new URL(raw, FRONTEND_ORIGIN);
    const frontend = new URL(FRONTEND_ORIGIN);
    if (candidate.origin !== frontend.origin) return "";
    return `${candidate.origin}${candidate.pathname}${candidate.search}`;
  } catch (_) {
    return "";
  }
}

function appendOAuthCallbackParams(base, params) {
  try {
    const url = new URL(base);
    Object.entries(params || {}).forEach(([key, value]) => {
      if (value === undefined || value === null) return;
      url.searchParams.set(key, String(value));
    });
    return url.toString();
  } catch (_) {
    return base;
  }
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

/** True for HLS playlists (not usable as a bare <video src> in most browsers). */
function isShopifyHlsVideoSource(s) {
  if (!s) return false;
  const mt = String(s.mimeType || "").toLowerCase();
  const u = String(s.url || "").toLowerCase();
  return (
    mt.includes("application/vnd.apple.mpegurl") ||
    mt.includes("mpegurl") ||
    u.includes(".m3u8")
  );
}

/**
 * Prefer Shopify's uploaded original, else the largest progressive rendition
 * (by pixel area, then file size). Avoids picking the first low-res MP4 transcode.
 */
function pickShopifyVideoPlayableUrl(videoNode) {
  const list = Array.isArray(videoNode?.sources) ? videoNode.sources : [];
  const orig = videoNode?.originalSource;

  if (orig?.url && !isShopifyHlsVideoSource(orig)) {
    return String(orig.url).trim();
  }

  const progressive = list.filter((s) => s?.url && !isShopifyHlsVideoSource(s));
  if (!progressive.length) {
    if (orig?.url) return String(orig.url).trim();
    const any = list.find((s) => s?.url);
    return any ? String(any.url).trim() : "";
  }

  let best = progressive[0];
  let bestPx = Number(best?.width || 0) * Number(best?.height || 0);
  let bestFs = Number(best?.fileSize || 0);
  for (let i = 1; i < progressive.length; i += 1) {
    const s = progressive[i];
    const px = Number(s?.width || 0) * Number(s?.height || 0);
    const fs = Number(s?.fileSize || 0);
    if (px > bestPx || (px === bestPx && fs > bestFs)) {
      best = s;
      bestPx = px;
      bestFs = fs;
    }
  }
  return best?.url ? String(best.url).trim() : "";
}

/**
 * Ordered gallery from Product.media (images + Shopify-hosted / external video).
 * Legacy `images` remains on the product for thumbnails when media is empty.
 */
function mapProductMediaToGallery(node) {
  const edges = node?.media?.edges || [];
  const out = [];
  const seen = new Set();
  for (const edge of edges) {
    const m = edge?.node;
    if (!m?.id) continue;
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    const mct = String(m.mediaContentType || "").toUpperCase();
    const altBase = String(m.alt || "").trim();

    if (mct === "IMAGE") {
      const url = String(m.image?.url || "").trim();
      if (!url) continue;
      const altText = altBase || String(m.image?.altText || node?.title || "Product").trim();
      out.push({ kind: "image", url, altText });
      continue;
    }

    if (mct === "VIDEO") {
      const poster = String(m.preview?.image?.url || "").trim();
      const videoUrl = pickShopifyVideoPlayableUrl(m);
      const altText = altBase || String(m.preview?.image?.altText || node?.title || "Product video").trim();
      if (!videoUrl && !poster) continue;
      out.push({
        kind: "video",
        url: poster || videoUrl,
        videoUrl,
        poster,
        altText,
        status: String(m.status || ""),
      });
      continue;
    }

    if (mct === "EXTERNAL_VIDEO") {
      const embedUrl = String(m.embedUrl || "").trim();
      const poster = String(m.preview?.image?.url || "").trim();
      if (!embedUrl && !poster) continue;
      const altText = altBase || String(m.preview?.image?.altText || node?.title || "Product video").trim();
      out.push({
        kind: "external_video",
        embedUrl,
        url: poster || embedUrl,
        poster,
        altText,
      });
    }
  }
  return out;
}

async function handleCatalog(req, res) {
  const reqUrl = new URL(req.url, "http://localhost");
  const first = Math.min(Number(reqUrl.searchParams.get("first") || 24), 100);
  const query = `
    query Products($first: Int!) {
      products(first: $first, query: "status:active") {
        edges {
          node {
            id
            handle
            title
            status
            vendor
            productType
            tags
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
    const [data, discountMap] = await Promise.all([
      adminGraphql(query, { first }),
      getAutomaticDiscountByProductId(),
    ]);
    const products =
      data?.products?.edges?.map((edge) => mapProduct(edge.node, discountMap)).filter(Boolean) || [];
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
            status
            vendor
            productType
            tags
            description
            descriptionHtml
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
            media(first: 25) {
              edges {
                node {
                  id
                  mediaContentType
                  alt
                  ... on MediaImage {
                    image {
                      url
                      altText
                    }
                  }
                  ... on Video {
                    status
                    preview {
                      image {
                        url
                        altText
                      }
                    }
                    originalSource {
                      url
                      mimeType
                      format
                      width
                      height
                      fileSize
                    }
                    sources {
                      url
                      mimeType
                      format
                      width
                      height
                      fileSize
                    }
                  }
                  ... on ExternalVideo {
                    embedUrl
                    preview {
                      image {
                        url
                        altText
                      }
                    }
                  }
                }
              }
            }
            options {
              name
              values
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
    const [data, discountMap] = await Promise.all([
      adminGraphql(query, { query: `handle:${handle} status:active` }),
      getAutomaticDiscountByProductId(),
    ]);
    const node = data?.products?.edges?.[0]?.node;
    if (!node || !isActiveShopifyProduct(node)) {
      json(res, 404, { error: "Product not found." });
      return;
    }
    const product = mapProduct(node, discountMap);
    product.mediaGallery = mapProductMediaToGallery(node);
    product.reviews = await fetchJudgeMeReviewsForProduct(node.handle, node.id);
    json(res, 200, { product });
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
  const forceSelect = reqUrl.searchParams.get("force_select") === "1";
  const shopifyCleared = reqUrl.searchParams.get("shopify_cleared") === "1";
  const emailHint = String(reqUrl.searchParams.get("email") || "")
    .trim()
    .toLowerCase();
  const returnTo = sanitizeOAuthReturnTo(reqUrl.searchParams.get("return_to"));

  // Force a Shopify-side logout once before each new OAuth start so account selection
  // starts from a clean state instead of silently reusing prior Shopify sessions.
  const current = getCustomerSession(req);
  const idTokenHint = String(current?.session?.idToken || "").trim();
  if (CUSTOMER_ACCOUNT_LOGOUT_ENDPOINT && !shopifyCleared && idTokenHint) {
    const resumeUrl = new URL(`${API_ORIGIN}/api/customer/oauth/start`);
    resumeUrl.searchParams.set("mode", mode);
    resumeUrl.searchParams.set("keep", keep ? "1" : "0");
    if (forceSelect) resumeUrl.searchParams.set("force_select", "1");
    if (emailHint) resumeUrl.searchParams.set("email", emailHint);
    if (returnTo) resumeUrl.searchParams.set("return_to", returnTo);
    resumeUrl.searchParams.set("shopify_cleared", "1");

    const logoutUrl = new URL(CUSTOMER_ACCOUNT_LOGOUT_ENDPOINT);
    logoutUrl.searchParams.set("post_logout_redirect_uri", resumeUrl.toString());
    logoutUrl.searchParams.set("id_token_hint", idTokenHint);

    res.writeHead(302, {
      Location: logoutUrl.toString(),
      "Set-Cookie": clearSessionCookie(),
    });
    res.end();
    return;
  }

  const state = createOAuthState(mode, keep, emailHint, returnTo);

  const authorizeUrl = new URL(CUSTOMER_ACCOUNT_AUTHORIZATION_ENDPOINT);
  authorizeUrl.searchParams.set("client_id", CUSTOMER_ACCOUNT_CLIENT_ID);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("redirect_uri", CUSTOMER_ACCOUNT_REDIRECT_URI);
  authorizeUrl.searchParams.set("scope", CUSTOMER_ACCOUNT_SCOPES);
  authorizeUrl.searchParams.set("state", state);
  if (forceSelect) {
    authorizeUrl.searchParams.set("prompt", "select_account");
  } else if (mode === "signup") {
    authorizeUrl.searchParams.set("prompt", "login");
  } else if (emailHint) {
    // When user entered an email, force fresh login so Shopify lands on that email's OTP flow.
    authorizeUrl.searchParams.set("prompt", "login");
  } else {
    // Prevent silent re-auth into the previous Shopify Account user.
    authorizeUrl.searchParams.set("prompt", "select_account");
  }
  if (emailHint) authorizeUrl.searchParams.set("login_hint", emailHint);

  // Clear any stale backend session before initiating a new OAuth login attempt.
  res.writeHead(302, {
    Location: authorizeUrl.toString(),
    "Set-Cookie": clearSessionCookie(),
  });
  res.end();
}

async function handleCustomerOauthCallback(req, res) {
  let returnToBase = `${FRONTEND_ORIGIN}/account.html`;
  try {
    const reqUrl = new URL(req.url, "http://localhost");
    const code = String(reqUrl.searchParams.get("code") || "");
    const state = String(reqUrl.searchParams.get("state") || "");
    if (!code || !state) {
      res.writeHead(302, {
        Location: appendOAuthCallbackParams(returnToBase, {
          auth: "error",
          message: "Missing OAuth code.",
        }),
      });
      res.end();
      return;
    }

    const stateValue = parseOAuthState(state);
    if (!stateValue) {
      res.writeHead(302, {
        Location: appendOAuthCallbackParams(returnToBase, {
          auth: "error",
          message: "Invalid OAuth state.",
        }),
      });
      res.end();
      return;
    }

    const validatedReturnTo = sanitizeOAuthReturnTo(stateValue.returnTo);
    if (validatedReturnTo) returnToBase = validatedReturnTo;

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
      const message =
        payload.error_description || payload.error || `Token exchange failed (${tokenResp.status}).`;
      res.writeHead(302, {
        Location: appendOAuthCallbackParams(returnToBase, { auth: "error", message }),
      });
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
    const returnedEmail = String(customer.email || "")
      .trim()
      .toLowerCase();
    const expectedEmail = String(stateValue.expectedEmail || "")
      .trim()
      .toLowerCase();
    if (expectedEmail && returnedEmail && returnedEmail !== expectedEmail) {
      const message = `Signed in as ${returnedEmail}, but you entered ${expectedEmail}. Please choose the correct Shopify account and try again.`;
      let location = appendOAuthCallbackParams(returnToBase, { auth: "error", message });
      const mismatchIdToken = String(payload.id_token || "").trim();
      if (CUSTOMER_ACCOUNT_LOGOUT_ENDPOINT && mismatchIdToken) {
        // Clear Shopify account context immediately on mismatch while we still have a valid id_token.
        const logoutUrl = new URL(CUSTOMER_ACCOUNT_LOGOUT_ENDPOINT);
        logoutUrl.searchParams.set("post_logout_redirect_uri", location);
        logoutUrl.searchParams.set("id_token_hint", mismatchIdToken);
        location = logoutUrl.toString();
      }
      res.writeHead(302, {
        Location: location,
        "Set-Cookie": clearSessionCookie(),
      });
      res.end();
      return;
    }
    const oauthAccessExpiryMs = payload.expires_in
      ? Date.now() + Number(payload.expires_in) * 1000
      : Date.now() + SESSION_MAX_AGE_SHORT_SEC * 1000;
    const shortSessionExpiryMs = Math.min(
      oauthAccessExpiryMs,
      Date.now() + SESSION_MAX_AGE_SHORT_SEC * 1000
    );
    const keepSessionExpiryMs = Date.now() + SESSION_MAX_AGE_KEEP_SEC * 1000;
    const sessionExpiresAtMs = stateValue.keep ? keepSessionExpiryMs : shortSessionExpiryMs;
    const cookieMaxAgeSec = stateValue.keep ? SESSION_MAX_AGE_KEEP_SEC : SESSION_MAX_AGE_SHORT_SEC;
    const sessionPayload = {
      customer,
      idToken: String(payload.id_token || ""),
      mode: stateValue.mode,
      keep: stateValue.keep === true,
      createdAt: Date.now(),
      expiresAt: sessionExpiresAtMs,
    };

    res.writeHead(302, {
      Location: appendOAuthCallbackParams(returnToBase, { auth: "success" }),
      "Set-Cookie": createSessionCookie(sessionPayload, cookieMaxAgeSec),
    });
    res.end();
  } catch (error) {
    res.writeHead(302, {
      Location: appendOAuthCallbackParams(returnToBase, {
        auth: "error",
        message: error.message || "OAuth callback failed.",
      }),
    });
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

function handleCustomerSessionDebug(req, res) {
  const origin = String(req.headers.origin || "");
  const host = String(req.headers.host || "");
  const cookieHeader = String(req.headers.cookie || "");
  const hasSessionCookie = cookieHeader.includes("flexcase_customer_session=");
  const originAllowed = Boolean(origin) && ALLOWED_ORIGINS.has(origin);
  const current = getCustomerSession(req);
  const authenticated = Boolean(current?.session?.customer);
  const expectedSecureCookie = FRONTEND_ORIGIN.startsWith("https://");

  let reason = "unknown";
  if (authenticated) {
    reason = "ok";
  } else if (!hasSessionCookie) {
    reason = "missing_session_cookie";
  } else if (origin && !originAllowed) {
    reason = "origin_not_allowed";
  } else {
    reason = "session_invalid_or_expired";
  }

  json(res, 200, {
    ok: authenticated,
    reason,
    diagnostics: {
      requestOrigin: origin || null,
      requestHost: host || null,
      originAllowed,
      hasSessionCookie,
      expectedSecureCookie,
      frontendOrigin: FRONTEND_ORIGIN,
      apiOrigin: API_ORIGIN,
      allowedOrigins: [...ALLOWED_ORIGINS],
      cookieHints: {
        sameSite: "Lax",
        httpOnly: true,
        secure: expectedSecureCookie,
      },
    },
  });
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

function normalizePhone(phone) {
  return String(phone || "").trim().replace(/\s+/g, "");
}

function comparablePhone(phone) {
  return normalizePhone(phone).replace(/[^\d]/g, "");
}

async function findCustomerByPhone(phone) {
  const normalized = normalizePhone(phone);
  if (!normalized) return null;
  const query = `
    query CustomerByPhone($query: String!) {
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
  const data = await adminGraphql(query, { query: `phone:${normalized}` });
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
    const phone = normalizePhone(phoneRaw);
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
    const sessionCustomer = current?.session?.customer || {};
    const customerId = String(sessionCustomer.id || "").trim();
    const email = String(sessionCustomer.email || "")
      .trim()
      .toLowerCase();
    if (!customerId && !email) {
      json(res, 401, { error: "Not authenticated." });
      return;
    }
    const customerFields = `
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
      addresses {
        id
        firstName
        lastName
        company
        address1
        address2
        city
        province
        provinceCode
        zip
        countryCodeV2
        phone
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
            currentTotalTaxSet {
              shopMoney {
                amount
                currencyCode
              }
            }
            currentShippingPriceSet {
              shopMoney {
                amount
                currencyCode
              }
            }
            lineItems(first: 25) {
              edges {
                node {
                  title
                  quantity
                  variantTitle
                  discountedTotalSet {
                    shopMoney {
                      amount
                      currencyCode
                    }
                  }
                  originalTotalSet {
                    shopMoney {
                      amount
                      currencyCode
                    }
                  }
                  product {
                    id
                    handle
                    onlineStoreUrl
                    featuredImage {
                      url
                      altText
                    }
                  }
                  variant {
                    id
                    title
                    image {
                      url
                      altText
                    }
                  }
                }
              }
            }
          }
        }
      }
    `;

    let customerNode = null;
    let lookupEmail = email;
    if (customerId && customerId.startsWith("gid://shopify/Customer/")) {
      const byIdQuery = `
        query CustomerAccountDataById($id: ID!) {
          customer(id: $id) {
            id
            email
          }
        }
      `;
      const byIdData = await adminGraphql(byIdQuery, { id: customerId });
      lookupEmail = String(byIdData?.customer?.email || lookupEmail || "")
        .trim()
        .toLowerCase();
    }

    if (!customerNode && lookupEmail) {
      const byEmailQuery = `
        query CustomerAccountDataByEmail($query: String!) {
          customers(first: 1, query: $query) {
            edges {
              node {
                ${customerFields}
              }
            }
          }
        }
      `;
      const byEmailData = await adminGraphql(byEmailQuery, { query: `email:${lookupEmail}` });
      customerNode = byEmailData?.customers?.edges?.[0]?.node;
    }

    if (!customerNode) {
      json(res, 404, { error: "Customer record not found." });
      return;
    }

    const addressesRaw = customerNode.addresses;
    const addresses = Array.isArray(addressesRaw)
      ? addressesRaw.filter(Boolean)
      : (addressesRaw?.edges || []).map((edge) => edge?.node).filter(Boolean);
    const defaultAddressId = customerNode.defaultAddress?.id || "";
    const orders =
      customerNode.orders?.edges?.map((edge) => edge?.node).filter(Boolean) || [];

    json(res, 200, {
      customer: {
        id: customerNode.id,
        firstName: customerNode.firstName || "",
        lastName: customerNode.lastName || "",
        email: customerNode.email || email || "",
        phone: customerNode.phone || "",
      },
      addresses: addresses.map((a) => ({
        id: a.id,
        firstName: a.firstName || "",
        lastName: a.lastName || "",
        company: a.company || "",
        address1: a.address1 || "",
        address2: a.address2 || "",
        city: a.city || "",
        province: a.province || "",
        provinceCode: a.provinceCode || "",
        zip: a.zip || "",
        country: a.countryCodeV2 || "",
        phone: a.phone || "",
        isDefault: a.id === defaultAddressId,
      })),
      orders: orders.map((o) => ({
        id: o.id,
        name: o.name || "",
        processedAt: o.processedAt || "",
        financialStatus: o.displayFinancialStatus || "",
        fulfillmentStatus: o.displayFulfillmentStatus || "",
        total: o.currentTotalPriceSet?.shopMoney || null,
        tax: o.currentTotalTaxSet?.shopMoney || null,
        shipping: o.currentShippingPriceSet?.shopMoney || null,
        items:
          o.lineItems?.edges?.map((itemEdge) => itemEdge?.node).filter(Boolean).map((item) => ({
            title: item.title || "",
            quantity: Number(item.quantity || 0),
            variantTitle: item.variantTitle || item.variant?.title || "",
            lineTotal:
              item.discountedTotalSet?.shopMoney ||
              item.originalTotalSet?.shopMoney ||
              null,
            productHandle: item.product?.handle || "",
            productUrl: item.product?.onlineStoreUrl || "",
            image:
              item.variant?.image?.url ||
              item.product?.featuredImage?.url ||
              "",
            imageAlt:
              item.variant?.image?.altText ||
              item.product?.featuredImage?.altText ||
              item.title ||
              "",
          })) || [],
      })),
    });
  } catch (error) {
    json(res, 500, { error: error.message });
  }
}

async function handleCustomerProfileUpdate(req, res) {
  try {
    const current = getCustomerSession(req);
    if (!current?.session?.customer?.email) {
      json(res, 401, { error: "Not authenticated." });
      return;
    }

    const body = await readJsonBody(req);
    const firstName = String(body.firstName || "").trim();
    const lastName = String(body.lastName || "").trim();
    const email = String(body.email || "")
      .trim()
      .toLowerCase();
    const phoneRaw = String(body.phone || "").trim();
    const phone = normalizePhone(phoneRaw);
    const fieldErrors = {};
    if (!firstName) fieldErrors.firstName = "First name is required.";
    if (!lastName) fieldErrors.lastName = "Last name is required.";
    if (!email) fieldErrors.email = "Email address is required.";
    if (!phone) fieldErrors.phone = "Contact number is required.";
    if (Object.keys(fieldErrors).length) {
      json(res, 400, {
        error: "Unable to save profile changes.",
        fieldErrors,
      });
      return;
    }

    const currentEmail = String(current.session.customer.email || "")
      .trim()
      .toLowerCase();
    const customer = await findCustomerByEmail(currentEmail);
    if (!customer?.id) {
      json(res, 404, { error: "Customer record not found." });
      return;
    }

    if (email !== currentEmail) {
      const conflict = await findCustomerByEmail(email);
      if (conflict?.id && conflict.id !== customer.id) {
        fieldErrors.email = "This email is already registered. Please try another one.";
      }
    }
    const currentPhoneComparable = comparablePhone(customer.phone || "");
    const nextPhoneComparable = comparablePhone(phone || "");
    if (
      nextPhoneComparable &&
      nextPhoneComparable !== currentPhoneComparable
    ) {
      const phoneConflict = await findCustomerByPhone(phone);
      if (phoneConflict?.id && phoneConflict.id !== customer.id) {
        fieldErrors.phone = "This contact number has already been claimed.";
      }
    }
    if (Object.keys(fieldErrors).length) {
      json(res, 400, {
        error: "Unable to save profile changes.",
        fieldErrors,
      });
      return;
    }

    const mutation = `
      mutation CustomerUpdate($input: CustomerInput!) {
        customerUpdate(input: $input) {
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
        id: customer.id,
        firstName,
        lastName: lastName || null,
        email,
        phone: phone || null,
      },
    });
    const payload = data?.customerUpdate;
    if (payload?.userErrors?.length) {
      json(res, 400, {
        error: payload.userErrors.map((e) => e.message).join(", "),
      });
      return;
    }
    if (!payload?.customer?.id) {
      json(res, 500, { error: "Unable to update customer profile." });
      return;
    }

    const updatedSession = {
      ...current.session,
      customer: {
        ...current.session.customer,
        firstName: payload.customer.firstName || firstName,
        lastName: payload.customer.lastName || lastName,
        email: payload.customer.email || email,
        phone: payload.customer.phone || phone || "",
      },
    };

    const responseBody = JSON.stringify({
      customer: {
        id: payload.customer.id,
        firstName: payload.customer.firstName || "",
        lastName: payload.customer.lastName || "",
        email: payload.customer.email || email,
        phone: payload.customer.phone || "",
      },
    });
    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": Buffer.byteLength(responseBody),
      "Set-Cookie": createSessionCookie(updatedSession, sessionRemainingMaxAgeSec(current.session)),
    });
    res.end(responseBody);
  } catch (error) {
    json(res, 500, { error: error.message });
  }
}

async function customerHasAnyAddresses(customerGid) {
  const q = `
    query CustomerAddrCount($id: ID!) {
      customer(id: $id) {
        addresses {
          id
        }
      }
    }
  `;
  const data = await adminGraphql(q, { id: customerGid });
  const list = data?.customer?.addresses;
  return Array.isArray(list) && list.length > 0;
}

async function handleCustomerAddressCreate(req, res) {
  try {
    const current = getCustomerSession(req);
    if (!current?.session?.customer?.email) {
      json(res, 401, { error: "Not authenticated." });
      return;
    }
    const body = await readJsonBody(req);
    const currentEmail = String(current.session.customer.email || "").trim().toLowerCase();
    const customer = await findCustomerByEmail(currentEmail);
    if (!customer?.id) {
      json(res, 404, { error: "Customer record not found." });
      return;
    }

    const firstName = String(body.firstName || "").trim();
    const lastName = String(body.lastName || "").trim();
    const company = String(body.company || "").trim();
    const address1 = String(body.address1 || "").trim();
    const address2 = String(body.address2 || "").trim();
    const city = String(body.city || "").trim();
    const provinceCode = String(body.provinceCode || "").trim();
    const zip = String(body.zip || "").trim();
    const countryCode = String(body.countryCode || "").trim().toUpperCase();
    const phone = normalizePhone(String(body.phone || "").trim());

    const fieldErrors = {};
    if (!firstName) fieldErrors.firstName = "First name is required.";
    if (!lastName) fieldErrors.lastName = "Last name is required.";
    if (!address1) fieldErrors.address1 = "Address is required.";
    if (!city) fieldErrors.city = "City is required.";
    if (!countryCode || !/^[A-Z]{2}$/.test(countryCode)) {
      fieldErrors.countryCode = "Select a valid country.";
    }
    if (Object.keys(fieldErrors).length) {
      json(res, 400, { error: "Unable to save address.", fieldErrors });
      return;
    }

    const setAsDefault = true;

    const addressInput = {
      firstName,
      lastName,
      company: company || null,
      address1,
      address2: address2 || null,
      city,
      provinceCode: provinceCode || null,
      zip: zip || null,
      countryCode,
      phone: phone || null,
    };

    const mutation = `
      mutation CustomerAddressCreate($customerId: ID!, $address: MailingAddressInput!, $setAsDefault: Boolean) {
        customerAddressCreate(customerId: $customerId, address: $address, setAsDefault: $setAsDefault) {
          address {
            id
            firstName
            lastName
            company
            address1
            address2
            city
            province
            provinceCode
            zip
            countryCodeV2
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
      customerId: customer.id,
      address: addressInput,
      setAsDefault,
    });
    const payload = data?.customerAddressCreate;
    if (payload?.userErrors?.length) {
      json(res, 400, {
        error: payload.userErrors.map((e) => e.message).join(", "),
      });
      return;
    }
    const created = payload?.address;
    if (!created?.id) {
      json(res, 500, { error: "Unable to create address." });
      return;
    }
    json(res, 200, {
      address: {
        id: created.id,
        firstName: created.firstName || "",
        lastName: created.lastName || "",
        company: created.company || "",
        address1: created.address1 || "",
        address2: created.address2 || "",
        city: created.city || "",
        province: created.province || "",
        provinceCode: created.provinceCode || "",
        zip: created.zip || "",
        country: created.countryCodeV2 || "",
        phone: created.phone || "",
        isDefault: Boolean(setAsDefault),
      },
    });
  } catch (error) {
    json(res, 500, { error: error.message });
  }
}

async function handleCustomerAddressDelete(req, res) {
  try {
    const current = getCustomerSession(req);
    if (!current?.session?.customer?.email) {
      json(res, 401, { error: "Not authenticated." });
      return;
    }
    const body = await readJsonBody(req);
    const addressId = String(body.id || "").trim();
    if (!addressId) {
      json(res, 400, { error: "Address id is required." });
      return;
    }
    const currentEmail = String(current.session.customer.email || "").trim().toLowerCase();
    const customer = await findCustomerByEmail(currentEmail);
    if (!customer?.id) {
      json(res, 404, { error: "Customer record not found." });
      return;
    }

    const mutation = `
      mutation CustomerAddressDelete($customerId: ID!, $addressId: ID!) {
        customerAddressDelete(customerId: $customerId, addressId: $addressId) {
          deletedAddressId
          userErrors {
            field
            message
          }
        }
      }
    `;
    const data = await adminGraphql(mutation, {
      customerId: customer.id,
      addressId,
    });
    const payload = data?.customerAddressDelete;
    if (payload?.userErrors?.length) {
      json(res, 400, {
        error: payload.userErrors.map((e) => e.message).join(", "),
      });
      return;
    }
    json(res, 200, { ok: true, deletedAddressId: payload?.deletedAddressId || addressId });
  } catch (error) {
    json(res, 500, { error: error.message });
  }
}

const FLEXCASE_HEADLESS_CART_METAFIELD = {
  namespace: "flexcase",
  key: "headless_cart_id",
};

const STOREFRONT_CART_FRAGMENT = `
  id
  checkoutUrl
  totalQuantity
  lines(first: 100) {
    edges {
      node {
        __typename
        ... on BaseCartLine {
          id
          quantity
          merchandise {
            ... on ProductVariant {
              id
              title
              price {
                amount
                currencyCode
              }
              product {
                title
                handle
                featuredImage {
                  url
                }
              }
            }
          }
        }
      }
    }
  }
`;

const STOREFRONT_CART_QUERY = `
  query FlexcaseCart($id: ID!) {
    cart(id: $id) {
      ${STOREFRONT_CART_FRAGMENT}
    }
  }
`;

const STOREFRONT_CART_CREATE = `
  mutation FlexcaseCartCreate {
    cartCreate(input: {}) {
      cart {
        id
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const STOREFRONT_CART_LINES_ADD = `
  mutation FlexcaseCartLinesAdd($cartId: ID!, $lines: [CartLineInput!]!) {
    cartLinesAdd(cartId: $cartId, lines: $lines) {
      cart {
        ${STOREFRONT_CART_FRAGMENT}
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const STOREFRONT_CART_LINES_UPDATE = `
  mutation FlexcaseCartLinesUpdate($cartId: ID!, $lines: [CartLineUpdateInput!]!) {
    cartLinesUpdate(cartId: $cartId, lines: $lines) {
      cart {
        ${STOREFRONT_CART_FRAGMENT}
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const STOREFRONT_CART_LINES_REMOVE = `
  mutation FlexcaseCartLinesRemove($cartId: ID!, $lineIds: [ID!]!) {
    cartLinesRemove(cartId: $cartId, lineIds: $lineIds) {
      cart {
        ${STOREFRONT_CART_FRAGMENT}
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const STOREFRONT_CART_CREATE_WITH_INPUT = `
  mutation FlexcaseCartCreateWithInput($input: CartInput!) {
    cartCreate(input: $input) {
      cart {
        ${STOREFRONT_CART_FRAGMENT}
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const STOREFRONT_CART_BUYER_IDENTITY_UPDATE = `
  mutation FlexcaseCartBuyerIdentityUpdate($cartId: ID!, $buyerIdentity: CartBuyerIdentityInput!) {
    cartBuyerIdentityUpdate(cartId: $cartId, buyerIdentity: $buyerIdentity) {
      cart {
        id
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const STOREFRONT_CART_DELIVERY_REPLACE = `
  mutation FlexcaseCartDeliveryAddressesReplace($cartId: ID!, $addresses: [CartSelectableAddressInput!]!) {
    cartDeliveryAddressesReplace(cartId: $cartId, addresses: $addresses) {
      cart {
        id
      }
      userErrors {
        field
        message
      }
    }
  }
`;

/** Absolute URL; rejects storefront home (/) which Shopify returns when checkout is not ready. */
function resolveStorefrontCheckoutUrl(raw) {
  let s = String(raw || "").trim();
  if (!s) return "";
  if (s.startsWith("/")) {
    s = `https://${SHOP_FROM_ENV}.myshopify.com${s}`;
  }
  try {
    const u = new URL(s);
    const pathOnly = (u.pathname || "/").replace(/\/+$/, "") || "/";
    if (pathOnly === "/") {
      return "";
    }
    return s;
  } catch (_) {
    return "";
  }
}

/** True for real web checkout URLs, not /cart browse, /collections, etc. */
function isStorefrontGraphqlCheckoutUrl(url) {
  try {
    const u = new URL(url);
    const low = (u.pathname || "").toLowerCase();
    return low.includes("/checkouts/") || low.includes("/cart/c/");
  } catch (_) {
    return false;
  }
}

/**
 * Shopify Online Store permalink: https://{shop}.myshopify.com/cart/VARIANT_ID:qty,...
 * (numeric variant id from ProductVariant gid). Opens cart with lines so buyer can proceed to checkout.
 */
function buildShopifyCartPermalink(lines) {
  const segs = [];
  for (const line of Array.isArray(lines) ? lines : []) {
    const gid = String(line?.variantId || "").trim();
    const m = gid.match(/ProductVariant\/(\d+)/);
    if (!m) continue;
    const q = Math.max(1, Math.min(99, Number(line?.quantity || 1)));
    segs.push(`${m[1]}:${q}`);
  }
  if (!segs.length) return "";
  return `https://${SHOP_FROM_ENV}.myshopify.com/cart/${segs.join(",")}`;
}

function pickShopifyCheckoutRedirectUrl(graphqlCheckoutUrl, fallbackLines) {
  const resolved = resolveStorefrontCheckoutUrl(graphqlCheckoutUrl);
  if (resolved && isStorefrontGraphqlCheckoutUrl(resolved)) {
    return resolved;
  }
  return buildShopifyCartPermalink(fallbackLines);
}

/**
 * Appends cart-permalink `checkout[...]` query params (see Shopify "Create cart permalinks")
 * so Online Store checkout can prefill shipping and billing from flexcase.
 * Mirrors the same address into billing so the payment step matches delivery details.
 * Preserves existing query keys (e.g. checkout `key=`). PII in the URL is a known tradeoff.
 */
function mergeFlexcaseCheckoutPrefillQueryParams(checkoutUrl, checkout) {
  const raw = String(checkoutUrl || "").trim();
  if (!raw || !checkout) return raw;
  try {
    const u = new URL(raw);
    const p = u.searchParams;
    const email = String(checkout.email || "").trim();
    const ship = checkout.shipping || {};
    const phone = String(checkout.phone || ship.phone || "").trim();
    const country =
      String(ship.countryName || ship.country || "").trim() ||
      String(ship.countryCode || "").trim().toUpperCase();
    const fields = {
      first_name: String(ship.firstName || "").trim(),
      last_name: String(ship.lastName || "").trim(),
      address1: String(ship.address1 || "").trim(),
      address2: String(ship.address2 || "").trim(),
      city: String(ship.city || "").trim(),
      province: String(ship.provinceCode || ship.province || "").trim(),
      zip: String(ship.zip || "").trim(),
      country,
      phone,
    };
    if (email) {
      p.set("checkout[email]", email);
    }
    for (const scope of ["shipping_address", "billing_address"]) {
      const base = `checkout[${scope}]`;
      for (const [k, v] of Object.entries(fields)) {
        if (!v) continue;
        p.set(`${base}[${k}]`, v);
      }
    }
    return u.toString();
  } catch (_) {
    return raw;
  }
}

function buildCartDeliveryAddressInput(ship) {
  const firstName = String(ship?.firstName || "").trim();
  const lastName = String(ship?.lastName || "").trim();
  const address1 = String(ship?.address1 || "").trim();
  const city = String(ship?.city || "").trim();
  const zip = String(ship?.zip || "").trim();
  const countryCode = String(ship?.countryCode || "").trim().toUpperCase();
  const deliveryAddress = {
    firstName,
    lastName,
    address1,
    city,
    zip,
  };
  const phone = String(ship?.phone || "").trim();
  if (phone) deliveryAddress.phone = phone;
  const provinceCode = String(ship?.provinceCode || "").trim();
  if (provinceCode) deliveryAddress.provinceCode = provinceCode;
  if (countryCode) deliveryAddress.countryCode = countryCode;
  return deliveryAddress;
}

function validateFlexcaseCheckoutPayload(checkout) {
  const email = String(checkout?.email || "").trim();
  if (!email) return "Email is required.";
  const ship = checkout?.shipping || {};
  const missing = (label, val) => (!String(val || "").trim() ? `${label} is required.` : "");
  let err = missing("Shipping first name", ship.firstName);
  if (err) return err;
  err = missing("Shipping last name", ship.lastName);
  if (err) return err;
  err = missing("Street address", ship.address1);
  if (err) return err;
  err = missing("City", ship.city);
  if (err) return err;
  err = missing("ZIP or postal code", ship.zip);
  if (err) return err;
  err = missing("Country", ship.countryCode);
  if (err) return err;
  return "";
}

async function applyFlexcaseCheckoutToStorefrontCart(cartId, checkout) {
  const email = String(checkout?.email || "").trim();
  const phone = String(checkout?.phone || "").trim();
  const ship = checkout?.shipping || {};
  const countryCode = String(ship.countryCode || "").trim().toUpperCase();
  const buyerIdentity = { email };
  if (phone) buyerIdentity.phone = phone;
  if (countryCode) buyerIdentity.countryCode = countryCode;

  const buyerRes = await storefrontGraphql(STOREFRONT_CART_BUYER_IDENTITY_UPDATE, {
    cartId,
    buyerIdentity,
  });
  const buyerErrs = buyerRes?.cartBuyerIdentityUpdate?.userErrors?.filter((e) => e?.message) || [];
  if (buyerErrs.length) {
    throw new Error(buyerErrs.map((e) => e.message).join(", "));
  }

  const deliveryAddress = buildCartDeliveryAddressInput(ship);
  const selectable = {
    selected: true,
    oneTimeUse: true,
    validationStrategy: "COUNTRY_CODE_ONLY",
    address: {
      deliveryAddress,
    },
  };

  const rep = await storefrontGraphql(STOREFRONT_CART_DELIVERY_REPLACE, {
    cartId,
    addresses: [selectable],
  });
  const repErrs = rep?.cartDeliveryAddressesReplace?.userErrors?.filter((e) => e?.message) || [];
  if (repErrs.length) {
    throw new Error(repErrs.map((e) => e.message).join(", "));
  }
}

/** Coerce numeric or partial IDs to Storefront ProductVariant GID. */
function normalizeStorefrontVariantGid(id) {
  const s = String(id || "").trim();
  if (!s) return "";
  if (s.startsWith("gid://shopify/ProductVariant/")) return s;
  const m = s.match(/ProductVariant\/(\d+)/i);
  if (m?.[1]) return `gid://shopify/ProductVariant/${m[1]}`;
  if (/^\d+$/.test(s)) return `gid://shopify/ProductVariant/${s}`;
  return "";
}

function mapStorefrontCartToClientLines(cart) {
  if (!cart?.lines?.edges) return [];
  const out = [];
  for (const edge of cart.lines.edges) {
    const n = edge?.node;
    if (!n) continue;
    const m = n.merchandise;
    if (!m?.id) continue;
    const price = m.price || {};
    out.push({
      lineId: n.id,
      variantId: m.id,
      productHandle: m.product?.handle || "",
      productTitle: m.product?.title || "",
      variantTitle: m.title || "",
      quantity: Number(n.quantity || 0),
      price: String(price.amount ?? "0"),
      currencyCode: price.currencyCode || "MYR",
      image: m.product?.featuredImage?.url || "",
    });
  }
  return out;
}

function findCartLineForVariant(cart, merchandiseId) {
  for (const edge of cart?.lines?.edges || []) {
    const n = edge?.node;
    const m = n?.merchandise;
    if (m?.id === merchandiseId) {
      return { lineId: n.id, quantity: Number(n.quantity || 0) };
    }
  }
  return null;
}

/** Serialize cart writes per customer so concurrent replaces cannot interleave. */
const flexcaseCustomerCartMutationChains = new Map();

async function runSerializedCustomerCartMutation(customerGid, task) {
  const key = String(customerGid || "").trim();
  if (!key) return task();
  const prior = flexcaseCustomerCartMutationChains.get(key) ?? Promise.resolve();
  const next = prior.then(() => task());
  flexcaseCustomerCartMutationChains.set(key, next.catch(() => {}));
  return next;
}

/** Remove every line (handles >100 lines via repeated passes). */
async function removeAllStorefrontCartLines(cartId) {
  const maxPasses = 12;
  for (let pass = 0; pass < maxPasses; pass++) {
    const data = await storefrontGraphql(STOREFRONT_CART_QUERY, { id: cartId });
    const lineIds = (data?.cart?.lines?.edges || []).map((e) => e?.node?.id).filter(Boolean);
    if (!lineIds.length) return;
    const rm = await storefrontGraphql(STOREFRONT_CART_LINES_REMOVE, { cartId, lineIds });
    const rmErrs = rm?.cartLinesRemove?.userErrors?.filter((e) => e?.message) || [];
    if (rmErrs.length) {
      throw new Error(rmErrs.map((e) => e.message).join(", "));
    }
  }
  const verify = await storefrontGraphql(STOREFRONT_CART_QUERY, { id: cartId });
  const remaining = (verify?.cart?.lines?.edges || []).length;
  if (remaining > 0) {
    throw new Error("Unable to clear all cart lines before rebuilding the cart.");
  }
}

async function resolveAuthCustomerForCart(req) {
  const current = getCustomerSession(req);
  const sessionCustomer = current?.session?.customer || {};
  const customerId = String(sessionCustomer.id || "").trim();
  if (customerId && customerId.startsWith("gid://shopify/Customer/")) {
    const byIdQuery = `
      query FlexcaseCartCustomerById($id: ID!) {
        customer(id: $id) {
          id
          firstName
          lastName
          email
          phone
        }
      }
    `;
    const byIdData = await adminGraphql(byIdQuery, { id: customerId });
    const byIdCustomer = byIdData?.customer;
    if (byIdCustomer?.id) return byIdCustomer;
  }

  const email = String(sessionCustomer.email || "")
    .trim()
    .toLowerCase();
  if (!email) return null;
  const byEmailCustomer = await findCustomerByEmail(email);
  if (!byEmailCustomer?.id) return null;
  return byEmailCustomer;
}

async function getCustomerHeadlessCartId(customerGid) {
  const data = await adminGraphql(
    `query FlexcaseCustomerCartMeta($id: ID!) {
      customer(id: $id) {
        metafield(namespace: "${FLEXCASE_HEADLESS_CART_METAFIELD.namespace}", key: "${FLEXCASE_HEADLESS_CART_METAFIELD.key}") {
          value
        }
      }
    }`,
    { id: customerGid }
  );
  return String(data?.customer?.metafield?.value || "").trim();
}

async function setCustomerHeadlessCartId(customerGid, cartId) {
  const mutation = `
    mutation FlexcaseMetafieldsSet($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        metafields {
          id
        }
        userErrors {
          field
          message
        }
      }
    }
  `;
  const data = await adminGraphql(mutation, {
    metafields: [
      {
        ownerId: customerGid,
        namespace: FLEXCASE_HEADLESS_CART_METAFIELD.namespace,
        key: FLEXCASE_HEADLESS_CART_METAFIELD.key,
        type: "single_line_text_field",
        value: String(cartId || "").trim(),
      },
    ],
  });
  const errs = data?.metafieldsSet?.userErrors?.filter((e) => e?.message) || [];
  if (errs.length) {
    throw new Error(errs.map((e) => e.message).join(", "));
  }
}

async function ensureCustomerStorefrontCart(customerGid) {
  let cartId = await getCustomerHeadlessCartId(customerGid);
  let cart = null;
  if (cartId) {
    try {
      const data = await storefrontGraphql(STOREFRONT_CART_QUERY, { id: cartId });
      cart = data?.cart;
      if (!cart?.id) cart = null;
    } catch (_) {
      cart = null;
    }
  }
  if (!cart?.id) {
    const created = await storefrontGraphql(STOREFRONT_CART_CREATE, {});
    const payload = created?.cartCreate;
    const errs = payload?.userErrors?.filter((e) => e?.message) || [];
    if (errs.length) {
      throw new Error(errs.map((e) => e.message).join(", "));
    }
    const newCart = payload?.cart;
    if (!newCart?.id) {
      throw new Error("Unable to create Storefront cart.");
    }
    cartId = newCart.id;
    await setCustomerHeadlessCartId(customerGid, cartId);
    const data = await storefrontGraphql(STOREFRONT_CART_QUERY, { id: cartId });
    cart = data?.cart;
  }
  return { cartId, cart };
}

async function handleCartGet(req, res) {
  try {
    const customer = await resolveAuthCustomerForCart(req);
    if (!customer) {
      json(res, 401, { error: "Not authenticated.", guest: true });
      return;
    }
    const { cartId, cart } = await ensureCustomerStorefrontCart(customer.id);
    json(res, 200, {
      cartId: cartId,
      lines: mapStorefrontCartToClientLines(cart),
      totalQuantity: Number(cart?.totalQuantity || 0),
    });
  } catch (error) {
    json(res, 500, { error: error.message });
  }
}

async function handleCartAddLine(req, res) {
  try {
    const customer = await resolveAuthCustomerForCart(req);
    if (!customer) {
      json(res, 401, { error: "Not authenticated." });
      return;
    }
    const body = await readJsonBody(req);
    const merchandiseId = normalizeStorefrontVariantGid(String(body.merchandiseId || "").trim());
    const quantity = Math.max(1, Math.min(99, Number(body.quantity || 1)));
    if (!merchandiseId.startsWith("gid://shopify/ProductVariant/")) {
      json(res, 400, { error: "Invalid variant id." });
      return;
    }
    await runSerializedCustomerCartMutation(customer.id, async () => {
      let { cartId, cart } = await ensureCustomerStorefrontCart(customer.id);
      const existing = findCartLineForVariant(cart, merchandiseId);
      let data;
      if (existing) {
        data = await storefrontGraphql(STOREFRONT_CART_LINES_UPDATE, {
          cartId,
          lines: [{ id: existing.lineId, quantity: existing.quantity + quantity }],
        });
        const errs = data?.cartLinesUpdate?.userErrors?.filter((e) => e?.message) || [];
        if (errs.length) {
          json(res, 400, { error: errs.map((e) => e.message).join(", ") });
          return;
        }
        cart = data?.cartLinesUpdate?.cart;
      } else {
        data = await storefrontGraphql(STOREFRONT_CART_LINES_ADD, {
          cartId,
          lines: [{ merchandiseId, quantity }],
        });
        const errs = data?.cartLinesAdd?.userErrors?.filter((e) => e?.message) || [];
        if (errs.length) {
          json(res, 400, { error: errs.map((e) => e.message).join(", ") });
          return;
        }
        cart = data?.cartLinesAdd?.cart;
      }
      json(res, 200, {
        lines: mapStorefrontCartToClientLines(cart),
        totalQuantity: Number(cart?.totalQuantity || 0),
      });
    });
  } catch (error) {
    json(res, 500, { error: error.message });
  }
}

async function handleCartSetLineQuantity(req, res) {
  try {
    const customer = await resolveAuthCustomerForCart(req);
    if (!customer) {
      json(res, 401, { error: "Not authenticated." });
      return;
    }
    const body = await readJsonBody(req);
    const merchandiseId = normalizeStorefrontVariantGid(
      String(body.variantId || body.merchandiseId || "").trim()
    );
    if (!merchandiseId.startsWith("gid://shopify/ProductVariant/")) {
      json(res, 400, { error: "Invalid variant id." });
      return;
    }
    const rawQty = Number(body.quantity);
    if (!Number.isFinite(rawQty) || rawQty < 0) {
      json(res, 400, { error: "Invalid quantity." });
      return;
    }
    const quantity = Math.min(99, Math.floor(rawQty));
    await runSerializedCustomerCartMutation(customer.id, async () => {
      let { cartId, cart } = await ensureCustomerStorefrontCart(customer.id);
      const existing = findCartLineForVariant(cart, merchandiseId);
      let nextCart = cart;
      if (existing) {
        if (quantity === 0) {
          const rmData = await storefrontGraphql(STOREFRONT_CART_LINES_REMOVE, {
            cartId,
            lineIds: [existing.lineId],
          });
          const errs = rmData?.cartLinesRemove?.userErrors?.filter((e) => e?.message) || [];
          if (errs.length) {
            json(res, 400, { error: errs.map((e) => e.message).join(", ") });
            return;
          }
          nextCart = rmData?.cartLinesRemove?.cart;
        } else {
          const upData = await storefrontGraphql(STOREFRONT_CART_LINES_UPDATE, {
            cartId,
            lines: [{ id: existing.lineId, quantity }],
          });
          const errs = upData?.cartLinesUpdate?.userErrors?.filter((e) => e?.message) || [];
          if (errs.length) {
            json(res, 400, { error: errs.map((e) => e.message).join(", ") });
            return;
          }
          nextCart = upData?.cartLinesUpdate?.cart;
        }
      } else if (quantity > 0) {
        const addData = await storefrontGraphql(STOREFRONT_CART_LINES_ADD, {
          cartId,
          lines: [{ merchandiseId, quantity }],
        });
        const errs = addData?.cartLinesAdd?.userErrors?.filter((e) => e?.message) || [];
        if (errs.length) {
          json(res, 400, { error: errs.map((e) => e.message).join(", ") });
          return;
        }
        nextCart = addData?.cartLinesAdd?.cart;
      }
      json(res, 200, {
        cartId,
        lines: mapStorefrontCartToClientLines(nextCart),
        totalQuantity: Number(nextCart?.totalQuantity || 0),
      });
    });
  } catch (error) {
    json(res, 500, { error: error.message });
  }
}

async function handleCartRemoveLine(req, res) {
  try {
    const customer = await resolveAuthCustomerForCart(req);
    if (!customer) {
      json(res, 401, { error: "Not authenticated." });
      return;
    }
    const body = await readJsonBody(req);
    const merchandiseId = normalizeStorefrontVariantGid(
      String(body.variantId || body.merchandiseId || "").trim()
    );
    if (!merchandiseId.startsWith("gid://shopify/ProductVariant/")) {
      json(res, 400, { error: "Invalid variant id." });
      return;
    }
    await runSerializedCustomerCartMutation(customer.id, async () => {
      let { cartId, cart } = await ensureCustomerStorefrontCart(customer.id);
      const existing = findCartLineForVariant(cart, merchandiseId);
      let nextCart = cart;
      if (existing) {
        const rmData = await storefrontGraphql(STOREFRONT_CART_LINES_REMOVE, {
          cartId,
          lineIds: [existing.lineId],
        });
        const errs = rmData?.cartLinesRemove?.userErrors?.filter((e) => e?.message) || [];
        if (errs.length) {
          json(res, 400, { error: errs.map((e) => e.message).join(", ") });
          return;
        }
        nextCart = rmData?.cartLinesRemove?.cart;
      }
      json(res, 200, {
        cartId,
        lines: mapStorefrontCartToClientLines(nextCart),
        totalQuantity: Number(nextCart?.totalQuantity || 0),
      });
    });
  } catch (error) {
    json(res, 500, { error: error.message });
  }
}

async function handleCartMerge(req, res) {
  try {
    const customer = await resolveAuthCustomerForCart(req);
    if (!customer) {
      json(res, 401, { error: "Not authenticated." });
      return;
    }
    const body = await readJsonBody(req);
    const guestLines = Array.isArray(body.lines) ? body.lines : [];
    await runSerializedCustomerCartMutation(customer.id, async () => {
      let { cartId, cart } = await ensureCustomerStorefrontCart(customer.id);

      /**
       * Sign-in merge: browser `lines` are the guest snapshot (often a preserved copy of the
       * same Storefront cart after sign-out). We must NOT add serverQty + guestQty or quantities
       * double every sign-in. Guest wins on overlapping variants; server-only lines stay.
       */
      const merged = new Map();
      for (const edge of cart?.lines?.edges || []) {
        const n = edge?.node;
        const m = n?.merchandise;
        if (m?.id) merged.set(m.id, Number(n.quantity || 0));
      }

      const guestByVariant = new Map();
      for (const gl of guestLines) {
        const vid = normalizeStorefrontVariantGid(String(gl.variantId || "").trim());
        if (!vid.startsWith("gid://shopify/ProductVariant/")) continue;
        const raw = Number(gl.quantity);
        const q = Number.isFinite(raw)
          ? Math.max(1, Math.min(99, Math.floor(raw)))
          : Math.max(1, Math.min(99, Number(gl.quantity || 1)));
        guestByVariant.set(vid, Math.min(99, (guestByVariant.get(vid) || 0) + q));
      }

      for (const [vid, gq] of guestByVariant) {
        merged.set(vid, gq);
      }

      const byVariant = merged;

      await removeAllStorefrontCartLines(cartId);

      const linesToAdd = [...byVariant.entries()].map(([merchandiseId, q]) => ({
        merchandiseId,
        quantity: q,
      }));
      if (linesToAdd.length) {
        const addData = await storefrontGraphql(STOREFRONT_CART_LINES_ADD, { cartId, lines: linesToAdd });
        const addErrs = addData?.cartLinesAdd?.userErrors?.filter((e) => e?.message) || [];
        if (addErrs.length) {
          json(res, 400, { error: addErrs.map((e) => e.message).join(", ") });
          return;
        }
      }

      const refreshed = await storefrontGraphql(STOREFRONT_CART_QUERY, { id: cartId });
      const nextCart = refreshed?.cart;
      json(res, 200, {
        lines: mapStorefrontCartToClientLines(nextCart),
        totalQuantity: Number(nextCart?.totalQuantity || 0),
      });
    });
  } catch (error) {
    json(res, 500, { error: error.message });
  }
}

/**
 * Normalize checkout `lines` from JSON (some proxies coerce arrays; tolerate object maps).
 */
function extractCheckoutLinesFromBody(body) {
  if (!body || typeof body !== "object") return [];
  const raw = body.lines;
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === "object") {
    return Object.values(raw).filter((x) => x && typeof x === "object");
  }
  return [];
}

/**
 * Rebuilds the customer's Storefront cart from browser line payloads (signed-in headless cart).
 * Used by /api/cart/replace and /api/checkout/shopify so checkout always matches localStorage.
 *
 * - Empty `requestedLines` + /api/cart/replace: clears the cart only.
 * - Non-empty rows but zero valid variants: throws (does not wipe the cart).
 */
function cartHasBuyableLines(cart) {
  if (!cart) return false;
  if (Number(cart.totalQuantity ?? 0) > 0) return true;
  for (const edge of cart.lines?.edges || []) {
    if (Number(edge?.node?.quantity ?? 0) > 0) return true;
  }
  return false;
}

function cartContainsVariantWithQty(cart, merchandiseId, minQty = 1) {
  for (const edge of cart?.lines?.edges || []) {
    const n = edge?.node;
    if (n?.merchandise?.id === merchandiseId && Number(n.quantity || 0) >= minQty) {
      return true;
    }
  }
  return false;
}

async function replaceCustomerCartLinesFromPayload(cartId, requestedLines) {
  const rows = Array.isArray(requestedLines) ? requestedLines : [];
  const byVariant = new Map();
  const labels = new Map();
  for (const line of rows) {
    const variantId = normalizeStorefrontVariantGid(String(line.variantId || "").trim());
    if (!variantId.startsWith("gid://shopify/ProductVariant/")) continue;
    const qty = Math.max(1, Math.min(99, Number(line.quantity || 1)));
    byVariant.set(variantId, Math.min(99, (byVariant.get(variantId) || 0) + qty));
    const label = [line.productTitle, line.variantTitle].filter(Boolean).join(" — ") || variantId;
    labels.set(variantId, label);
  }

  const linesToAdd = [...byVariant.entries()].map(([merchandiseId, quantity]) => ({
    merchandiseId,
    quantity,
  }));

  if (!linesToAdd.length) {
    if (rows.length === 0) {
      await removeAllStorefrontCartLines(cartId);
    } else {
      throw new Error(
        "No valid Shopify variant IDs in your cart. Open each product from the store and add it again, or remove test lines with bad IDs."
      );
    }
    return;
  }

  await removeAllStorefrontCartLines(cartId);

  const rejected = [];
  let lastCart = null;
  for (const { merchandiseId, quantity } of linesToAdd) {
    const addData = await storefrontGraphql(STOREFRONT_CART_LINES_ADD, {
      cartId,
      lines: [{ merchandiseId, quantity }],
    });
    const addErrs = addData?.cartLinesAdd?.userErrors?.filter((e) => e?.message) || [];
    lastCart = addData?.cartLinesAdd?.cart || lastCart;
    if (addErrs.length) {
      rejected.push({
        label: labels.get(merchandiseId) || merchandiseId,
        reason: addErrs.map((e) => e.message).join(", "),
      });
      continue;
    }
    if (!cartContainsVariantWithQty(lastCart, merchandiseId, quantity)) {
      rejected.push({
        label: labels.get(merchandiseId) || merchandiseId,
        reason: "Shopify did not keep this line (check Online Store publish and variant availability).",
      });
    }
  }

  if (cartHasBuyableLines(lastCart)) {
    if (rejected.length) {
      const names = rejected.map((r) => r.label).join(", ");
      throw new Error(
        `Some items could not be added to checkout: ${names}. Remove them and try again, or re-add from the product page.`
      );
    }
    return;
  }

  const refreshed = await storefrontGraphql(STOREFRONT_CART_QUERY, { id: cartId });
  const cartLive = refreshed?.cart;
  if (cartHasBuyableLines(cartLive)) {
    return;
  }

  if (rejected.length) {
    const details = rejected.map((r) => `${r.label}: ${r.reason}`).join(" ");
    throw new Error(`Checkout cart sync failed. ${details}`);
  }

  throw new Error(
    "Shopify did not keep any cart lines after add (check product is published to Online Store, variant is available for sale, and variant IDs match this shop)."
  );
}

async function handleCartReplace(req, res) {
  try {
    const customer = await resolveAuthCustomerForCart(req);
    if (!customer) {
      json(res, 401, { error: "Not authenticated." });
      return;
    }
    const body = await readJsonBody(req);
    const requestedLines = extractCheckoutLinesFromBody(body);
    await runSerializedCustomerCartMutation(customer.id, async () => {
      const { cartId } = await ensureCustomerStorefrontCart(customer.id);

      try {
        await replaceCustomerCartLinesFromPayload(cartId, requestedLines);
      } catch (e) {
        json(res, 400, { error: e.message || "Cart replace failed." });
        return;
      }

      const refreshed = await storefrontGraphql(STOREFRONT_CART_QUERY, { id: cartId });
      const nextCart = refreshed?.cart;
      json(res, 200, {
        lines: mapStorefrontCartToClientLines(nextCart),
        totalQuantity: Number(nextCart?.totalQuantity || 0),
      });
    });
  } catch (error) {
    json(res, 500, { error: error.message });
  }
}

/**
 * Returns a Shopify-hosted checkout URL for the customer's headless cart (signed in)
 * or a one-off Storefront cart built from `lines` (guest).
 * Expects `body.checkout`: { email, phone?, shipping: { firstName, lastName, phone?, address1, address2?, city, provinceCode?, zip, countryCode, countryName? } }.
 * Card data is never accepted (PCI); payment is completed on Shopify Checkout only.
 */
function buildCheckoutLinesMap(requestedLines) {
  const byVariant = new Map();
  for (const line of Array.isArray(requestedLines) ? requestedLines : []) {
    const variantId = normalizeStorefrontVariantGid(String(line.variantId || "").trim());
    if (!variantId.startsWith("gid://shopify/ProductVariant/")) continue;
    const qty = Math.max(1, Math.min(99, Number(line.quantity || 1)));
    byVariant.set(variantId, Math.min(99, (byVariant.get(variantId) || 0) + qty));
  }
  return byVariant;
}

/** Guest-style cart create (works when replace-on-existing-cart fails for signed-in users). */
async function createFreshStorefrontCartFromCheckoutLines(requestedLines, checkout) {
  const byVariant = buildCheckoutLinesMap(requestedLines);
  const linesToAdd = [...byVariant.entries()].map(([merchandiseId, quantity]) => ({
    merchandiseId,
    quantity: Math.floor(Number(quantity)),
  }));
  if (!linesToAdd.length) {
    throw new Error("Your cart is empty. Add items before checkout.");
  }

  const countryCode = String(checkout.shipping?.countryCode || "")
    .trim()
    .toUpperCase();
  const phone = String(checkout.phone || "").trim();
  const created = await storefrontGraphql(STOREFRONT_CART_CREATE_WITH_INPUT, {
    input: {
      lines: linesToAdd,
      buyerIdentity: {
        email: String(checkout.email || "").trim(),
        ...(phone ? { phone } : {}),
        ...(countryCode ? { countryCode } : {}),
      },
    },
  });
  const payload = created?.cartCreate;
  const createErrs = payload?.userErrors?.filter((e) => e?.message) || [];
  if (createErrs.length) {
    throw new Error(createErrs.map((e) => e.message).join(", "));
  }
  const cartId = String(payload?.cart?.id || "").trim();
  if (!cartId) {
    throw new Error("Unable to create checkout cart.");
  }
  return { cartId, byVariant };
}

async function handleShopifyCheckout(req, res) {
  try {
    if (!STOREFRONT_ACCESS_TOKEN || !SHOP_FROM_ENV) {
      json(res, 503, { error: "Storefront checkout is not configured on the server." });
      return;
    }
    const body = await readJsonBody(req);
    const checkout = body.checkout || {};
    const checkoutErr = validateFlexcaseCheckoutPayload(checkout);
    if (checkoutErr) {
      json(res, 400, { error: checkoutErr });
      return;
    }

    const customer = await resolveAuthCustomerForCart(req);

    if (customer) {
      let checkoutUrl = "";
      let customerCartIdForResponse = "";
      let errMsg = "";
      try {
        await runSerializedCustomerCartMutation(customer.id, async () => {
          let { cartId } = await ensureCustomerStorefrontCart(customer.id);
          customerCartIdForResponse = cartId;
          const syncLines = extractCheckoutLinesFromBody(body);
          if (syncLines.length) {
            try {
              await replaceCustomerCartLinesFromPayload(cartId, syncLines);
            } catch (replaceError) {
              console.warn(
                "Signed-in cart replace failed; creating fresh Storefront cart:",
                replaceError.message
              );
              try {
                const fresh = await createFreshStorefrontCartFromCheckoutLines(syncLines, checkout);
                cartId = fresh.cartId;
                customerCartIdForResponse = cartId;
                await setCustomerHeadlessCartId(customer.id, cartId);
              } catch (freshError) {
                errMsg = freshError.message || "Unable to sync your cart before checkout.";
                return;
              }
            }
          }
          const refreshed0 = await storefrontGraphql(STOREFRONT_CART_QUERY, { id: cartId });
          const totalQuantity0 = Number(refreshed0?.cart?.totalQuantity || 0);
          if (!totalQuantity0) {
            errMsg =
              syncLines.length > 0
                ? "Your cart could not be synced to Shopify. Check that every line uses a real product variant from this store."
                : "Your cart is empty. Add items before checkout.";
            return;
          }
          try {
            await applyFlexcaseCheckoutToStorefrontCart(cartId, checkout);
          } catch (e) {
            errMsg = e.message || "Unable to apply checkout details.";
            return;
          }
          const refreshed = await storefrontGraphql(STOREFRONT_CART_QUERY, { id: cartId });
          const fallbackLines = mapStorefrontCartToClientLines(refreshed?.cart);
          checkoutUrl = mergeFlexcaseCheckoutPrefillQueryParams(
            pickShopifyCheckoutRedirectUrl(refreshed?.cart?.checkoutUrl, fallbackLines),
            checkout
          );
          const totalQuantity = Number(refreshed?.cart?.totalQuantity || 0);
          if (!totalQuantity || !checkoutUrl) {
            errMsg =
              errMsg ||
              "Shopify did not return a valid checkout link. Check your shipping address and that checkout is enabled for this store.";
            checkoutUrl = "";
          }
        });
      } catch (error) {
        json(res, 500, { error: error.message });
        return;
      }
      if (errMsg) {
        json(res, 400, { error: errMsg });
        return;
      }
      json(res, 200, { checkoutUrl, cartId: customerCartIdForResponse });
      return;
    }

    const requestedLines = extractCheckoutLinesFromBody(body);
    let cartId = "";
    let byVariant = new Map();
    try {
      const fresh = await createFreshStorefrontCartFromCheckoutLines(requestedLines, checkout);
      cartId = fresh.cartId;
      byVariant = fresh.byVariant;
    } catch (e) {
      json(res, 400, { error: e.message || "Your cart is empty. Add items before checkout." });
      return;
    }

    const deliveryAddress = buildCartDeliveryAddressInput(checkout.shipping || {});
    const replaceRes = await storefrontGraphql(STOREFRONT_CART_DELIVERY_REPLACE, {
      cartId,
      addresses: [
        {
          selected: true,
          oneTimeUse: true,
          validationStrategy: "COUNTRY_CODE_ONLY",
          address: { deliveryAddress },
        },
      ],
    });
    const repErrs = replaceRes?.cartDeliveryAddressesReplace?.userErrors?.filter((e) => e?.message) || [];
    if (repErrs.length) {
      json(res, 400, { error: repErrs.map((e) => e.message).join(", ") });
      return;
    }

    const refreshed = await storefrontGraphql(STOREFRONT_CART_QUERY, { id: cartId });
    const cart = refreshed?.cart;
    const fallbackLines = [...byVariant.entries()].map(([variantId, quantity]) => ({ variantId, quantity }));
    const checkoutUrl = mergeFlexcaseCheckoutPrefillQueryParams(
      pickShopifyCheckoutRedirectUrl(cart?.checkoutUrl, fallbackLines),
      checkout
    );
    const totalQuantity = Number(cart?.totalQuantity || 0);
    if (!totalQuantity || !checkoutUrl) {
      json(res, 400, {
        error:
          "Shopify did not return a valid checkout link. Check your shipping address, country, and that Online Store checkout is enabled.",
      });
      return;
    }
    json(res, 200, { checkoutUrl, cartId });
  } catch (error) {
    json(res, 500, { error: error.message });
  }
}

/**
 * Reports whether a Storefront cart still exists. Shopify deletes the Cart object once an
 * order is created from it, so a missing cart is a reliable "order completed (or expired)"
 * signal we use to clear localStorage for both guest and signed-in buyers after handoff.
 */
async function handleStorefrontCartStatus(req, res) {
  try {
    if (!STOREFRONT_ACCESS_TOKEN || !SHOP_FROM_ENV) {
      json(res, 503, { error: "Storefront is not configured on the server." });
      return;
    }
    const reqUrl = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);
    const rawId = String(reqUrl.searchParams.get("cartId") || "").trim();
    if (!rawId || !rawId.startsWith("gid://shopify/Cart/")) {
      json(res, 400, { error: "Invalid cart id." });
      return;
    }
    // Bubble up errors so the client treats it as "unknown" and does not clear the cart.
    // A successful response with cart=null is Shopify's reliable "cart was completed" signal.
    const data = await storefrontGraphql(STOREFRONT_CART_QUERY, { id: rawId });
    const cart = data?.cart || null;
    if (!cart) {
      json(res, 200, { exists: false, totalQuantity: 0, completed: true });
      return;
    }
    const totalQuantity = Number(cart.totalQuantity || 0);
    json(res, 200, {
      exists: true,
      totalQuantity,
      completed: false,
    });
  } catch (error) {
    json(res, 502, { error: error.message || "Storefront cart status unavailable." });
  }
}

async function handleCartClear(req, res) {
  try {
    const customer = await resolveAuthCustomerForCart(req);
    if (!customer) {
      json(res, 401, { error: "Not authenticated." });
      return;
    }
    await runSerializedCustomerCartMutation(customer.id, async () => {
      const cartId = await getCustomerHeadlessCartId(customer.id);
      if (!cartId) {
        json(res, 200, { ok: true });
        return;
      }
      try {
        await removeAllStorefrontCartLines(cartId);
      } catch (_) {
        /* ignore */
      }
      json(res, 200, { ok: true });
    });
  } catch (error) {
    json(res, 500, { error: error.message });
  }
}

async function handleCustomerAddressDefault(req, res) {
  try {
    const current = getCustomerSession(req);
    if (!current?.session?.customer?.email) {
      json(res, 401, { error: "Not authenticated." });
      return;
    }
    const body = await readJsonBody(req);
    const addressId = String(body.id || "").trim();
    if (!addressId) {
      json(res, 400, { error: "Address id is required." });
      return;
    }
    const currentEmail = String(current.session.customer.email || "").trim().toLowerCase();
    const customer = await findCustomerByEmail(currentEmail);
    if (!customer?.id) {
      json(res, 404, { error: "Customer record not found." });
      return;
    }

    const mutation = `
      mutation CustomerUpdateDefaultAddress($customerId: ID!, $addressId: ID!) {
        customerUpdateDefaultAddress(customerId: $customerId, addressId: $addressId) {
          customer {
            id
            defaultAddress {
              id
            }
          }
          userErrors {
            field
            message
          }
        }
      }
    `;
    const data = await adminGraphql(mutation, {
      customerId: customer.id,
      addressId,
    });
    const payload = data?.customerUpdateDefaultAddress;
    if (payload?.userErrors?.length) {
      json(res, 400, {
        error: payload.userErrors.map((e) => e.message).join(", "),
      });
      return;
    }
    json(res, 200, { ok: true });
  } catch (error) {
    json(res, 500, { error: error.message });
  }
}

function handleCustomerLogout(req, res) {
  const reqUrl = new URL(req.url, "http://localhost");
  const fallbackReturnTo = `${FRONTEND_ORIGIN}/account.html`;
  let returnTo = fallbackReturnTo;
  const requestedNext = String(reqUrl.searchParams.get("next") || "").trim();
  if (requestedNext) {
    try {
      const candidate = new URL(requestedNext);
      if (candidate.origin === API_ORIGIN || candidate.origin === FRONTEND_ORIGIN) {
        returnTo = candidate.toString();
      }
    } catch (_) {
      // Ignore invalid custom return URLs.
    }
  }
  const current = getCustomerSession(req);
  const idTokenHint = String(current?.session?.idToken || "").trim();
  let location = returnTo;
  if (CUSTOMER_ACCOUNT_LOGOUT_ENDPOINT && idTokenHint) {
    const logoutUrl = new URL(CUSTOMER_ACCOUNT_LOGOUT_ENDPOINT);
    logoutUrl.searchParams.set("post_logout_redirect_uri", returnTo);
    logoutUrl.searchParams.set("id_token_hint", idTokenHint);
    location = logoutUrl.toString();
  }
  res.writeHead(302, {
    Location: location,
    "Set-Cookie": clearSessionCookie(),
  });
  res.end();
}

function handleCustomerLogoutApi(req, res) {
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
  if (req.method === "POST" && reqUrl.pathname === "/api/customer/profile") {
    await handleCustomerProfileUpdate(req, res);
    return;
  }
  if (req.method === "POST" && reqUrl.pathname === "/api/customer/address") {
    await handleCustomerAddressCreate(req, res);
    return;
  }
  if (req.method === "POST" && reqUrl.pathname === "/api/customer/address/delete") {
    await handleCustomerAddressDelete(req, res);
    return;
  }
  if (req.method === "POST" && reqUrl.pathname === "/api/customer/address/default") {
    await handleCustomerAddressDefault(req, res);
    return;
  }
  if (req.method === "POST" && reqUrl.pathname === "/api/cart/add") {
    await handleCartAddLine(req, res);
    return;
  }
  if (req.method === "POST" && reqUrl.pathname === "/api/cart/set-quantity") {
    await handleCartSetLineQuantity(req, res);
    return;
  }
  if (req.method === "POST" && reqUrl.pathname === "/api/cart/remove-line") {
    await handleCartRemoveLine(req, res);
    return;
  }
  if (req.method === "POST" && reqUrl.pathname === "/api/cart/merge") {
    await handleCartMerge(req, res);
    return;
  }
  if (req.method === "POST" && reqUrl.pathname === "/api/cart/replace") {
    await handleCartReplace(req, res);
    return;
  }
  if (req.method === "POST" && reqUrl.pathname === "/api/cart/clear") {
    await handleCartClear(req, res);
    return;
  }
  if (req.method === "POST" && reqUrl.pathname === "/api/checkout/shopify") {
    await handleShopifyCheckout(req, res);
    return;
  }
  const productReviewMatch = reqUrl.pathname.match(/^\/api\/product\/([^/]+)\/reviews$/);
  if (req.method === "POST" && productReviewMatch) {
    const handle = decodeURIComponent(productReviewMatch[1] || "").trim();
    await handleProductReviewSubmit(req, res, handle);
    return;
  }

  if (req.method !== "GET") {
    res.writeHead(405);
    res.end("Method Not Allowed");
    return;
  }

  if (reqUrl.pathname === "/api/health") {
    const storefrontOk = Boolean(STOREFRONT_ACCESS_TOKEN);
    json(res, 200, {
      ok: true,
      shop: SHOP_FROM_ENV,
      apiVersion: API_VERSION_FROM_ENV,
      storefrontTokenConfigured: storefrontOk,
      storefrontHint: storefrontOk
        ? null
        : "Set SHOPIFY_STOREFRONT_ACCESS_TOKEN in Railway (Storefront API app with cart + product scopes).",
      customerAccountConfigured: Boolean(
        CUSTOMER_ACCOUNT_CLIENT_ID &&
          CUSTOMER_ACCOUNT_AUTHORIZATION_ENDPOINT &&
          CUSTOMER_ACCOUNT_TOKEN_ENDPOINT
      ),
      judgeMeConfigured: judgeMeConfigured(),
      judgeMeHint: judgeMeConfigured()
        ? null
        : "Set JUDGE_ME_API_TOKEN and JUDGE_ME_SHOP_DOMAIN for headless Judge.me reviews.",
    });
    return;
  }
  if (reqUrl.pathname === "/api/version") {
    json(res, 200, {
      ok: true,
      service: "flexcase-api",
      commit: DEPLOY_COMMIT_SHA || "unknown",
      shortCommit: DEPLOY_COMMIT_SHA ? DEPLOY_COMMIT_SHA.slice(0, 7) : "unknown",
      branch: DEPLOY_BRANCH || "unknown",
      now: new Date().toISOString(),
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
  if (reqUrl.pathname === "/api/customer/session/debug") {
    handleCustomerSessionDebug(req, res);
    return;
  }
  if (reqUrl.pathname === "/api/cart") {
    await handleCartGet(req, res);
    return;
  }
  if (reqUrl.pathname === "/api/cart/storefront-status") {
    await handleStorefrontCartStatus(req, res);
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
  if (reqUrl.pathname.startsWith("/review-media/")) {
    serveReviewMedia(req, res, reqUrl.pathname);
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

