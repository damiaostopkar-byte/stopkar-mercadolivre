import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";

interface Env {
  MELI_CLIENT_ID?: string;
  MELI_CLIENT_SECRET?: string;
  MELI_REDIRECT_URI?: string;
  MCP_SHARED_SECRET?: string;
  MELI_TOKENS?: KVNamespace;
  ADS_WRITES_ENABLED?: string;
  LISTING_WRITES_ENABLED?: string;
  PROMOTION_WRITES_ENABLED?: string;
}

type StoredToken = {
  access_token: string;
  refresh_token: string;
  token_type: string;
  scope?: string;
  user_id?: number;
  expires_at: number;
};

const MELI_API = "https://api.mercadolibre.com";
const MELI_AUTH = "https://auth.mercadolivre.com.br/authorization";
const TOKEN_KEY = "mercadolivre:oauth:tokens";
const SAO_PAULO_TZ = "America/Sao_Paulo";
const SERVER_VERSION = "0.13.4";

function textResult(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(value, null, 2)
      }
    ]
  };
}

function requireOAuthConfig(env: Env) {
  if (!env.MELI_CLIENT_ID || !env.MELI_CLIENT_SECRET || !env.MELI_REDIRECT_URI) {
    throw new Error("Credenciais OAuth do Mercado Livre ainda nao configuradas na Cloudflare.");
  }
  if (!env.MELI_TOKENS) {
    throw new Error("Binding MELI_TOKENS ainda nao configurado na Cloudflare.");
  }

  return {
    clientId: env.MELI_CLIENT_ID,
    clientSecret: env.MELI_CLIENT_SECRET,
    redirectUri: env.MELI_REDIRECT_URI,
    tokens: env.MELI_TOKENS
  };
}

async function postToken(env: Env, params: Record<string, string>): Promise<any> {
  const { clientId, clientSecret } = requireOAuthConfig(env);
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    ...params
  });

  const response = await fetch(`${MELI_API}/oauth/token`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body
  });

  const raw = await response.text();
  let data: any;
  try {
    data = raw ? JSON.parse(raw) : null;
  } catch {
    data = raw;
  }

  if (!response.ok) {
    const message =
      data && typeof data === "object"
        ? data.message || data.error || JSON.stringify(data)
        : String(data);
    throw new Error(`OAuth Mercado Livre ${response.status}: ${message}`);
  }

  return data;
}

async function saveTokenResponse(env: Env, data: any): Promise<StoredToken> {
  const { tokens } = requireOAuthConfig(env);
  if (!data?.access_token || !data?.refresh_token) {
    throw new Error("Resposta OAuth do Mercado Livre nao trouxe access_token/refresh_token.");
  }

  const token: StoredToken = {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    token_type: data.token_type || "Bearer",
    scope: data.scope,
    user_id: data.user_id,
    expires_at: Date.now() + Number(data.expires_in || 21600) * 1000
  };

  await tokens.put(TOKEN_KEY, JSON.stringify(token));
  return token;
}

async function loadToken(env: Env): Promise<StoredToken | null> {
  const { tokens } = requireOAuthConfig(env);
  return (await tokens.get(TOKEN_KEY, "json")) as StoredToken | null;
}

async function refreshToken(env: Env): Promise<StoredToken> {
  const current = await loadToken(env);
  if (!current?.refresh_token) {
    throw new Error("Mercado Livre ainda nao autorizado. Abra /oauth/start para conectar a conta.");
  }

  try {
    const data = await postToken(env, {
      grant_type: "refresh_token",
      refresh_token: current.refresh_token
    });
    return await saveTokenResponse(env, data);
  } catch (error) {
    await new Promise((resolve) => setTimeout(resolve, 750));
    const latest = await loadToken(env);
    if (
      latest?.access_token &&
      latest.access_token !== current.access_token &&
      latest.expires_at > Date.now() + 30_000
    ) {
      return latest;
    }
    throw error;
  }
}

async function getAccessToken(env: Env): Promise<string> {
  const token = await loadToken(env);
  if (!token?.access_token) {
    throw new Error("Mercado Livre ainda nao autorizado. Abra /oauth/start para conectar a conta.");
  }

  if (token.expires_at <= Date.now() + 60_000) {
    return (await refreshToken(env)).access_token;
  }

  return token.access_token;
}

async function parseApiResponse(response: Response): Promise<any> {
  if (response.status === 204) return null;
  const raw = await response.text();
  try {
    return raw ? JSON.parse(raw) : null;
  } catch {
    return raw;
  }
}


async function meliSellerPromotionWrite(
  env: Env,
  method: MeliWriteMethod,
  itemId: string,
  sellerId: string,
  body?: unknown,
  query: Record<string, string | undefined> = {}
): Promise<{ data: any; path_used: string; flow: string }> {
  const oldUrl = new URL(
    `/seller-promotions/items/${encodeURIComponent(itemId)}`,
    MELI_API
  );
  oldUrl.searchParams.set("app_version", "v2");
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== "") oldUrl.searchParams.set(key, value);
  }

  const marketplaceUrl = new URL(
    `/marketplace/seller-promotions/items/${encodeURIComponent(itemId)}`,
    MELI_API
  );
  marketplaceUrl.searchParams.set("user_id", sellerId);
  marketplaceUrl.searchParams.set("callers", sellerId);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== "") marketplaceUrl.searchParams.set(key, value);
  }

  const attempts: Array<{ flow: string; status: number; message: string }> = [];
  const candidates = [
    {
      flow: "local_v2",
      url: oldUrl,
      headers: {} as Record<string, string>
    },
    {
      flow: "marketplace_v2",
      url: marketplaceUrl,
      headers: {
        version: "v2",
        ...(env.MELI_CLIENT_ID
          ? {
              "X-Client-Id": String(env.MELI_CLIENT_ID),
              "X-Caller-Id": String(env.MELI_CLIENT_ID)
            }
          : {})
      } as Record<string, string>
    }
  ];

  for (const candidate of candidates) {
    let accessToken = await getAccessToken(env);
    const makeRequest = (token: string) =>
      fetch(candidate.url.toString(), {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          ...candidate.headers
        },
        body: body === undefined ? undefined : JSON.stringify(body)
      });

    let response = await makeRequest(accessToken);
    if (response.status === 401) {
      accessToken = (await refreshToken(env)).access_token;
      response = await makeRequest(accessToken);
    }

    const data = await parseApiResponse(response);
    if (response.ok || response.status === 204) {
      return {
        data,
        path_used: candidate.url.pathname + candidate.url.search,
        flow: candidate.flow
      };
    }

    const message =
      data && typeof data === "object"
        ? data.message || data.error || JSON.stringify(data)
        : String(data);
    attempts.push({ flow: candidate.flow, status: response.status, message });

    const normalized = String(message || "").toLowerCase();
    const canFallback =
      candidate.flow === "local_v2" &&
      (
        response.status === 404 ||
        response.status === 403 ||
        normalized.includes("no offers found for item") ||
        normalized.includes("resource not found") ||
        normalized.includes("invalid promotion type")
      );

    if (canFallback) continue;

    throw new Error(
      `Falha de escrita de promocao. Tentativas: ${attempts
        .map((attempt) => `${attempt.flow} ${attempt.status} -> ${attempt.message}`)
        .join(" | ")}`
    );
  }

  throw new Error(
    `Falha de escrita de promocao. Tentativas: ${attempts
      .map((attempt) => `${attempt.flow} ${attempt.status} -> ${attempt.message}`)
      .join(" | ")}`
  );
}

async function meliGet(
  env: Env,
  path: string,
  params: Record<string, string | undefined> = {},
  extraHeaders: Record<string, string> = {}
): Promise<any> {
  const url = new URL(path, MELI_API);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") {
      url.searchParams.set(key, value);
    }
  }

  let accessToken = await getAccessToken(env);
  const makeRequest = (token: string) =>
    fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        ...extraHeaders
      }
    });

  let response = await makeRequest(accessToken);

  if (response.status === 401) {
    accessToken = (await refreshToken(env)).access_token;
    response = await makeRequest(accessToken);
  }

  const data = await parseApiResponse(response);

  if (!response.ok && response.status !== 204) {
    const message =
      data && typeof data === "object"
        ? data.message || data.error || JSON.stringify(data)
        : String(data);
    throw new Error(`Mercado Livre API ${response.status}: ${message}`);
  }

  return data;
}


type MeliWriteMethod = "POST" | "PUT" | "DELETE";

async function meliWrite(
  env: Env,
  method: MeliWriteMethod,
  path: string,
  body?: unknown,
  extraHeaders: Record<string, string> = {}
): Promise<{ data: any; path_used: string }> {
  const candidatePaths = path.startsWith("/marketplace/advertising/")
    ? [path.replace("/marketplace/advertising/", "/advertising/"), path]
    : [path];
  const failureLabel = candidatePaths.some((candidatePath) =>
    candidatePath.includes("/advertising/")
  )
    ? "Falha de escrita Product Ads"
    : "Falha de escrita Mercado Livre";

  let lastError: Error | null = null;
  const attempts: Array<{ path: string; status: number; message: string }> = [];

  for (let index = 0; index < candidatePaths.length; index += 1) {
    const candidatePath = candidatePaths[index];
    const url = new URL(candidatePath, MELI_API);
    let accessToken = await getAccessToken(env);

    const makeRequest = (token: string) =>
      fetch(url.toString(), {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          ...extraHeaders
        },
        body: body === undefined ? undefined : JSON.stringify(body)
      });

    let response = await makeRequest(accessToken);
    if (response.status === 401) {
      accessToken = (await refreshToken(env)).access_token;
      response = await makeRequest(accessToken);
    }

    const data = await parseApiResponse(response);
    if (response.ok || response.status === 204) {
      return { data, path_used: candidatePath };
    }

    const message =
      data && typeof data === "object"
        ? data.message || data.error || JSON.stringify(data)
        : String(data);
    attempts.push({
      path: candidatePath,
      status: response.status,
      message
    });
    const error = new Error(`Mercado Livre API ${response.status}: ${message}`);

    if ([401, 403, 404].includes(response.status) && index < candidatePaths.length - 1) {
      lastError = error;
      continue;
    }

    throw new Error(
      `${failureLabel}. Tentativas: ${attempts
        .map((attempt) => `${attempt.status} ${attempt.path} -> ${attempt.message}`)
        .join(" | ")}`
    );
  }

  if (attempts.length > 0) {
    throw new Error(
      `${failureLabel}. Tentativas: ${attempts
        .map((attempt) => `${attempt.status} ${attempt.path} -> ${attempt.message}`)
        .join(" | ")}`
    );
  }

  throw lastError ?? new Error("Falha desconhecida ao gravar no Mercado Livre.");
}

function formatSaoPaulo(value: unknown) {
  if (typeof value !== "string" || !value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;

  return new Intl.DateTimeFormat("pt-BR", {
    timeZone: SAO_PAULO_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(date);
}

function getSellerSku(item: any) {
  if (typeof item?.seller_sku === "string" && item.seller_sku) return item.seller_sku;
  if (!Array.isArray(item?.attributes)) return null;
  const sellerSku = item.attributes.find((attribute: any) => attribute?.id === "SELLER_SKU");
  return sellerSku?.value_name ?? sellerSku?.values?.[0]?.name ?? null;
}

function compactListing(item: any) {
  return {
    id: item.id,
    title: item.title,
    status: item.status,
    sub_status: item.sub_status,
    category_id: item.category_id,
    price: item.price,
    base_price: item.base_price,
    original_price: item.original_price,
    currency_id: item.currency_id,
    available_quantity: item.available_quantity,
    sold_quantity: item.sold_quantity,
    seller_sku: getSellerSku(item),
    seller_custom_field: item.seller_custom_field,
    listing_type_id: item.listing_type_id,
    inventory_id: item.inventory_id,
    user_product_id: item.user_product_id ?? null,
    family_id: item.family_id ?? null,
    family_name: item.family_name ?? null,
    catalog_product_id: item.catalog_product_id ?? null,
    channels: Array.isArray(item.channels) ? item.channels : [],
    tags: Array.isArray(item.tags) ? item.tags : [],
    permalink: item.permalink,
    logistic_type: item.shipping?.logistic_type,
    shipping_mode: item.shipping?.mode ?? null,
    free_shipping: item.shipping?.free_shipping,
    catalog_listing: item.catalog_listing ?? false,
    date_created: item.date_created ?? null,
    date_created_sao_paulo: formatSaoPaulo(item.date_created),
    last_updated: item.last_updated ?? null,
    last_updated_sao_paulo: formatSaoPaulo(item.last_updated),
    pictures_count: Array.isArray(item.pictures) ? item.pictures.length : 0
  };
}

function compactItem(item: any) {
  return {
    ...compactListing(item),
    variations: Array.isArray(item.variations)
      ? item.variations.map((variation: any) => ({
          id: variation.id,
          price: variation.price,
          available_quantity: variation.available_quantity,
          sold_quantity: variation.sold_quantity,
          seller_sku: getSellerSku(variation),
          seller_custom_field: variation.seller_custom_field,
          inventory_id: variation.inventory_id,
          attributes: Array.isArray(variation.attribute_combinations)
            ? variation.attribute_combinations.map((attribute: any) => ({
                id: attribute.id,
                name: attribute.name,
                value_id: attribute.value_id,
                value_name: attribute.value_name
              }))
            : []
        }))
      : []
  };
}

function compactOrder(order: any) {
  return {
    id: order.id,
    status: order.status,
    date_created: order.date_created,
    date_created_sao_paulo: formatSaoPaulo(order.date_created),
    date_closed: order.date_closed,
    date_closed_sao_paulo: formatSaoPaulo(order.date_closed),
    total_amount: order.total_amount,
    paid_amount: order.paid_amount,
    currency_id: order.currency_id,
    pack_id: order.pack_id,
    shipping_id: order.shipping?.id ?? null,
    items: Array.isArray(order.order_items)
      ? order.order_items.map((orderItem: any) => ({
          item_id: orderItem.item?.id,
          title: orderItem.item?.title,
          seller_sku: orderItem.item?.seller_sku,
          variation_id: orderItem.item?.variation_id,
          quantity: orderItem.quantity,
          unit_price: orderItem.unit_price,
          full_unit_price: orderItem.full_unit_price,
          sale_fee: orderItem.sale_fee
        }))
      : []
  };
}

function chunkArray<T>(values: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

const ITEM_FIELDS = [
  "id",
  "title",
  "status",
  "sub_status",
  "category_id",
  "condition",
  "price",
  "base_price",
  "original_price",
  "currency_id",
  "available_quantity",
  "sold_quantity",
  "listing_type_id",
  "seller_custom_field",
  "inventory_id",
  "user_product_id",
  "family_id",
  "family_name",
  "catalog_product_id",
  "channels",
  "tags",
  "permalink",
  "shipping",
  "catalog_listing",
  "date_created",
  "last_updated",
  "pictures",
  "attributes"
];

const BULK_ITEM_ATTRIBUTES = ITEM_FIELDS.map((field) => `body.${field}`).join(",");
const LEGACY_ITEM_ATTRIBUTES = ITEM_FIELDS.join(",");

function unwrapMultiGet(payload: any) {
  const entries = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.results)
      ? payload.results
      : [];

  return entries.flatMap((entry: any) => {
    const status = Number(entry?.status_code ?? entry?.code ?? entry?.status ?? 200);
    const body = entry?.body ?? (entry?.id && entry?.title ? entry : null);
    if (!body || status < 200 || status >= 300) return [];
    return [body];
  });
}

async function getItemsBulk(env: Env, ids: string[]) {
  if (ids.length === 0) {
    return { items: [] as any[], source: "none", errors: [] as string[] };
  }

  const batches = chunkArray(ids, 20);
  const items: any[] = [];
  const errors: string[] = [];
  let usedBulk = false;
  let usedLegacy = false;

  for (const batch of batches) {
    let parsed: any[] = [];

    try {
      const response = await meliGet(env, "/items/bulk", {
        ids: batch.join(","),
        attributes: BULK_ITEM_ATTRIBUTES
      });
      parsed = unwrapMultiGet(response);
      if (parsed.length > 0) usedBulk = true;
    } catch (error) {
      errors.push(`bulk: ${error instanceof Error ? error.message : String(error)}`);
    }

    if (parsed.length === 0) {
      try {
        const legacy = await meliGet(env, "/items", {
          ids: batch.join(","),
          attributes: LEGACY_ITEM_ATTRIBUTES
        });
        parsed = unwrapMultiGet(legacy);
        if (parsed.length > 0) usedLegacy = true;
      } catch (error) {
        errors.push(`legacy: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    items.push(...parsed);
  }

  return {
    items,
    source: usedBulk && usedLegacy ? "items_bulk+legacy" : usedBulk ? "items_bulk" : usedLegacy ? "items_legacy" : "none",
    errors
  };
}


function listingWritesEnabled(env: Env) {
  return String(env.LISTING_WRITES_ENABLED || "").trim().toLowerCase() === "true";
}

function requireListingWritesEnabled(env: Env) {
  if (!listingWritesEnabled(env)) {
    throw new Error(
      "Escrita de anuncios desabilitada no servidor. Ative LISTING_WRITES_ENABLED=true antes de gravar."
    );
  }
}


function promotionWritesEnabled(env: Env) {
  return String(env.PROMOTION_WRITES_ENABLED || "").trim().toLowerCase() === "true";
}

function requirePromotionWritesEnabled(env: Env) {
  if (!promotionWritesEnabled(env)) {
    throw new Error(
      "Escrita de promocoes desabilitada no servidor. Ative PROMOTION_WRITES_ENABLED=true antes de gravar."
    );
  }
}

async function recordOperationAudit(env: Env, prefix: string, entry: Record<string, unknown>) {
  if (!env.MELI_TOKENS) return null;
  const timestamp = new Date().toISOString();
  const id = crypto.randomUUID();
  await env.MELI_TOKENS.put(
    `${prefix}:${timestamp}:${id}`,
    JSON.stringify({ id, timestamp, ...entry }),
    { expirationTtl: 60 * 60 * 24 * 180 }
  );
  return id;
}

async function getItemPromotions(env: Env, itemId: string) {
  const data = await meliGet(
    env,
    `/seller-promotions/items/${encodeURIComponent(itemId)}`,
    { app_version: "v2" }
  );
  return Array.isArray(data)
    ? data
    : Array.isArray(data?.results)
      ? data.results
      : [];
}

function promotionIdOf(entry: any) {
  return String(entry?.promotion_id ?? entry?.id ?? "");
}

async function chooseListingForWrite(
  env: Env,
  reference: string,
  mlbId?: string
) {
  const resolved = await resolveListingReference(env, reference);
  const items = resolved.items;
  if (items.length === 0) {
    throw new Error("Nenhum item foi encontrado para a referencia informada.");
  }
  if (mlbId) {
    const selected = items.find((item: any) => String(item?.id) === String(mlbId));
    if (!selected) {
      throw new Error("O mlb_id informado nao pertence ao MLB/MLBU consultado.");
    }
    return { resolved, selected, ambiguous: items.length > 1 };
  }
  if (items.length > 1) {
    return { resolved, selected: null, ambiguous: true };
  }
  return { resolved, selected: items[0], ambiguous: false };
}

async function resolveListingReference(env: Env, reference: string) {
  const normalized = String(reference || "").trim().toUpperCase();
  const me = await meliGet(env, "/users/me");

  if (/^MLB\d+$/.test(normalized)) {
    const item = await meliGet(env, `/items/${encodeURIComponent(normalized)}`, {
      include_attributes: "all"
    });
    if (String(item?.seller_id ?? "") !== String(me?.id ?? "")) {
      throw new Error("O MLB informado nao pertence a conta autorizada da Stop Kar.");
    }
    return {
      reference_type: "item",
      reference: normalized,
      user_product_id: item?.user_product_id ?? null,
      item_ids: [normalized],
      items: [item],
      errors: [] as string[]
    };
  }

  if (!/^MLBU\d+$/.test(normalized)) {
    throw new Error("Informe um codigo valido no formato MLB123... ou MLBU123....");
  }

  const search = await meliGet(
    env,
    `/users/${encodeURIComponent(String(me.id))}/items/search`,
    {
      user_product_id: normalized,
      limit: "50"
    }
  );

  const ids = Array.isArray(search?.results)
    ? search.results
        .map((entry: any) => (typeof entry === "string" ? entry : entry?.id))
        .filter((id: unknown): id is string => typeof id === "string" && /^MLB\d+$/.test(id))
    : [];

  if (ids.length === 0) {
    throw new Error(`Nenhum item MLB da Stop Kar foi encontrado para o User Product ${normalized}.`);
  }

  const bulk = await getItemsBulk(env, ids);
  const byId = new Map(
    bulk.items.map((item: any) => [String(item?.id || ""), item] as const)
  );
  const errors = [...bulk.errors];

  for (const id of ids) {
    if (byId.has(id)) continue;
    try {
      const item = await meliGet(env, `/items/${encodeURIComponent(id)}`, {
        include_attributes: "all"
      });
      byId.set(id, item);
    } catch (error) {
      errors.push(`${id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const items = ids.map((id) => byId.get(id)).filter(Boolean);
  if (items.length === 0) {
    throw new Error(
      `O User Product ${normalized} foi localizado, mas os detalhes dos itens nao puderam ser consultados.`
    );
  }

  return {
    reference_type: "user_product",
    reference: normalized,
    user_product_id: normalized,
    item_ids: ids,
    items,
    errors
  };
}

async function recordListingAudit(env: Env, entry: Record<string, unknown>) {
  if (!env.MELI_TOKENS) return null;
  const timestamp = new Date().toISOString();
  const id = crypto.randomUUID();
  const key = `listing:audit:${timestamp}:${id}`;
  await env.MELI_TOKENS.put(
    key,
    JSON.stringify({
      id,
      timestamp,
      ...entry
    }),
    { expirationTtl: 60 * 60 * 24 * 180 }
  );
  return id;
}

async function getOrderShipments(env: Env, orderId: string | number) {
  const data = await meliGet(
    env,
    `/orders/${encodeURIComponent(String(orderId))}/shipments`,
    { hosted: "true" },
    { "X-New-Domain": "true" }
  );

  const shipments = data == null ? [] : Array.isArray(data) ? data : [data];
  return shipments.filter((shipment: any) => shipment && (shipment.type === "forward" || !shipment.type));
}

function shipmentWasDispatched(shipment: any) {
  if (!shipment) return false;
  if (shipment.status_history?.date_shipped) return true;
  return ["shipped", "delivered", "not_delivered"].includes(String(shipment.status || ""));
}

function logisticLabel(type: unknown) {
  switch (String(type || "")) {
    case "fulfillment":
      return "Full";
    case "xd_drop_off":
      return "Coletas/Places/Agencia Mercado Livre";
    case "drop_off":
      return "Mercado Envios drop-off";
    case "cross_docking":
      return "Cross docking";
    case "self_service":
      return "Flex/Self service";
    default:
      return type || null;
  }
}

async function getShipmentSummary(env: Env, shipmentRef: any) {
  const shipmentId = shipmentRef?.id;
  if (!shipmentId) return null;

  const shipment = await meliGet(
    env,
    `/shipments/${encodeURIComponent(String(shipmentId))}`,
    {},
    { "x-format-new": "true" }
  );

  const logisticType = shipment?.logistic?.type ?? shipment?.logistic_type ?? null;
  const isFulfillment = logisticType === "fulfillment";
  const isCancelled = shipment?.status === "cancelled";
  const dispatched = shipmentWasDispatched(shipment);

  let sla: any = null;
  let slaError: string | null = null;

  if (!isFulfillment && !isCancelled) {
    try {
      sla = await meliGet(env, `/shipments/${encodeURIComponent(String(shipmentId))}/sla`);
    } catch (error) {
      slaError = error instanceof Error ? error.message : String(error);
    }
  }

  let shippingCosts: any = null;
  let shippingCostsError: string | null = null;
  if (!isCancelled) {
    try {
      const costs = await meliGet(
        env,
        `/shipments/${encodeURIComponent(String(shipmentId))}/costs`,
        {},
        { "x-format-new": "true" }
      );

      const senders = Array.isArray(costs?.senders) ? costs.senders : [];
      const sellerCost = senders.reduce((sum: number, sender: any) => {
        const value = Number(sender?.cost);
        return sum + (Number.isFinite(value) ? value : 0);
      }, 0);

      shippingCosts = {
        gross_amount: costs?.gross_amount ?? null,
        receiver_cost: costs?.receiver?.cost ?? null,
        seller_cost: Number(sellerCost.toFixed(2)),
        senders: senders.map((sender: any) => ({
          user_id: sender?.user_id ?? null,
          cost: sender?.cost ?? null,
          compensation: sender?.compensation ?? null
        }))
      };
    } catch (error) {
      shippingCostsError = error instanceof Error ? error.message : String(error);
    }
  }

  return {
    id: shipmentId,
    type: shipmentRef?.type ?? shipment?.logistic?.direction ?? null,
    status: shipment?.status ?? null,
    substatus: shipment?.substatus ?? null,
    logistic_mode: shipment?.logistic?.mode ?? shipment?.mode ?? null,
    logistic_type: logisticType,
    logistic_label: logisticLabel(logisticType),
    tags: Array.isArray(shipment?.tags) ? shipment.tags : [],
    date_created: shipment?.date_created ?? null,
    date_created_sao_paulo: formatSaoPaulo(shipment?.date_created),
    last_updated: shipment?.last_updated ?? null,
    date_handling: shipment?.status_history?.date_handling ?? null,
    date_shipped: shipment?.status_history?.date_shipped ?? null,
    pendente_despacho: !isFulfillment && !isCancelled && !dispatched,
    sla: sla
      ? {
          status: sla.status ?? null,
          service: sla.service ?? null,
          expected_date: sla.expected_date ?? null,
          expected_date_sao_paulo: formatSaoPaulo(sla.expected_date),
          last_updated: sla.last_updated ?? null
        }
      : null,
    sla_error: slaError,
    shipping_costs: shippingCosts,
    shipping_costs_error: shippingCostsError
  };
}

async function enrichOrderWithShipments(env: Env, order: any) {
  try {
    const refs = await getOrderShipments(env, order.id);
    const shipments = await Promise.all(refs.map((ref: any) => getShipmentSummary(env, ref)));
    return {
      ...compactOrder(order),
      shipments: shipments.filter(Boolean)
    };
  } catch (error) {
    return {
      ...compactOrder(order),
      shipments: [],
      shipment_error: error instanceof Error ? error.message : String(error)
    };
  }
}


function percentDiscount(originalPrice: unknown, currentPrice: unknown) {
  const original = Number(originalPrice);
  const current = Number(currentPrice);
  if (
    !Number.isFinite(original) ||
    !Number.isFinite(current) ||
    original <= 0 ||
    current <= 0 ||
    current > original
  ) {
    return null;
  }

  return Number((((original - current) / original) * 100).toFixed(2));
}

function compactPromotionItem(entry: any) {
  return {
    id: entry?.id ?? null,
    promotion_id: entry?.promotion_id ?? entry?.id ?? null,
    ref_id: entry?.ref_id ?? entry?.offer_id ?? null,
    type: entry?.type ?? null,
    sub_type: entry?.sub_type ?? null,
    status: entry?.status ?? null,
    name: entry?.name ?? null,
    price: entry?.price ?? null,
    original_price: entry?.original_price ?? null,
    desconto_total_percentual: percentDiscount(entry?.original_price, entry?.price),
    min_discounted_price: entry?.min_discounted_price ?? null,
    max_discounted_price: entry?.max_discounted_price ?? null,
    suggested_discounted_price: entry?.suggested_discounted_price ?? null,
    seller_percentage: entry?.seller_percentage ?? null,
    meli_percentage: entry?.meli_percentage ?? null,
    start_date: entry?.start_date ?? null,
    end_date: entry?.end_date ?? entry?.finish_date ?? null,
    boosted_offer: entry?.boosted_offer ?? false,
    discount_meli_boosted_percentage: entry?.discount_meli_boosted_percentage ?? null,
    discount_meli_boost_amount: entry?.discount_meli_boost_amount ?? null,
    total_price_for_boosted_offer: entry?.total_price_for_boosted_offer ?? null
  };
}


const PRODUCT_ADS_METRICS = [
  "clicks",
  "prints",
  "cost",
  "cpc",
  "ctr",
  "direct_amount",
  "indirect_amount",
  "total_amount",
  "direct_units_quantity",
  "indirect_units_quantity",
  "units_quantity",
  "direct_items_quantity",
  "indirect_items_quantity",
  "advertising_items_quantity",
  "organic_units_quantity",
  "organic_units_amount",
  "organic_items_quantity",
  "acos",
  "tacos",
  "sov",
  "cvr",
  "roas"
];

function saoPauloDateOnly(value: unknown) {
  if (typeof value !== "string" || !value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;

  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: SAO_PAULO_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);

  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  return year && month && day ? `${year}-${month}-${day}` : null;
}

function shiftIsoDate(date: string, days: number) {
  const parsed = new Date(`${date}T12:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

async function resolveSaleReference(env: Env, reference: string | number) {
  const id = String(reference);

  try {
    const order = await meliGet(env, `/orders/${encodeURIComponent(id)}`);
    if (order?.id) {
      return {
        reference_type: "order",
        pack: order.pack_id ? { id: order.pack_id } : null,
        orders: [order]
      };
    }
  } catch {}

  const pack = await meliGet(env, `/packs/${encodeURIComponent(id)}`);
  const refs = Array.isArray(pack?.orders) ? pack.orders : [];
  const orders = (
    await Promise.all(
      refs.map(async (entry: any) => {
        try {
          return await meliGet(env, `/orders/${encodeURIComponent(String(entry?.id))}`);
        } catch {
          return null;
        }
      })
    )
  ).filter(Boolean);

  if (orders.length === 0) {
    throw new Error("A referencia informada nao retornou nenhuma order acessivel da Stop Kar.");
  }

  return {
    reference_type: "pack",
    pack: {
      id: pack?.id ?? reference,
      status: pack?.status ?? null,
      shipment_id: pack?.shipment?.id ?? null
    },
    orders
  };
}

async function getPadsAdvertiser(env: Env, siteId: string) {
  const data = await meliGet(
    env,
    "/advertising/advertisers",
    { product_id: "PADS" },
    { "Api-Version": "1" }
  );

  const advertisers = Array.isArray(data?.advertisers) ? data.advertisers : [];
  return (
    advertisers.find((entry: any) => String(entry?.site_id || "") === siteId) ??
    advertisers[0] ??
    null
  );
}

function sumAdsMetrics(rows: any[]) {
  const totals: Record<string, number> = {};
  for (const field of PRODUCT_ADS_METRICS) totals[field] = 0;

  for (const row of rows) {
    const metrics = row?.metrics ?? row?.metrics_summary ?? row ?? {};
    for (const field of PRODUCT_ADS_METRICS) {
      const value = Number(metrics?.[field]);
      if (Number.isFinite(value)) totals[field] += value;
    }
  }

  for (const field of PRODUCT_ADS_METRICS) {
    totals[field] = Number(totals[field].toFixed(4));
  }

  return totals;
}

async function getAdsRowsForItemPeriod(
  env: Env,
  siteId: string,
  advertiserId: string | number,
  itemId: string,
  dateFrom: string,
  dateTo: string
) {
  const search = await meliGet(
    env,
    `/advertising/${encodeURIComponent(siteId)}/advertisers/${encodeURIComponent(
      String(advertiserId)
    )}/product_ads/ad_groups/search`,
    { "filters[item_ids]": itemId },
    { "api-version": "2" }
  );

  const adGroups = Array.isArray(search?.results) ? search.results : [];
  const rows: any[] = [];
  const errors: string[] = [];

  for (const group of adGroups) {
    try {
      const data = await meliGet(
        env,
        `/advertising/${encodeURIComponent(siteId)}/product_ads/ad_groups/${encodeURIComponent(
          String(group?.id)
        )}/ads`,
        {
          date_from: dateFrom,
          date_to: dateTo,
          metrics: PRODUCT_ADS_METRICS.join(",")
        },
        { "api-version": "2" }
      );

      const results = Array.isArray(data?.results) ? data.results : [];
      for (const row of results) {
        if (String(row?.item_id || "") === itemId) {
          rows.push({
            ...row,
            ad_group_id: row?.ad_group_id ?? group?.id ?? null,
            campaign_id: row?.campaign_id ?? group?.campaign_id ?? null
          });
        }
      }
    } catch (error) {
      errors.push(
        `ad_group ${String(group?.id ?? "")}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  return {
    ad_groups: adGroups.map((group: any) => ({
      id: group?.id ?? null,
      campaign_id: group?.campaign_id ?? null,
      status: group?.status ?? null,
      ad_group_type: group?.ad_group_type ?? null,
      ad_group_external_id: group?.ad_group_external_id ?? null
    })),
    rows,
    metrics: sumAdsMetrics(rows),
    errors
  };
}

async function countItemOrdersOnDate(env: Env, sellerId: string | number, itemId: string, date: string) {
  const results: any[] = [];
  let offset = 0;
  const limit = 50;
  let total = 0;

  for (let page = 0; page < 10; page += 1) {
    const data = await meliGet(env, "/orders/search", {
      seller: String(sellerId),
      "order.date_closed.from": `${date}T00:00:00-03:00`,
      "order.date_closed.to": `${date}T23:59:59-03:00`,
      "order.status": "paid",
      sort: "date_desc",
      limit: String(limit),
      offset: String(offset)
    });

    const pageResults = Array.isArray(data?.results) ? data.results : [];
    results.push(...pageResults);
    total = Number(data?.paging?.total ?? results.length);
    offset += limit;
    if (results.length >= total || pageResults.length === 0) break;
  }

  let ordersWithItem = 0;
  let units = 0;
  let amount = 0;

  for (const order of results) {
    const matching = Array.isArray(order?.order_items)
      ? order.order_items.filter((entry: any) => String(entry?.item?.id || "") === itemId)
      : [];
    if (matching.length > 0) ordersWithItem += 1;
    for (const entry of matching) {
      const quantity = Number(entry?.quantity ?? 0);
      const unitPrice = Number(entry?.unit_price ?? 0);
      units += Number.isFinite(quantity) ? quantity : 0;
      amount += Number.isFinite(quantity * unitPrice) ? quantity * unitPrice : 0;
    }
  }

  return {
    orders_with_item: ordersWithItem,
    units: Number(units.toFixed(4)),
    amount: Number(amount.toFixed(2)),
    orders_scanned: results.length,
    total_orders_day: total,
    scan_truncated: results.length < total
  };
}


const ADS_CAMPAIGN_METRICS = [
  "clicks",
  "prints",
  "ctr",
  "cost",
  "cpc",
  "acos",
  "organic_units_quantity",
  "organic_units_amount",
  "organic_items_quantity",
  "direct_items_quantity",
  "indirect_items_quantity",
  "advertising_items_quantity",
  "cvr",
  "roas",
  "sov",
  "direct_units_quantity",
  "indirect_units_quantity",
  "units_quantity",
  "direct_amount",
  "indirect_amount",
  "total_amount"
].join(",");

const ADS_AD_GROUP_METRICS = [
  "CLICKS",
  "PRINTS",
  "COST",
  "CPC",
  "CTR",
  "DIRECT_AMOUNT",
  "INDIRECT_AMOUNT",
  "TOTAL_AMOUNT",
  "DIRECT_UNITS_QUANTITY",
  "INDIRECT_UNITS_QUANTITY",
  "UNITS_QUANTITY",
  "DIRECT_ITEMS_QUANTITY",
  "INDIRECT_ITEMS_QUANTITY",
  "ADVERTISING_ITEMS_QUANTITY",
  "ORGANIC_UNITS_QUANTITY",
  "ORGANIC_UNITS_AMOUNT",
  "ORGANIC_ITEMS_QUANTITY",
  "ACOS",
  "TACOS",
  "SOV",
  "CVR",
  "ROAS"
].join(",");

async function getProductAdsAdvertiser(env: Env) {
  let data: any;
  try {
    data = await meliGet(
      env,
      "/advertising/advertisers",
      { product_id: "PADS" },
      { "Api-Version": "1" }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Nao foi possivel acessar Mercado Ads Product Ads. Confirme que o aplicativo do Mercado Livre tem a permissao funcional Publicidade e, se a permissao tiver sido adicionada agora, autorize novamente a conta em /oauth/start. Detalhe: ${message}`
    );
  }

  const advertisers = Array.isArray(data?.advertisers) ? data.advertisers : [];
  if (advertisers.length === 0) {
    throw new Error(
      "A conta autorizada nao retornou advertiser de Product Ads (PADS). Confirme que a conta possui Mercado Ads ativo e que o aplicativo tem permissao Publicidade."
    );
  }

  const me = await meliGet(env, "/users/me");
  const sellerSiteId = String(me?.site_id || "MLB");
  const advertiser =
    advertisers.find((entry: any) => String(entry?.site_id || "") === sellerSiteId) ||
    advertisers[0];

  return {
    advertiser_id: advertiser?.advertiser_id,
    site_id: String(advertiser?.site_id || sellerSiteId),
    advertiser_name: advertiser?.advertiser_name ?? null,
    raw: advertiser
  };
}


function adsWritesEnabled(env: Env) {
  return String(env.ADS_WRITES_ENABLED || "").toLowerCase() === "true";
}

function requireAdsWritesEnabled(env: Env) {
  if (!adsWritesEnabled(env)) {
    throw new Error(
      "A escrita de Product Ads esta bloqueada pelo servidor. Defina ADS_WRITES_ENABLED=true somente depois de validar a integracao de teste."
    );
  }
}

function campaignAgeHours(campaign: any) {
  if (!campaign?.date_created) return null;
  const created = new Date(campaign.date_created).getTime();
  if (!Number.isFinite(created)) return null;
  return Math.max(0, (Date.now() - created) / 3_600_000);
}

async function getProductAdsCampaign(env: Env, advertiser: any, campaignId: string | number) {
  const data = await meliGet(
    env,
    `/advertising/${encodeURIComponent(advertiser.site_id)}/advertisers/${encodeURIComponent(
      String(advertiser.advertiser_id)
    )}/product_ads/campaigns/search`,
    {
      "filters[campaign_ids]": String(campaignId),
      limit: "20"
    },
    { "api-version": "2" }
  );

  const rows = Array.isArray(data?.results) ? data.results : [];
  return rows.find((row: any) => String(row?.id) === String(campaignId)) ?? null;
}

async function getProductAdsAdGroupsForItem(env: Env, advertiser: any, itemId: string) {
  const data = await meliGet(
    env,
    `/advertising/${encodeURIComponent(advertiser.site_id)}/advertisers/${encodeURIComponent(
      String(advertiser.advertiser_id)
    )}/product_ads/ad_groups/search`,
    {
      "filters[item_ids]": itemId,
      limit: "50"
    },
    { "api-version": "2" }
  );

  return Array.isArray(data?.results) ? data.results : [];
}

async function recordAdsAudit(env: Env, entry: Record<string, unknown>) {
  if (!env.MELI_TOKENS) return null;
  const timestamp = new Date().toISOString();
  const id = crypto.randomUUID();
  const key = `ads:audit:${timestamp}:${id}`;
  await env.MELI_TOKENS.put(
    key,
    JSON.stringify({
      id,
      timestamp,
      ...entry
    }),
    { expirationTtl: 60 * 60 * 24 * 180 }
  );
  return id;
}

const MLB_ID = /^MLB\d+$/;
const MLBU_ID = /^MLBU\d+$/;

async function resolveTitleItems(env: Env, itemId: string, sellerId: string): Promise<string[]> {
  if (MLB_ID.test(itemId)) return [itemId];

  // The official seller search returns the items for one User Product.
  const results: string[] = [];
  const limit = 100;
  for (let offset = 0; offset < 1000; offset += limit) {
    const page = await meliGet(
      env,
      `/users/${encodeURIComponent(sellerId)}/items/search`,
      { user_product_id: itemId, limit: String(limit), offset: String(offset) }
    );
    if (String(page?.seller_id) !== sellerId || !Array.isArray(page?.results)) {
      throw new Error("A busca do User Product nao confirmou a conta vendedora.");
    }
    const ids = page.results.map(String);
    if (ids.some((id: string) => !MLB_ID.test(id))) {
      throw new Error("A busca do User Product retornou um codigo de anuncio invalido.");
    }
    results.push(...ids);
    const total = Number(page?.paging?.total);
    if (!Number.isSafeInteger(total) || total < 0) {
      throw new Error("A busca do User Product nao informou a quantidade total de anuncios.");
    }
    if (offset + ids.length >= total) return [...new Set(results)];
    if (ids.length === 0) throw new Error("A busca do User Product parou antes de listar todos os anuncios.");
  }
  throw new Error("User Product com mais de 1000 anuncios; resolucao incompleta e bloqueada.");
}

async function putItemTitle(env: Env, mlbId: string, title: string): Promise<any> {
  const url = `${MELI_API}/items/${encodeURIComponent(mlbId)}`;
  const send = (token: string) => fetch(url, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ title })
  });
  let response = await send(await getAccessToken(env));
  if (response.status === 401) response = await send((await refreshToken(env)).access_token);
  const data = await parseApiResponse(response);
  if (!response.ok) {
    const message = data && typeof data === "object"
      ? data.message || data.error || JSON.stringify(data)
      : String(data);
    throw new Error(`Mercado Livre API ${response.status}: ${message}`);
  }
  return data;
}

async function recordTitleAudit(env: Env, id: string, phase: "before" | "after", entry: Record<string, unknown>) {
  if (!env.MELI_TOKENS) throw new Error("KV MELI_TOKENS necessaria para auditoria de titulos.");
  await env.MELI_TOKENS.put(`items:title:audit:${id}:${phase}`, JSON.stringify(entry));
}

function createServer(env: Env) {
  const server = new McpServer({
    name: "Stop Kar Mercado Livre",
    version: SERVER_VERSION
  });

  server.registerTool(
    "consultar_conta",
    {
      description:
        "Consulta a conta Mercado Livre autorizada da Stop Kar. Retorna somente dados operacionais basicos, sem endereco ou documentos.",
      inputSchema: {}
    },
    async () => {
      const me = await meliGet(env, "/users/me");
      return textResult({
        integration_version: SERVER_VERSION,
        id: me.id,
        nickname: me.nickname,
        country_id: me.country_id,
        site_id: me.site_id,
        user_type: me.user_type,
        points: me.points,
        seller_reputation: me.seller_reputation
      });
    }
  );

  server.registerTool(
    "buscar_anuncio",
    {
      description:
        "Busca anuncio da Stop Kar por MLB ou User Product MLBU e retorna preco, estoque, vendas, SKU, status, logistica e variacoes.",
      inputSchema: {
        item_id: z.string().min(3).describe("Codigo MLB ou MLBU, por exemplo MLB1234567890 ou MLBU1234567890")
      }
    },
    async ({ item_id }) => {
      const resolved = await resolveListingReference(env, item_id);
      if (resolved.reference_type === "item") {
        return textResult(compactItem(resolved.items[0]));
      }

      return textResult({
        reference_type: resolved.reference_type,
        user_product_id: resolved.user_product_id,
        total_items: resolved.items.length,
        erros_detalhes: resolved.errors.slice(0, 5),
        items: resolved.items.map((item: any) => compactItem(item))
      });
    }
  );

  server.registerTool(
    "atualizar_titulo_anuncio",
    {
      description:
        "Pre-visualiza ou altera com seguranca o titulo de um anuncio da Stop Kar. Aceita MLB ou MLBU. Por padrao apenas simula; para gravar, confirmar=true, motivo e LISTING_WRITES_ENABLED=true sao obrigatorios.",
      inputSchema: {
        item_id: z.string().min(3).describe("Codigo MLB ou MLBU do anuncio."),
        titulo: z.string().min(1).max(60).describe("Novo titulo, com no maximo 60 caracteres."),
        aplicar_em_todos: z
          .boolean()
          .optional()
          .default(false)
          .describe("Se um MLBU estiver ligado a mais de um MLB, exige true para alterar todos os itens associados."),
        confirmar: z.boolean().optional().default(false),
        motivo: z.string().max(300).optional()
      }
    },
    async ({ item_id, titulo, aplicar_em_todos, confirmar, motivo }) => {
      const novoTitulo = titulo.trim();
      if (!novoTitulo) {
        throw new Error("Informe um titulo nao vazio.");
      }
      if (novoTitulo.length > 60) {
        throw new Error("O titulo deve ter no maximo 60 caracteres.");
      }

      const resolved = await resolveListingReference(env, item_id);
      const allItems = resolved.items;
      if (allItems.length === 0) {
        throw new Error("Nenhum item foi encontrado para a referencia informada.");
      }

      if (allItems.length > 1 && !aplicar_em_todos) {
        return textResult({
          acao: "bloqueado_por_ambiguidade",
          referencia: resolved.reference,
          user_product_id: resolved.user_product_id,
          mensagem:
            "Este MLBU esta ligado a mais de um MLB. Nenhuma alteracao foi feita. Revise os itens e reenvie com aplicar_em_todos=true somente se quiser alterar todos.",
          items: allItems.map((item: any) => ({
            id: item?.id ?? null,
            title: item?.title ?? null,
            status: item?.status ?? null,
            sold_quantity: item?.sold_quantity ?? null,
            listing_type_id: item?.listing_type_id ?? null,
            catalog_listing: item?.catalog_listing ?? false
          }))
        });
      }

      const selectedItems = allItems.length > 1 ? allItems : [allItems[0]];
      const blockedBySales = selectedItems.filter(
        (item: any) => Number(item?.sold_quantity ?? 0) > 0
      );

      const preview = {
        acao: confirmar ? "gravar" : "simulacao",
        referencia: resolved.reference,
        reference_type: resolved.reference_type,
        user_product_id: resolved.user_product_id,
        novo_titulo: novoTitulo,
        quantidade_itens: selectedItems.length,
        escrita_anuncios_habilitada: listingWritesEnabled(env),
        items: selectedItems.map((item: any) => ({
          id: item?.id ?? null,
          title_atual: item?.title ?? null,
          status: item?.status ?? null,
          sold_quantity: item?.sold_quantity ?? null,
          listing_type_id: item?.listing_type_id ?? null,
          catalog_listing: item?.catalog_listing ?? false,
          pode_tentar_alterar_titulo: Number(item?.sold_quantity ?? 0) === 0
        })),
        erros_detalhes: resolved.errors.slice(0, 5)
      };

      if (blockedBySales.length > 0) {
        return textResult({
          ...preview,
          acao: "bloqueado_por_vendas",
          mensagem:
            "O Mercado Livre nao permite alterar o titulo de uma publicacao que ja possui vendas, salvo regras especificas de Loja Oficial. Nenhuma alteracao foi feita.",
          itens_bloqueados: blockedBySales.map((item: any) => ({
            id: item?.id ?? null,
            sold_quantity: item?.sold_quantity ?? null
          }))
        });
      }

      const changedItems = selectedItems.filter(
        (item: any) => String(item?.title || "") !== novoTitulo
      );
      if (changedItems.length === 0) {
        return textResult({
          ...preview,
          acao: "nenhuma_alteracao",
          mensagem: "O novo titulo e igual ao titulo atual."
        });
      }

      if (!confirmar) {
        return textResult(preview);
      }

      if (!motivo || motivo.trim().length < 5) {
        throw new Error(
          "Para gravar uma alteracao de titulo, informe um motivo objetivo com pelo menos 5 caracteres."
        );
      }

      requireListingWritesEnabled(env);

      const token = await loadToken(env);
      const scopes = String(token?.scope || "")
        .split(/\s+/)
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean);
      if (!scopes.includes("write")) {
        throw new Error(
          "O token OAuth atual nao possui scope write. Reautorize a conta apos habilitar escrita da publicacao."
        );
      }

      const resultados: any[] = [];
      for (const item of changedItems) {
        const before = compactItem(item);
        const write = await meliWrite(
          env,
          "PUT",
          `/items/${encodeURIComponent(String(item.id))}`,
          { title: novoTitulo }
        );
        const afterItem = await meliGet(
          env,
          `/items/${encodeURIComponent(String(item.id))}`,
          { include_attributes: "all" }
        );
        const after = compactItem(afterItem);
        const audit_id = await recordListingAudit(env, {
          tipo: "listing_title_update",
          referencia: resolved.reference,
          user_product_id: resolved.user_product_id,
          item_id: item.id,
          motivo: motivo.trim(),
          antes: before,
          solicitado: { title: novoTitulo },
          depois: after,
          endpoint: write.path_used
        });
        resultados.push({
          item_id: item.id,
          audit_id,
          endpoint_utilizado: write.path_used,
          resposta_api: write.data,
          antes: before,
          depois: after
        });
      }

      return textResult({
        ...preview,
        acao: "gravado",
        resultados
      });
    }
  );

  server.registerTool(
    "editar_titulo_anuncio",
    {
      description:
        "Mostra preview do titulo de anuncio da Stop Kar por MLB ou MLBU. Somente grava o titulo do item com confirmar=true e motivo; nao altera Product Ads.",
      inputSchema: {
        item_id: z.string().regex(/^(MLB|MLBU)\d+$/).describe("Codigo MLB ou MLBU."),
        novo_titulo: z.string().optional().describe("Titulo proposto, com no maximo 60 caracteres."),
        confirmar: z.boolean().optional().default(false).describe("True para gravar depois de conferir o preview."),
        motivo: z.string().optional().describe("Justificativa obrigatoria para gravacao."),
        mlb_id: z.string().regex(/^MLB\d+$/).optional()
          .describe("MLB escolhido quando o MLBU corresponde a varios anuncios."),
        confirmar_ambiguidade: z.boolean().optional().default(false)
          .describe("Confirmacao explicita da escolha de mlb_id quando ha varios MLB."),
        permitir_com_vendas: z.boolean().optional().default(false)
          .describe("Permite tentar alterar titulo mesmo se o anuncio ja tiver vendas; a API do Mercado Livre ainda pode recusar.")
      }
    },
    async ({ item_id, novo_titulo, confirmar, motivo, mlb_id, confirmar_ambiguidade, permitir_com_vendas }) => {
      const title = novo_titulo?.trim();
      if (novo_titulo !== undefined && (!title || [...title].length > 60)) {
        throw new Error("O novo titulo deve ter de 1 a 60 caracteres.");
      }
      if (confirmar && (!title || !motivo?.trim())) {
        throw new Error("Para gravar, informe novo_titulo e motivo e use confirmar=true.");
      }

      const me = await meliGet(env, "/users/me");
      const sellerId = String(me?.id ?? "");
      if (!sellerId) throw new Error("Nao foi possivel identificar a conta vendedora autorizada.");
      const ids = await resolveTitleItems(env, item_id, sellerId);
      if (ids.length === 0) {
        return textResult({ item_id, mlbu: MLBU_ID.test(item_id) ? item_id : null,
          anuncios: [], alteracao_permitida: false, motivo_bloqueio: "Nenhum MLB associado a este MLBU na conta Stop Kar." });
      }
      if (mlb_id && !ids.includes(mlb_id)) {
        throw new Error("mlb_id nao pertence aos anuncios resolvidos para item_id.");
      }

      const items = await Promise.all(ids.map((id) => meliGet(env, `/items/${encodeURIComponent(id)}`)));
      const anuncios = items.map((item: any, index: number) => {
        const owner = String(item?.seller_id) === sellerId;
        const associated = !MLBU_ID.test(item_id) || item?.user_product_id === item_id;
        const noSales = Number(item?.sold_quantity) === 0;
        const statusAllowed = ["active", "paused"].includes(String(item?.status));
        const salesOverride = confirmar === true || permitir_com_vendas === true;
        const allowed =
          owner &&
          associated &&
          (noSales || salesOverride) &&
          statusAllowed &&
          typeof item?.title === "string";
        return {
          mlbu: MLBU_ID.test(item_id) ? item_id : item?.user_product_id ?? null,
          mlb: ids[index],
          titulo_atual: item?.title ?? null,
          sold_quantity: item?.sold_quantity ?? null,
          status: item?.status ?? null,
          alteracao_permitida: allowed,
          tentativa_com_vendas: !noSales && salesOverride,
          motivo_bloqueio: allowed ? null : !owner ? "Anuncio nao pertence a conta autorizada."
            : !associated ? "MLB nao confirma associacao ao MLBU."
            : !noSales ? "Anuncio ja possui vendas; use permitir_com_vendas=true somente se quiser tentar e deixar a API do Mercado Livre decidir."
            : !statusAllowed ? "Status do anuncio nao permite esta alteracao." : "Titulo atual indisponivel."
        };
      });
      const ambiguous = anuncios.length > 1;
      const selected = anuncios.find((entry) => entry.mlb === (mlb_id ?? (ambiguous ? "" : ids[0])));
      const preview = {
        item_id,
        mlbu: MLBU_ID.test(item_id) ? item_id : selected?.mlbu ?? null,
        mlb_resolvido: selected?.mlb ?? (ambiguous ? null : ids[0]),
        titulo_atual: selected?.titulo_atual ?? null,
        sold_quantity: selected?.sold_quantity ?? null,
        status: selected?.status ?? null,
        novo_titulo: title ?? null,
        anuncios,
        ambiguo: ambiguous,
        alteracao_permitida: Boolean(selected?.alteracao_permitida && (!ambiguous || confirmar_ambiguidade)),
        permitir_com_vendas: permitir_com_vendas === true,
        aviso_vendas:
          Number(selected?.sold_quantity ?? 0) > 0 && permitir_com_vendas === true
            ? "O anuncio ja possui vendas. A integracao tentara a alteracao, mas o Mercado Livre pode recusar conforme as regras da publicacao."
            : null,
        gravado: false
      };
      if (!confirmar) return textResult(preview);
      if (ambiguous && (!mlb_id || !confirmar_ambiguidade)) {
        throw new Error("MLBU possui varios MLB. Escolha mlb_id e informe confirmar_ambiguidade=true.");
      }
      if (!selected?.alteracao_permitida) {
        throw new Error(selected?.motivo_bloqueio ?? "Alteracao de titulo nao permitida.");
      }
      if (selected.titulo_atual === title) throw new Error("O novo titulo e igual ao titulo atual.");

      const auditId = crypto.randomUUID();
      const timestamp = new Date().toISOString();
      const audit = {
        id: auditId, timestamp, item_id, mlbu: selected.mlbu, mlb: selected.mlb,
        seller_id: sellerId, motivo: motivo!.trim(), antes: selected.titulo_atual,
        depois_solicitado: title, estado: "iniciado"
      };
      await recordTitleAudit(env, auditId, "before", audit);
      let after: string | null = null;
      try {
        const response = await putItemTitle(env, selected.mlb, title!);
        after = typeof response?.title === "string" ? response.title : title!;
        const updated = await meliGet(env, `/items/${encodeURIComponent(selected.mlb)}`);
        after = updated?.title ?? after;
        await recordTitleAudit(env, auditId, "after", {
          ...audit, estado: "concluido", depois: after,
          confirmado_na_api: updated?.title === title, concluido_em: new Date().toISOString()
        });
        return textResult({ ...preview, gravado: true, titulo_depois: after,
          confirmado_na_api: updated?.title === title, auditoria_id: auditId });
      } catch (error) {
        await recordTitleAudit(env, auditId, "after", {
          ...audit, estado: "erro_ou_resultado_incerto",
          depois: after, erro: error instanceof Error ? error.message : String(error),
          concluido_em: new Date().toISOString()
        });
        throw error;
      }
    }
  );


  server.registerTool(
    "editar_family_name_anuncio",
    {
      description:
        "Pre-visualiza ou altera o family_name de um User Product da Stop Kar. E o caminho correto para otimizar o nome/titulo no modelo MLBU. So grava com confirmar=true.",
      inputSchema: {
        item_id: z.string().regex(/^(MLB|MLBU)\d+$/).describe("Codigo MLB ou MLBU."),
        novo_family_name: z.string().min(1).max(60).describe("Novo family_name, ate 60 caracteres."),
        confirmar: z.boolean().optional().default(false),
        motivo: z.string().max(300).optional()
      }
    },
    async ({ item_id, novo_family_name, confirmar, motivo }) => {
      const name = novo_family_name.trim();
      const resolved = await resolveListingReference(env, item_id);
      if (!resolved.user_product_id) {
        return textResult({
          acao: "bloqueado",
          item_id,
          mensagem:
            "Este anuncio nao esta no modelo User Product. Para ele, use a ferramenta de titulo tradicional."
        });
      }

      const items = resolved.items;
      const sold = items.filter((item: any) => Number(item?.sold_quantity ?? 0) > 0);
      const currentNames = [...new Set(items.map((item: any) => String(item?.family_name ?? "")).filter(Boolean))];

      const preview = {
        acao: confirmar ? "gravar" : "simulacao",
        item_id,
        user_product_id: resolved.user_product_id,
        novo_family_name: name,
        family_names_atuais: currentNames,
        condicoes_venda: items.map((item: any) => ({
          mlb: item?.id ?? null,
          sold_quantity: item?.sold_quantity ?? null,
          status: item?.status ?? null,
          family_name: item?.family_name ?? null
        })),
        alteracao_permitida: sold.length === 0,
        escrita_anuncios_habilitada: listingWritesEnabled(env)
      };

      if (sold.length > 0) {
        return textResult({
          ...preview,
          acao: "bloqueado_por_vendas",
          mensagem:
            "O Mercado Livre so permite atualizar family_name quando nenhuma condicao de venda do User Product possui vendas.",
          itens_com_vendas: sold.map((item: any) => ({
            mlb: item?.id ?? null,
            sold_quantity: item?.sold_quantity ?? null
          }))
        });
      }

      if (currentNames.length === 1 && currentNames[0] === name) {
        return textResult({ ...preview, acao: "nenhuma_alteracao" });
      }
      if (!confirmar) return textResult(preview);
      if (!motivo || motivo.trim().length < 5) {
        throw new Error("Para gravar o family_name, informe um motivo com pelo menos 5 caracteres.");
      }

      requireListingWritesEnabled(env);
      const first = items[0];
      const before = items.map((item: any) => compactItem(item));
      const write = await meliWrite(
        env,
        "PUT",
        `/items/${encodeURIComponent(String(first.id))}`,
        { family_name: name }
      );
      const afterResolved = await resolveListingReference(env, resolved.user_product_id);
      const after = afterResolved.items.map((item: any) => compactItem(item));
      const audit_id = await recordOperationAudit(env, "listing:family:audit", {
        tipo: "family_name_update",
        referencia: item_id,
        user_product_id: resolved.user_product_id,
        motivo: motivo.trim(),
        solicitado: { family_name: name },
        antes: before,
        depois: after,
        endpoint: write.path_used
      });

      return textResult({
        ...preview,
        acao: "gravado",
        audit_id,
        endpoint_utilizado: write.path_used,
        depois: after.map((item: any) => ({
          mlb: item.id,
          family_name: item.family_name ?? null,
          title: item.title ?? null
        }))
      });
    }
  );

  server.registerTool(
    "atualizar_preco_anuncio",
    {
      description:
        "Pre-visualiza ou altera o preco base de um anuncio da Stop Kar. Aceita MLB ou MLBU; quando um MLBU possui varios MLB, exige mlb_id. Nao mexe em promocoes.",
      inputSchema: {
        item_id: z.string().regex(/^(MLB|MLBU)\d+$/),
        novo_preco: z.number().positive(),
        mlb_id: z.string().regex(/^MLB\d+$/).optional(),
        confirmar: z.boolean().optional().default(false),
        motivo: z.string().max(300).optional()
      }
    },
    async ({ item_id, novo_preco, mlb_id, confirmar, motivo }) => {
      const chosen = await chooseListingForWrite(env, item_id, mlb_id);
      if (!chosen.selected) {
        return textResult({
          acao: "bloqueado_por_ambiguidade",
          item_id,
          mensagem: "Este MLBU possui varios MLB. Escolha o mlb_id da condicao de venda que tera o preco alterado.",
          items: chosen.resolved.items.map((item: any) => ({
            mlb: item?.id ?? null,
            title: item?.title ?? null,
            price: item?.price ?? null,
            listing_type_id: item?.listing_type_id ?? null,
            status: item?.status ?? null
          }))
        });
      }

      const item = chosen.selected;
      const promos = await getItemPromotions(env, String(item.id));
      const preview = {
        acao: confirmar ? "gravar" : "simulacao",
        item_id,
        mlb: item.id,
        titulo: item.title ?? null,
        preco_atual: item.price ?? null,
        novo_preco: Number(novo_preco),
        promocoes_atuais: promos.map((entry: any) => compactPromotionItem(entry)),
        aviso:
          promos.length > 0
            ? "O anuncio possui promocao/oferta. Revise o efeito da mudanca no preco base antes de confirmar."
            : null,
        escrita_anuncios_habilitada: listingWritesEnabled(env)
      };

      if (Number(item.price) === Number(novo_preco)) {
        return textResult({ ...preview, acao: "nenhuma_alteracao" });
      }
      if (!confirmar) return textResult(preview);
      if (!motivo || motivo.trim().length < 5) {
        throw new Error("Para alterar o preco, informe um motivo com pelo menos 5 caracteres.");
      }

      requireListingWritesEnabled(env);
      const before = compactItem(item);
      const write = await meliWrite(
        env,
        "PUT",
        `/items/${encodeURIComponent(String(item.id))}`,
        { price: Number(novo_preco) }
      );
      const afterRaw = await meliGet(env, `/items/${encodeURIComponent(String(item.id))}`, {
        include_attributes: "all"
      });
      const after = compactItem(afterRaw);
      const confirmado = Number(after.price) === Number(novo_preco);
      const audit_id = await recordOperationAudit(env, "listing:price:audit", {
        tipo: "price_update",
        item_id: item.id,
        motivo: motivo.trim(),
        solicitado: { price: Number(novo_preco) },
        antes: before,
        depois: after,
        confirmado_na_api: confirmado,
        endpoint: write.path_used
      });

      return textResult({
        ...preview,
        acao: confirmado ? "gravado" : "nao_confirmado",
        audit_id,
        endpoint_utilizado: write.path_used,
        preco_depois: after.price ?? null,
        confirmado_na_api: confirmado,
        observacao:
          confirmado
            ? null
            : "O Mercado Livre respondeu a requisicao, mas o preco consultado depois nao corresponde ao valor solicitado. Verifique automacao de precos ou regras da oferta."
      });
    }
  );

  server.registerTool(
    "editar_descricao_anuncio",
    {
      description:
        "Pre-visualiza ou substitui a descricao plain_text de um anuncio da Stop Kar. Aceita MLB ou MLBU; MLBU com varios MLB exige mlb_id.",
      inputSchema: {
        item_id: z.string().regex(/^(MLB|MLBU)\d+$/),
        nova_descricao: z.string().min(1).max(50000),
        mlb_id: z.string().regex(/^MLB\d+$/).optional(),
        confirmar: z.boolean().optional().default(false),
        motivo: z.string().max(300).optional()
      }
    },
    async ({ item_id, nova_descricao, mlb_id, confirmar, motivo }) => {
      const chosen = await chooseListingForWrite(env, item_id, mlb_id);
      if (!chosen.selected) {
        return textResult({
          acao: "bloqueado_por_ambiguidade",
          item_id,
          mensagem: "Este MLBU possui varios MLB. Escolha o mlb_id cuja descricao sera substituida.",
          items: chosen.resolved.items.map((item: any) => ({
            mlb: item?.id ?? null,
            title: item?.title ?? null,
            status: item?.status ?? null
          }))
        });
      }
      const item = chosen.selected;
      let currentDescription: any = null;
      try {
        currentDescription = await meliGet(
          env,
          `/items/${encodeURIComponent(String(item.id))}/description`
        );
      } catch {}

      const preview = {
        acao: confirmar ? "gravar" : "simulacao",
        item_id,
        mlb: item.id,
        titulo: item.title ?? null,
        descricao_atual: currentDescription?.plain_text ?? null,
        nova_descricao,
        escrita_anuncios_habilitada: listingWritesEnabled(env)
      };
      if ((currentDescription?.plain_text ?? "") === nova_descricao) {
        return textResult({ ...preview, acao: "nenhuma_alteracao" });
      }
      if (!confirmar) return textResult(preview);
      if (!motivo || motivo.trim().length < 5) {
        throw new Error("Para alterar a descricao, informe um motivo com pelo menos 5 caracteres.");
      }

      requireListingWritesEnabled(env);
      const write = await meliWrite(
        env,
        "PUT",
        `/items/${encodeURIComponent(String(item.id))}/description?api_version=2`,
        { plain_text: nova_descricao }
      );
      const after = await meliGet(
        env,
        `/items/${encodeURIComponent(String(item.id))}/description`
      );
      const audit_id = await recordOperationAudit(env, "listing:description:audit", {
        tipo: "description_update",
        item_id: item.id,
        motivo: motivo.trim(),
        antes: currentDescription?.plain_text ?? null,
        solicitado: nova_descricao,
        depois: after?.plain_text ?? null,
        endpoint: write.path_used
      });

      return textResult({
        ...preview,
        acao: "gravado",
        audit_id,
        endpoint_utilizado: write.path_used,
        descricao_depois: after?.plain_text ?? null
      });
    }
  );

  server.registerTool(
    "gerenciar_promocao_damiao",
    {
      description:
        "Adiciona, atualiza ou remove um anuncio da campanha Damiao (SELLER_CAMPAIGN C-MLB5661788) com preview e confirmacao obrigatoria.",
      inputSchema: {
        item_id: z.string().regex(/^(MLB|MLBU)\d+$/),
        acao: z.enum(["adicionar_ou_atualizar", "remover"]),
        deal_price: z.number().positive().optional(),
        mlb_id: z.string().regex(/^MLB\d+$/).optional(),
        confirmar: z.boolean().optional().default(false),
        motivo: z.string().max(300).optional()
      }
    },
    async ({ item_id, acao, deal_price, mlb_id, confirmar, motivo }) => {
      const promotionId = "C-MLB5661788";
      const chosen = await chooseListingForWrite(env, item_id, mlb_id);
      if (!chosen.selected) {
        return textResult({
          acao: "bloqueado_por_ambiguidade",
          item_id,
          mensagem: "Este MLBU possui varios MLB. Escolha mlb_id para a promocao.",
          items: chosen.resolved.items.map((item: any) => ({
            mlb: item?.id ?? null,
            title: item?.title ?? null,
            price: item?.price ?? null
          }))
        });
      }
      const item = chosen.selected;
      if (acao === "adicionar_ou_atualizar" && !(Number(deal_price) > 0)) {
        throw new Error("Informe deal_price para adicionar ou atualizar a campanha Damiao.");
      }

      const promos = await getItemPromotions(env, String(item.id));
      const damiao = promos.find(
        (entry: any) =>
          promotionIdOf(entry) === promotionId &&
          String(entry?.type ?? entry?.promotion_type ?? "").toUpperCase() === "SELLER_CAMPAIGN"
      );
      const otherSellerCampaigns = promos.filter(
        (entry: any) =>
          String(entry?.type ?? entry?.promotion_type ?? "").toUpperCase() === "SELLER_CAMPAIGN" &&
          promotionIdOf(entry) !== promotionId &&
          ["started", "pending", "candidate"].includes(String(entry?.status ?? ""))
      );

      const preview = {
        acao_solicitada: acao,
        gravar: confirmar === true,
        promotion_id: promotionId,
        promotion_name: "Damiao",
        mlb: item.id,
        titulo: item.title ?? null,
        preco_base: item.price ?? null,
        deal_price: deal_price ?? null,
        ja_esta_na_damiao: Boolean(damiao),
        oferta_damiao_atual: damiao ? compactPromotionItem(damiao) : null,
        outras_campanhas_vendedor: otherSellerCampaigns.map((entry: any) => compactPromotionItem(entry)),
        escrita_promocoes_habilitada: promotionWritesEnabled(env)
      };

      if (acao === "adicionar_ou_atualizar" && otherSellerCampaigns.length > 0 && !damiao) {
        return textResult({
          ...preview,
          acao: "bloqueado_por_conflito",
          mensagem:
            "O item participa de outra SELLER_CAMPAIGN. Remova primeiro a campanha antiga para evitar conflito antes de entrar na Damiao."
        });
      }

      if (acao === "remover" && !damiao) {
        return textResult({ ...preview, acao: "nenhuma_alteracao" });
      }
      if (!confirmar) return textResult({ ...preview, acao: "simulacao" });
      if (!motivo || motivo.trim().length < 5) {
        throw new Error("Para alterar a promocao Damiao, informe um motivo com pelo menos 5 caracteres.");
      }

      requirePromotionWritesEnabled(env);
      const seller = await meliGet(env, "/users/me");
      const sellerId = String(seller?.id ?? "");
      if (!sellerId) throw new Error("Nao foi possivel identificar o seller_id da conta.");

      // Valida no escopo da campanha antes de gravar. Isso evita confundir um
      // candidate global com um item que nao pertence de fato a esta campanha.
      const campaignItems = await meliGet(
        env,
        `/seller-promotions/promotions/${encodeURIComponent(promotionId)}/items`,
        {
          promotion_type: "SELLER_CAMPAIGN",
          item_id: String(item.id),
          app_version: "v2"
        }
      );
      const scopedResults = Array.isArray(campaignItems?.results) ? campaignItems.results : [];
      const scopedItem = scopedResults.find((entry: any) => String(entry?.id) === String(item.id));
      if (acao === "adicionar_ou_atualizar" && !scopedItem) {
        return textResult({
          ...preview,
          acao: "bloqueado_sem_candidato",
          mensagem:
            "O item nao apareceu no escopo da campanha Damiao no momento da gravacao. Nenhuma alteracao foi feita."
        });
      }

      let write;
      if (acao === "remover") {
        write = await meliSellerPromotionWrite(
          env,
          "DELETE",
          String(item.id),
          sellerId,
          undefined,
          {
            promotion_type: "SELLER_CAMPAIGN",
            promotion_id: promotionId,
            offer_id: String(item.id)
          }
        );
      } else {
        const method: MeliWriteMethod = damiao ? "PUT" : "POST";
        write = await meliSellerPromotionWrite(
          env,
          method,
          String(item.id),
          sellerId,
          {
            promotion_id: promotionId,
            promotion_type: "SELLER_CAMPAIGN",
            deal_price: Number(deal_price)
          }
        );
      }

      const afterPromos = await getItemPromotions(env, String(item.id));
      const audit_id = await recordOperationAudit(env, "promotion:damiao:audit", {
        tipo: "damiao_item_update",
        item_id: item.id,
        acao,
        deal_price: deal_price ?? null,
        motivo: motivo.trim(),
        antes: promos.map((entry: any) => compactPromotionItem(entry)),
        depois: afterPromos.map((entry: any) => compactPromotionItem(entry)),
        endpoint: write.path_used
      });

      return textResult({
        ...preview,
        acao: "gravado",
        audit_id,
        endpoint_utilizado: write.path_used,
        fluxo_api: write.flow ?? "local_v2",
        promocoes_depois: afterPromos.map((entry: any) => compactPromotionItem(entry))
      });
    }
  );

  server.registerTool(
    "remover_item_promocao",
    {
      description:
        "Remove explicitamente um item de uma promocao informada. Util para retirar anuncios de campanhas antigas como Elevate sem tocar na campanha Damiao por engano.",
      inputSchema: {
        item_id: z.string().regex(/^(MLB|MLBU)\d+$/),
        promotion_id: z.string().min(2),
        promotion_type: z.string().min(2).default("SELLER_CAMPAIGN"),
        mlb_id: z.string().regex(/^MLB\d+$/).optional(),
        confirmar: z.boolean().optional().default(false),
        motivo: z.string().max(300).optional()
      }
    },
    async ({ item_id, promotion_id, promotion_type, mlb_id, confirmar, motivo }) => {
      if (promotion_id === "C-MLB5661788") {
        throw new Error("Para remover da campanha Damiao, use gerenciar_promocao_damiao.");
      }
      const chosen = await chooseListingForWrite(env, item_id, mlb_id);
      if (!chosen.selected) {
        return textResult({
          acao: "bloqueado_por_ambiguidade",
          item_id,
          mensagem: "Escolha o mlb_id cuja oferta sera removida.",
          items: chosen.resolved.items.map((item: any) => ({
            mlb: item?.id ?? null,
            title: item?.title ?? null
          }))
        });
      }
      const item = chosen.selected;
      const promos = await getItemPromotions(env, String(item.id));
      const existing = promos.find(
        (entry: any) =>
          promotionIdOf(entry) === promotion_id &&
          String(entry?.type ?? entry?.promotion_type ?? "").toUpperCase() === promotion_type.toUpperCase()
      );
      const preview = {
        acao: confirmar ? "gravar" : "simulacao",
        mlb: item.id,
        promotion_id,
        promotion_type: promotion_type.toUpperCase(),
        oferta_atual: existing ? compactPromotionItem(existing) : null,
        escrita_promocoes_habilitada: promotionWritesEnabled(env)
      };
      if (!existing) return textResult({ ...preview, acao: "nenhuma_alteracao" });
      if (!confirmar) return textResult(preview);
      if (!motivo || motivo.trim().length < 5) {
        throw new Error("Para remover a promocao, informe um motivo com pelo menos 5 caracteres.");
      }

      requirePromotionWritesEnabled(env);
      const write = await meliWrite(
        env,
        "DELETE",
        `/seller-promotions/items/${encodeURIComponent(String(item.id))}?promotion_type=${encodeURIComponent(promotion_type.toUpperCase())}&promotion_id=${encodeURIComponent(promotion_id)}&app_version=v2`
      );
      const afterPromos = await getItemPromotions(env, String(item.id));
      const audit_id = await recordOperationAudit(env, "promotion:remove:audit", {
        tipo: "promotion_item_remove",
        item_id: item.id,
        promotion_id,
        promotion_type: promotion_type.toUpperCase(),
        motivo: motivo.trim(),
        antes: compactPromotionItem(existing),
        depois: afterPromos.map((entry: any) => compactPromotionItem(entry)),
        endpoint: write.path_used
      });
      return textResult({
        ...preview,
        acao: "gravado",
        audit_id,
        endpoint_utilizado: write.path_used,
        promocoes_depois: afterPromos.map((entry: any) => compactPromotionItem(entry))
      });
    }
  );

  server.registerTool(
    "excluir_campanha_vendedor",
    {
      description:
        "Exclui uma SELLER_CAMPAIGN inteira com protecoes fortes. Nunca permite excluir a campanha Damiao.",
      inputSchema: {
        promotion_id: z.string().min(2),
        confirmar_nome: z.string().min(1),
        confirmar: z.boolean().optional().default(false),
        motivo: z.string().max(300).optional()
      }
    },
    async ({ promotion_id, confirmar_nome, confirmar, motivo }) => {
      if (promotion_id === "C-MLB5661788") {
        throw new Error("Protecao Stop Kar: a campanha Damiao nao pode ser excluida por esta ferramenta.");
      }
      const campaign = await meliGet(
        env,
        `/seller-promotions/promotions/${encodeURIComponent(promotion_id)}`,
        { promotion_type: "SELLER_CAMPAIGN", app_version: "v2" }
      );
      const preview = {
        acao: confirmar ? "gravar" : "simulacao",
        campaign: {
          id: campaign?.id ?? promotion_id,
          name: campaign?.name ?? null,
          status: campaign?.status ?? null,
          start_date: campaign?.start_date ?? null,
          finish_date: campaign?.finish_date ?? null,
          type: campaign?.type ?? null
        },
        escrita_promocoes_habilitada: promotionWritesEnabled(env)
      };
      if (String(campaign?.name ?? "") !== confirmar_nome) {
        return textResult({
          ...preview,
          acao: "bloqueado_nome_nao_confere",
          mensagem: "O nome informado nao corresponde exatamente ao nome atual da campanha."
        });
      }
      if (!confirmar) return textResult(preview);
      if (!motivo || motivo.trim().length < 5) {
        throw new Error("Para excluir a campanha, informe um motivo com pelo menos 5 caracteres.");
      }

      requirePromotionWritesEnabled(env);
      const write = await meliWrite(
        env,
        "DELETE",
        `/seller-promotions/promotions/${encodeURIComponent(promotion_id)}?promotion_type=SELLER_CAMPAIGN&app_version=v2`
      );
      const audit_id = await recordOperationAudit(env, "promotion:campaign-delete:audit", {
        tipo: "seller_campaign_delete",
        promotion_id,
        motivo: motivo.trim(),
        antes: campaign,
        endpoint: write.path_used
      });
      return textResult({
        ...preview,
        acao: "gravado",
        audit_id,
        endpoint_utilizado: write.path_used
      });
    }
  );

  server.registerTool(
    "criar_campanha_vendedor",
    {
      description:
        "Cria uma campanha propria SELLER_CAMPAIGN de curta duracao. Nao e a oferta oficial LIGHTNING do Mercado Livre.",
      inputSchema: {
        nome: z.string().min(3).max(100),
        data_inicio: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        data_fim: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        confirmar: z.boolean().optional().default(false),
        motivo: z.string().max(300).optional()
      }
    },
    async ({ nome, data_inicio, data_fim, confirmar, motivo }) => {
      const start = new Date(`${data_inicio}T12:00:00Z`);
      const finish = new Date(`${data_fim}T12:00:00Z`);
      const days = Math.round((finish.getTime() - start.getTime()) / 86_400_000);
      if (!Number.isFinite(days) || days < 0) {
        throw new Error("data_fim deve ser igual ou posterior a data_inicio.");
      }
      if (days > 14) {
        throw new Error("Campanha do vendedor deve respeitar o prazo maximo documentado de 14 dias.");
      }
      const preview = {
        acao: confirmar ? "gravar" : "simulacao",
        nome,
        promotion_type: "SELLER_CAMPAIGN",
        sub_type: "FLEXIBLE_PERCENTAGE",
        data_inicio,
        data_fim,
        escrita_promocoes_habilitada: promotionWritesEnabled(env)
      };
      if (!confirmar) return textResult(preview);
      if (!motivo || motivo.trim().length < 5) {
        throw new Error("Para criar a campanha, informe um motivo com pelo menos 5 caracteres.");
      }
      requirePromotionWritesEnabled(env);
      const write = await meliWrite(
        env,
        "POST",
        "/seller-promotions/promotions?app_version=v2",
        {
          promotion_type: "SELLER_CAMPAIGN",
          name: nome,
          sub_type: "FLEXIBLE_PERCENTAGE",
          start_date: `${data_inicio}T00:00:00`,
          finish_date: `${data_fim}T00:00:00`
        }
      );
      const audit_id = await recordOperationAudit(env, "promotion:campaign-create:audit", {
        tipo: "seller_campaign_create",
        motivo: motivo.trim(),
        solicitado: preview,
        resposta: write.data,
        endpoint: write.path_used
      });
      return textResult({
        ...preview,
        acao: "gravado",
        audit_id,
        endpoint_utilizado: write.path_used,
        campanha_criada: write.data
      });
    }
  );

  server.registerTool(
    "participar_oferta_relampago",
    {
      description:
        "Inclui um item em uma oferta oficial LIGHTNING somente quando o Mercado Livre o disponibilizou como candidato. Exige preco e estoque reservado.",
      inputSchema: {
        item_id: z.string().regex(/^(MLB|MLBU)\d+$/),
        deal_price: z.number().positive(),
        stock: z.number().int().positive(),
        mlb_id: z.string().regex(/^MLB\d+$/).optional(),
        confirmar: z.boolean().optional().default(false),
        motivo: z.string().max(300).optional()
      }
    },
    async ({ item_id, deal_price, stock, mlb_id, confirmar, motivo }) => {
      const chosen = await chooseListingForWrite(env, item_id, mlb_id);
      if (!chosen.selected) {
        return textResult({
          acao: "bloqueado_por_ambiguidade",
          item_id,
          mensagem: "Escolha o mlb_id candidato a oferta relampago.",
          items: chosen.resolved.items.map((item: any) => ({
            mlb: item?.id ?? null,
            title: item?.title ?? null
          }))
        });
      }
      const item = chosen.selected;
      const promos = await getItemPromotions(env, String(item.id));
      const lightning = promos.filter(
        (entry: any) =>
          String(entry?.type ?? entry?.promotion_type ?? "").toUpperCase() === "LIGHTNING"
      );
      const candidate = lightning.find(
        (entry: any) => String(entry?.status ?? "").toLowerCase() === "candidate"
      );
      const preview = {
        acao: confirmar ? "gravar" : "simulacao",
        mlb: item.id,
        deal_price: Number(deal_price),
        stock,
        lightning_disponiveis: lightning.map((entry: any) => compactPromotionItem(entry)),
        candidato: Boolean(candidate),
        escrita_promocoes_habilitada: promotionWritesEnabled(env)
      };
      if (!candidate) {
        return textResult({
          ...preview,
          acao: "bloqueado_sem_convite",
          mensagem:
            "O Mercado Livre nao disponibilizou este item como candidato LIGHTNING. A integracao nao cria convites de oferta relampago."
        });
      }
      if (!confirmar) return textResult(preview);
      if (!motivo || motivo.trim().length < 5) {
        throw new Error("Para participar da oferta relampago, informe um motivo com pelo menos 5 caracteres.");
      }
      requirePromotionWritesEnabled(env);
      const write = await meliWrite(
        env,
        "POST",
        `/seller-promotions/items/${encodeURIComponent(String(item.id))}?app_version=v2`,
        {
          deal_price: Number(deal_price),
          stock: Number(stock),
          promotion_type: "LIGHTNING"
        }
      );
      const afterPromos = await getItemPromotions(env, String(item.id));
      const audit_id = await recordOperationAudit(env, "promotion:lightning:audit", {
        tipo: "lightning_join",
        item_id: item.id,
        deal_price: Number(deal_price),
        stock: Number(stock),
        motivo: motivo.trim(),
        antes: lightning.map((entry: any) => compactPromotionItem(entry)),
        depois: afterPromos.map((entry: any) => compactPromotionItem(entry)),
        endpoint: write.path_used
      });
      return textResult({
        ...preview,
        acao: "gravado",
        audit_id,
        endpoint_utilizado: write.path_used,
        resposta_api: write.data,
        promocoes_depois: afterPromos.map((entry: any) => compactPromotionItem(entry))
      });
    }
  );

  server.registerTool(
    "listar_anuncios",
    {
      description:
        "Lista anuncios da conta Stop Kar no Mercado Livre e pode filtrar apenas anuncios que nunca venderam. Retorna titulo, preco, estoque, vendas, SKU, codigo personalizado, logistica, datas e quantidade de fotos.",
      inputSchema: {
        status: z
          .enum(["active", "paused", "closed", "all"])
          .optional()
          .default("active")
          .describe("Status dos anuncios. Use all para nao filtrar por status."),
        somente_sem_vendas: z
          .boolean()
          .optional()
          .default(false)
          .describe("Se true, retorna somente anuncios com sold_quantity igual a zero na pagina consultada."),
        limite: z.number().int().min(1).max(100).optional().default(50),
        offset: z.number().int().min(0).optional().default(0),
        ordenacao: z
          .enum(["last_updated_desc", "last_updated_asc", "price_asc", "price_desc", "available_quantity_desc"])
          .optional()
          .default("last_updated_desc")
      }
    },
    async ({ status, somente_sem_vendas, limite, offset, ordenacao }) => {
      const me = await meliGet(env, "/users/me");
      const currentStatus = status || "active";
      const currentLimit = Number(limite ?? 50);
      const currentOffset = Number(offset ?? 0);
      const currentOrder = ordenacao || "last_updated_desc";

      const search = await meliGet(env, `/users/${encodeURIComponent(String(me.id))}/items/search`, {
        status: currentStatus === "all" ? undefined : currentStatus,
        limit: String(currentLimit),
        offset: String(currentOffset),
        orders: currentOrder
      });

      const ids = Array.isArray(search?.results)
        ? search.results
            .map((result: any) => (typeof result === "string" ? result : result?.id))
            .filter((id: unknown): id is string => typeof id === "string" && id.length > 0)
        : [];

      const multiGet = await getItemsBulk(env, ids);
      let items = multiGet.items;
      let detailSource = multiGet.source;
      const detailErrors = [...multiGet.errors];

      if (items.length === 0 && currentStatus === "active") {
        try {
          const siteSearch = await meliGet(env, `/sites/${encodeURIComponent(String(me.site_id || "MLB"))}/search`, {
            seller_id: String(me.id),
            limit: String(currentLimit),
            offset: String(currentOffset),
            sort: currentOrder
          });
          if (Array.isArray(siteSearch?.results) && siteSearch.results.length > 0) {
            items = siteSearch.results;
            detailSource = "site_search_fallback";
          }
        } catch (error) {
          detailErrors.push(`site_search: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      const compact = items.map((item: any) => compactListing(item));
      const results = somente_sem_vendas
        ? compact.filter((item: any) => Number(item.sold_quantity ?? 0) === 0)
        : compact;

      const total = Number(search?.paging?.total ?? 0);
      const nextOffset = currentOffset + currentLimit < total ? currentOffset + currentLimit : null;

      return textResult({
        filtro: {
          status: currentStatus,
          somente_sem_vendas: somente_sem_vendas === true,
          ordenacao: currentOrder
        },
        paging: search?.paging ?? {
          total,
          offset: currentOffset,
          limit: currentLimit
        },
        diagnostico: {
          ids_encontrados_na_pagina: ids.length,
          detalhes_encontrados: compact.length,
          fonte_detalhes: detailSource,
          erros_detalhes: detailErrors.slice(0, 5)
        },
        anuncios_consultados_na_pagina: compact.length,
        anuncios_retornados: results.length,
        next_offset: nextOffset,
        results
      });
    }
  );

  server.registerTool(
    "consultar_visitas_anuncio",
    {
      description:
        "Consulta as visitas de um anuncio Mercado Livre em uma janela de ate 150 dias. Util para identificar anuncios sem trafego ou com visitas mas sem vendas.",
      inputSchema: {
        item_id: z.string().min(3).describe("Codigo MLB do anuncio"),
        dias: z.number().int().min(1).max(150).optional().default(30),
        data_final: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional()
          .describe("Data final opcional no formato YYYY-MM-DD")
      }
    },
    async ({ item_id, dias, data_final }) => {
      const visits = await meliGet(env, `/items/${encodeURIComponent(item_id)}/visits/time_window`, {
        last: String(dias ?? 30),
        unit: "day",
        ending: data_final
      });

      return textResult({
        item_id: visits?.item_id ?? item_id,
        date_from: visits?.date_from ?? null,
        date_to: visits?.date_to ?? null,
        total_visits: visits?.total_visits ?? 0,
        last: visits?.last ?? dias ?? 30,
        unit: visits?.unit ?? "day",
        results: Array.isArray(visits?.results) ? visits.results : []
      });
    }
  );

  server.registerTool(
    "consultar_estoque",
    {
      description:
        "Consulta o estoque atual de um anuncio Mercado Livre da Stop Kar, incluindo variacoes quando existirem.",
      inputSchema: {
        item_id: z.string().min(3).describe("Codigo MLB do anuncio")
      }
    },
    async ({ item_id }) => {
      const item = await meliGet(env, `/items/${encodeURIComponent(item_id)}`);
      return textResult({
        id: item.id,
        title: item.title,
        status: item.status,
        available_quantity: item.available_quantity,
        sold_quantity: item.sold_quantity,
        inventory_id: item.inventory_id,
        variations: Array.isArray(item.variations)
          ? item.variations.map((variation: any) => ({
              id: variation.id,
              available_quantity: variation.available_quantity,
              sold_quantity: variation.sold_quantity,
              seller_sku: getSellerSku(variation),
              seller_custom_field: variation.seller_custom_field,
              inventory_id: variation.inventory_id
            }))
          : []
      });
    }
  );

  server.registerTool(
    "consultar_preco",
    {
      description: "Consulta o preco atual de um anuncio Mercado Livre da Stop Kar.",
      inputSchema: {
        item_id: z.string().min(3).describe("Codigo MLB do anuncio")
      }
    },
    async ({ item_id }) => {
      const item = await meliGet(env, `/items/${encodeURIComponent(item_id)}`);
      return textResult({
        id: item.id,
        title: item.title,
        status: item.status,
        price: item.price,
        base_price: item.base_price,
        original_price: item.original_price,
        currency_id: item.currency_id,
        listing_type_id: item.listing_type_id
      });
    }
  );

  server.registerTool(
    "consultar_vendas",
    {
      description:
        "Consulta pedidos/vendas da conta Mercado Livre da Stop Kar. Por padrao, o periodo usa a data de fechamento/pagamento da venda; opcionalmente pode usar a data de criacao do pedido. Inclui shipping_id quando disponivel. Nao retorna dados pessoais do comprador.",
      inputSchema: {
        data_inicial: z
          .string()
          .optional()
          .describe("Data/hora ISO inicial, por exemplo 2026-09-01T00:00:00-03:00"),
        data_final: z
          .string()
          .optional()
          .describe("Data/hora ISO final, por exemplo 2026-09-15T23:59:59-03:00"),
        status: z.string().optional().describe("Status do pedido, por exemplo paid ou cancelled"),
        criterio_data: z
          .enum(["fechamento", "criacao"])
          .optional()
          .default("fechamento")
          .describe("Criterio do periodo: fechamento usa date_closed e e o padrao; criacao usa date_created."),
        limite: z.number().int().min(1).max(50).optional().default(20)
      }
    },
    async ({ data_inicial, data_final, status, criterio_data, limite }) => {
      const me = await meliGet(env, "/users/me");
      const criterio = criterio_data || "fechamento";
      const filtroInicial = criterio === "criacao" ? "order.date_created.from" : "order.date_closed.from";
      const filtroFinal = criterio === "criacao" ? "order.date_created.to" : "order.date_closed.to";
      const orders = await meliGet(env, "/orders/search", {
        seller: String(me.id),
        [filtroInicial]: data_inicial,
        [filtroFinal]: data_final,
        "order.status": status,
        sort: "date_desc",
        limit: String(limite ?? 20),
        offset: "0"
      });

      const results = Array.isArray(orders?.results)
        ? orders.results.map((order: any) => compactOrder(order))
        : [];

      return textResult({
        periodo: {
          criterio_data: criterio,
          data_inicial: data_inicial ?? null,
          data_final: data_final ?? null
        },
        paging: orders?.paging,
        results
      });
    }
  );

  server.registerTool(
    "consultar_envio_pedido",
    {
      description:
        "Consulta o envio e o prazo maximo de despacho (SLA) de um pedido Mercado Livre da Stop Kar. Retorna shipment_id, status, tipo logistico e expected_date sem dados pessoais do comprador.",
      inputSchema: {
        order_id: z
          .union([z.string().min(3), z.number().int().positive()])
          .describe("Numero do pedido Mercado Livre, por exemplo 2000018481636328")
      }
    },
    async ({ order_id }) => {
      const order = await meliGet(env, `/orders/${encodeURIComponent(String(order_id))}`);
      const enriched = await enrichOrderWithShipments(env, order);
      return textResult(enriched);
    }
  );

  server.registerTool(
    "consultar_envios",
    {
      description:
        "Consulta pedidos da Stop Kar e cruza cada pedido com shipment e SLA para identificar o que ainda precisa ser despachado. Pode filtrar pela data limite de despacho no formato YYYY-MM-DD. Nao retorna dados pessoais do comprador.",
      inputSchema: {
        data_inicial: z
          .string()
          .optional()
          .describe("Data/hora ISO inicial da venda, por exemplo 2026-09-14T00:00:00-03:00"),
        data_final: z
          .string()
          .optional()
          .describe("Data/hora ISO final da venda, por exemplo 2026-09-16T23:59:59-03:00"),
        status: z.string().optional().default("paid").describe("Status do pedido; por padrao paid"),
        data_despacho: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional()
          .describe("Filtra pelo dia do SLA/expected_date, no formato YYYY-MM-DD"),
        somente_pendentes: z
          .boolean()
          .optional()
          .default(true)
          .describe("Se true, retorna apenas pedidos com envio ainda pendente de despacho"),
        limite: z.number().int().min(1).max(30).optional().default(20)
      }
    },
    async ({ data_inicial, data_final, status, data_despacho, somente_pendentes, limite }) => {
      const me = await meliGet(env, "/users/me");
      const orders = await meliGet(env, "/orders/search", {
        seller: String(me.id),
        "order.date_created.from": data_inicial,
        "order.date_created.to": data_final,
        "order.status": status || "paid",
        sort: "date_desc",
        limit: String(limite ?? 20),
        offset: "0"
      });

      const sourceOrders = Array.isArray(orders?.results) ? orders.results : [];
      const enriched = await Promise.all(
        sourceOrders.map((order: any) => enrichOrderWithShipments(env, order))
      );

      const results = enriched.filter((order: any) => {
        const shipments = Array.isArray(order.shipments) ? order.shipments : [];
        const matching = shipments.filter((shipment: any) => {
          if (somente_pendentes !== false && !shipment.pendente_despacho) return false;
          if (data_despacho) {
            const expectedDate = shipment?.sla?.expected_date;
            if (typeof expectedDate !== "string" || expectedDate.slice(0, 10) !== data_despacho) {
              return false;
            }
          }
          return true;
        });

        order.shipments = matching;
        return matching.length > 0;
      });

      return textResult({
        periodo_vendas: {
          data_inicial: data_inicial ?? null,
          data_final: data_final ?? null,
          status: status || "paid"
        },
        filtro_despacho: data_despacho ?? null,
        somente_pendentes: somente_pendentes !== false,
        total_pedidos: results.length,
        results
      });
    }
  );



  server.registerTool(
    "consultar_ads_venda",
    {
      description:
        "Cruza uma venda/order ou pack da Stop Kar com metricas oficiais de Product Ads na data da venda. Retorna custo do item em Ads, TACOS/ACOS, vendas diretas/indiretas e nivel de confianca da atribuicao. Somente leitura.",
      inputSchema: {
        venda_id: z
          .union([z.string().min(3), z.number().int().positive()])
          .describe("Order ID ou pack_id da venda Mercado Livre"),
        janela_dias: z
          .number()
          .int()
          .min(1)
          .max(30)
          .optional()
          .default(14)
          .describe("Janela para analisar custo e TACOS do item; padrao 14 dias.")
      }
    },
    async ({ venda_id, janela_dias }) => {
      const me = await meliGet(env, "/users/me");
      const siteId = String(me?.site_id || "MLB");
      const advertiser = await getPadsAdvertiser(env, siteId);

      if (!advertiser?.advertiser_id) {
        return textResult({
          venda_id,
          product_ads_disponivel: false,
          motivo:
            "A conta nao retornou advertiser de Product Ads. Confirme se Mercado Ads/Product Ads esta habilitado para a conta."
        });
      }

      const resolved = await resolveSaleReference(env, venda_id);
      const itemCache = new Map<string, any>();
      const salesDayCache = new Map<string, any>();
      const outputs: any[] = [];

      for (const order of resolved.orders) {
        const saleDate = saoPauloDateOnly(order?.date_closed ?? order?.date_created);
        if (!saleDate) continue;
        const windowDays = Number(janela_dias ?? 14);
        const windowFrom = shiftIsoDate(saleDate, -(windowDays - 1));

        for (const entry of Array.isArray(order?.order_items) ? order.order_items : []) {
          const itemId = String(entry?.item?.id || "");
          if (!itemId) continue;

          const quantity = Number(entry?.quantity ?? 0);
          const unitPrice = Number(entry?.unit_price ?? 0);
          const saleAmount = Number((quantity * unitPrice).toFixed(2));

          const dayKey = `${itemId}|${saleDate}`;
          let salesDay = salesDayCache.get(dayKey);
          if (!salesDay) {
            salesDay = await countItemOrdersOnDate(env, me.id, itemId, saleDate);
            salesDayCache.set(dayKey, salesDay);
          }

          let dayAds = itemCache.get(`day|${dayKey}`);
          if (!dayAds) {
            dayAds = await getAdsRowsForItemPeriod(
              env,
              siteId,
              advertiser.advertiser_id,
              itemId,
              saleDate,
              saleDate
            );
            itemCache.set(`day|${dayKey}`, dayAds);
          }

          let windowAds = itemCache.get(`window|${itemId}|${windowFrom}|${saleDate}`);
          if (!windowAds) {
            windowAds = await getAdsRowsForItemPeriod(
              env,
              siteId,
              advertiser.advertiser_id,
              itemId,
              windowFrom,
              saleDate
            );
            itemCache.set(`window|${itemId}|${windowFrom}|${saleDate}`, windowAds);
          }

          const directSalesDay = Number(dayAds.metrics.direct_items_quantity ?? 0);
          const directAmountDay = Number(dayAds.metrics.direct_amount ?? 0);
          const adsSalesDay = Number(dayAds.metrics.advertising_items_quantity ?? 0);
          const dailyCost = Number(dayAds.metrics.cost ?? 0);
          const windowCost = Number(windowAds.metrics.cost ?? 0);
          const windowDirectSales = Number(windowAds.metrics.direct_items_quantity ?? 0);

          const amountTolerance = Math.max(0.1, saleAmount * 0.02);
          const amountMatches =
            directAmountDay > 0 && Math.abs(directAmountDay - saleAmount) <= amountTolerance;

          let attributionStatus = "indeterminada";
          let attributionConfidence = "baixa";

          if (dayAds.ad_groups.length === 0) {
            attributionStatus = "item_sem_ad_group_product_ads_encontrado";
          } else if (dayAds.rows.length === 0) {
            attributionStatus = "sem_metricas_ads_para_o_item_na_data";
          } else if (directSalesDay <= 0) {
            attributionStatus = "nenhuma_venda_direta_product_ads_detectada_para_o_item_na_data";
            attributionConfidence = "media";
          } else if (
            salesDay.orders_with_item === 1 &&
            directSalesDay === 1 &&
            amountMatches
          ) {
            attributionStatus = "forte_indicio_de_que_esta_venda_foi_direta_via_product_ads";
            attributionConfidence = "alta";
          } else {
            attributionStatus =
              "houve_venda_direta_via_product_ads_no_item_na_data_mas_a_order_exata_nao_e_exposta_pela_api";
            attributionConfidence = "media";
          }

          outputs.push({
            order_id: order?.id ?? null,
            pack_id: order?.pack_id ?? null,
            item_id: itemId,
            title: entry?.item?.title ?? null,
            seller_sku: entry?.item?.seller_sku ?? null,
            quantity,
            unit_price: unitPrice,
            sale_amount: saleAmount,
            sale_fee: entry?.sale_fee ?? null,
            sale_date: saleDate,
            ads: {
              advertiser_id: advertiser.advertiser_id,
              atribuicao: {
                status: attributionStatus,
                confianca: attributionConfidence,
                exata_por_order_id: false,
                observacao:
                  "Product Ads retorna custo e conversoes por item/ad group e periodo, mas nao informa o order_id de cada conversao."
              },
              metricas_no_dia_da_venda: {
                ...dayAds.metrics,
                custo_ads_do_item_no_dia: dailyCost,
                houve_venda_ads_no_dia: adsSalesDay > 0,
                houve_venda_direta_ads_no_dia: directSalesDay > 0
              },
              vendas_reais_do_item_no_dia: salesDay,
              janela: {
                dias: windowDays,
                date_from: windowFrom,
                date_to: saleDate,
                metrics: windowAds.metrics,
                custo_ads_total: windowCost,
                custo_ads_medio_por_venda_direta:
                  windowDirectSales > 0
                    ? Number((windowCost / windowDirectSales).toFixed(2))
                    : null
              },
              erros: [...dayAds.errors, ...windowAds.errors].slice(0, 10)
            }
          });
        }
      }

      return textResult({
        reference_type: resolved.reference_type,
        pack: resolved.pack,
        advertiser: {
          advertiser_id: advertiser.advertiser_id,
          site_id: advertiser.site_id ?? siteId,
          advertiser_name: advertiser.advertiser_name ?? null,
          account_name: advertiser.account_name ?? null
        },
        itens: outputs,
        observacoes: [
          "Metricas de Product Ads podem ter atraso de atualizacao.",
          "A API de Ads nao expoe o order_id da conversao; a atribuicao individual pode ser inferida com alta confianca apenas em alguns casos.",
          "Para precificacao previa, mantenha uma reserva de Ads; para auditoria pos-venda, use o custo/TACOS observado desta consulta."
        ]
      });
    }
  );

  server.registerTool(
    "consultar_custo_frete_envio",
    {
      description:
        "Consulta o custo real de frete cobrado do vendedor em um shipment Mercado Livre. Funciona para ME2, incluindo Full, Flex, Agencia/Places, Coleta/Cross Docking e Drop-off. Somente leitura.",
      inputSchema: {
        shipment_id: z
          .union([z.string().min(3), z.number().int().positive()])
          .describe("ID do shipment/envio Mercado Livre")
      }
    },
    async ({ shipment_id }) => {
      const shipment = await meliGet(
        env,
        `/shipments/${encodeURIComponent(String(shipment_id))}`,
        {},
        { "x-format-new": "true" }
      );

      const costs = await meliGet(
        env,
        `/shipments/${encodeURIComponent(String(shipment_id))}/costs`,
        {},
        { "x-format-new": "true" }
      );

      const senders = Array.isArray(costs?.senders) ? costs.senders : [];
      const sellerCost = senders.reduce((sum: number, sender: any) => {
        const value = Number(sender?.cost);
        return sum + (Number.isFinite(value) ? value : 0);
      }, 0);

      const logisticType = shipment?.logistic?.type ?? shipment?.logistic_type ?? null;

      return textResult({
        shipment_id: shipment?.id ?? shipment_id,
        status: shipment?.status ?? null,
        logistic_type: logisticType,
        logistic_label: logisticLabel(logisticType),
        shipping_mode: shipment?.logistic?.mode ?? shipment?.mode ?? null,
        gross_amount: costs?.gross_amount ?? null,
        seller_cost: Number(sellerCost.toFixed(2)),
        buyer_cost: costs?.receiver?.cost ?? null,
        seller_compensation: Number(
          senders
            .reduce((sum: number, sender: any) => {
              const value = Number(sender?.compensation);
              return sum + (Number.isFinite(value) ? value : 0);
            }, 0)
            .toFixed(2)
        ),
        seller_details: senders.map((sender: any) => ({
          user_id: sender?.user_id ?? null,
          cost: sender?.cost ?? null,
          compensation: sender?.compensation ?? null,
          discounts: Array.isArray(sender?.discounts) ? sender.discounts : []
        })),
        buyer_details: costs?.receiver
          ? {
              user_id: costs.receiver.user_id ?? null,
              cost: costs.receiver.cost ?? null,
              compensation: costs.receiver.compensation ?? null,
              discounts: Array.isArray(costs.receiver.discounts) ? costs.receiver.discounts : []
            }
          : null
      });
    }
  );

  server.registerTool(
    "simular_custo_frete",
    {
      description:
        "Simula o custo aproximado de frete para o vendedor antes de publicar ou editar um anuncio. Aceita Full, Flex e demais modalidades ME2. Informe item_id de um anuncio existente OU dimensoes para um produto novo. Somente leitura.",
      inputSchema: {
        item_id: z
          .string()
          .min(3)
          .optional()
          .describe("Codigo MLB de um anuncio existente. Se omitido, informe dimensoes."),
        dimensoes: z
          .string()
          .min(3)
          .optional()
          .describe("Altura x largura x comprimento em cm, peso em gramas. Exemplo: 9x17x22,462"),
        preco: z.number().positive().optional().describe("Preco final de venda simulado"),
        listing_type_id: z
          .enum(["gold_special", "gold_pro", "free"])
          .optional()
          .describe("gold_special=Classico, gold_pro=Premium"),
        logistic_type: z
          .enum(["drop_off", "cross_docking", "xd_drop_off", "self_service", "turbo", "fulfillment"])
          .optional()
          .describe("Normal/Agencia geralmente xd_drop_off; Flex=self_service; Full=fulfillment"),
        mode: z.string().min(1).optional().default("me2"),
        free_shipping: z
          .boolean()
          .optional()
          .default(true)
          .describe("True se o vendedor oferece frete gratis ao comprador"),
        condition: z.string().min(1).optional().default("new"),
        verbose: z.boolean().optional().default(true)
      }
    },
    async ({
      item_id,
      dimensoes,
      preco,
      listing_type_id,
      logistic_type,
      mode,
      free_shipping,
      condition,
      verbose
    }) => {
      if (!item_id && !dimensoes) {
        throw new Error("Informe item_id de um anuncio existente ou dimensoes para simular um produto novo.");
      }

      const me = await meliGet(env, "/users/me");
      const data = await meliGet(
        env,
        `/users/${encodeURIComponent(String(me.id))}/shipping_options/free`,
        {
          item_id,
          dimensions: dimensoes,
          item_price: typeof preco === "number" ? String(preco) : undefined,
          listing_type_id,
          mode: mode || "me2",
          condition: condition || "new",
          logistic_type,
          free_shipping: String(free_shipping !== false),
          verbose: String(verbose !== false)
        }
      );

      const allCountry = data?.coverage?.all_country ?? null;

      return textResult({
        seller_id: me.id,
        entrada: {
          item_id: item_id ?? null,
          dimensoes: dimensoes ?? null,
          preco: preco ?? null,
          listing_type_id: listing_type_id ?? null,
          logistic_type: logistic_type ?? null,
          logistic_label: logisticLabel(logistic_type),
          mode: mode || "me2",
          free_shipping: free_shipping !== false,
          condition: condition || "new"
        },
        resultado: {
          list_cost: allCountry?.list_cost ?? null,
          currency_id: allCountry?.currency_id ?? "BRL",
          billable_weight: allCountry?.billable_weight ?? null
        },
        raw_coverage: data?.coverage ?? null,
        observacoes: [
          "Este valor e uma estimativa pre-venda.",
          "Para a venda concluida, use consultar_custo_frete_envio e considere seller_cost como o valor definitivo cobrado do vendedor."
        ]
      });
    }
  );

  server.registerTool(
    "listar_promocoes",
    {
      description:
        "Lista campanhas/promocoes disponiveis para a conta Stop Kar no Mercado Livre. Somente leitura. Por padrao retorna campanhas iniciadas (started).",
      inputSchema: {
        status: z
          .enum(["started", "pending", "finished", "all"])
          .optional()
          .default("started")
          .describe("Status da campanha. Use all para retornar todos os status."),
        tipo: z
          .string()
          .min(1)
          .optional()
          .describe("Filtro local opcional pelo tipo da promocao, por exemplo DEAL, PRICE_DISCOUNT, SMART ou SELLER_CAMPAIGN.")
      }
    },
    async ({ status, tipo }) => {
      const me = await meliGet(env, "/users/me");
      const data = await meliGet(
        env,
        `/seller-promotions/users/${encodeURIComponent(String(me.id))}`,
        { app_version: "v2" }
      );

      const campaigns = Array.isArray(data?.results)
        ? data.results
        : Array.isArray(data)
          ? data
          : [];

      const statusFilter = status || "started";
      const typeFilter = tipo?.trim().toUpperCase();

      const results = campaigns
        .filter((campaign: any) => statusFilter === "all" || campaign?.status === statusFilter)
        .filter(
          (campaign: any) =>
            !typeFilter || String(campaign?.type || "").toUpperCase() === typeFilter
        )
        .map((campaign: any) => ({
          id: campaign?.id ?? null,
          type: campaign?.type ?? null,
          sub_type: campaign?.sub_type ?? null,
          status: campaign?.status ?? null,
          name: campaign?.name ?? null,
          start_date: campaign?.start_date ?? null,
          finish_date: campaign?.finish_date ?? null,
          deadline_date: campaign?.deadline_date ?? null,
          benefits: campaign?.benefits ?? null
        }));

      return textResult({
        seller_id: me.id,
        status: statusFilter,
        tipo: typeFilter ?? null,
        total: results.length,
        results
      });
    }
  );

  server.registerTool(
    "consultar_promocoes_anuncio",
    {
      description:
        "Consulta todas as promocoes associadas a um anuncio da Stop Kar, incluindo preco promocional, preco original, percentuais do vendedor/Mercado Livre e campos de boost quando existirem. Somente leitura.",
      inputSchema: {
        item_id: z.string().min(3).describe("Codigo MLB do anuncio")
      }
    },
    async ({ item_id }) => {
      const item = await meliGet(env, `/items/${encodeURIComponent(item_id)}`);
      const data = await meliGet(
        env,
        `/seller-promotions/items/${encodeURIComponent(item_id)}`,
        { app_version: "v2" }
      );

      const entries = Array.isArray(data)
        ? data
        : Array.isArray(data?.results)
          ? data.results
          : [];

      return textResult({
        item: {
          id: item?.id ?? item_id,
          title: item?.title ?? null,
          status: item?.status ?? null,
          price: item?.price ?? null,
          base_price: item?.base_price ?? null,
          original_price: item?.original_price ?? null,
          listing_type_id: item?.listing_type_id ?? null,
          category_id: item?.category_id ?? null,
          logistic_type: item?.shipping?.logistic_type ?? null,
          shipping_mode: item?.shipping?.mode ?? null,
          free_shipping: item?.shipping?.free_shipping ?? null
        },
        total: entries.length,
        results: entries.map((entry: any) => compactPromotionItem(entry))
      });
    }
  );

  server.registerTool(
    "listar_itens_promocao",
    {
      description:
        "Lista os anuncios pertencentes a uma campanha do Mercado Livre e mostra preco promocional, preco original, desconto efetivo e participacao do vendedor/Mercado Livre quando disponivel. Somente leitura.",
      inputSchema: {
        promotion_id: z.string().min(2).describe("ID da campanha/promocao"),
        promotion_type: z
          .string()
          .min(2)
          .describe("Tipo da promocao, por exemplo DEAL, MARKETPLACE_CAMPAIGN, PRICE_DISCOUNT, SELLER_CAMPAIGN, SMART ou PRICE_MATCHING"),
        status: z
          .enum(["started", "pending", "candidate"])
          .optional()
          .describe("Filtro opcional pelo status do item na promocao"),
        status_item: z
          .enum(["active", "paused"])
          .optional()
          .describe("Filtro opcional pelo status atual do anuncio"),
        item_id: z.string().min(3).optional().describe("Filtro opcional por codigo MLB"),
        limite: z.number().int().min(1).max(50).optional().default(50),
        search_after: z
          .string()
          .min(1)
          .optional()
          .describe("Cursor de paginacao retornado pela consulta anterior")
      }
    },
    async ({
      promotion_id,
      promotion_type,
      status,
      status_item,
      item_id,
      limite,
      search_after
    }) => {
      const data = await meliGet(
        env,
        `/seller-promotions/promotions/${encodeURIComponent(promotion_id)}/items`,
        {
          promotion_type,
          status,
          status_item,
          item_id,
          app_version: "v2",
          limit: String(limite ?? 50),
          search_after
        }
      );

      const entries = Array.isArray(data?.results)
        ? data.results
        : Array.isArray(data)
          ? data
          : [];

      return textResult({
        promotion_id,
        promotion_type,
        total_retornado: entries.length,
        paging: data?.paging ?? null,
        next_search_after:
          data?.searchAfter ?? data?.search_after ?? data?.paging?.searchAfter ?? null,
        results: entries.map((entry: any) => compactPromotionItem(entry))
      });
    }
  );

  server.registerTool(
    "simular_custo_venda",
    {
      description:
        "Consulta o calculador oficial listing_prices do Mercado Livre antes de publicar ou alterar um produto. Retorna sale_fee_amount, percentual de comissao, taxa fixa e custo efetivo da venda. Somente leitura.",
      inputSchema: {
        preco: z.number().positive().describe("Preco final de venda a ser simulado"),
        category_id: z.string().min(3).describe("Categoria Mercado Livre, por exemplo MLB428983"),
        listing_type_id: z
          .enum(["gold_special", "gold_pro", "free"])
          .describe("Tipo de anuncio: gold_special=Classico, gold_pro=Premium"),
        logistic_type: z
          .string()
          .min(1)
          .describe("Tipo logistico previsto, por exemplo fulfillment ou xd_drop_off"),
        shipping_mode: z
          .string()
          .min(1)
          .describe("Modo de envio previsto, normalmente me2 no Mercado Envios"),
        currency_id: z.string().min(3).optional().default("BRL"),
        billable_weight: z
          .number()
          .positive()
          .optional()
          .describe("Peso faturavel quando conhecido, para aumentar a precisao do custo"),
        channel: z
          .string()
          .min(1)
          .optional()
          .default("marketplace")
          .describe("Canal da venda; por padrao marketplace")
      }
    },
    async ({
      preco,
      category_id,
      listing_type_id,
      logistic_type,
      shipping_mode,
      currency_id,
      billable_weight,
      channel
    }) => {
      const me = await meliGet(env, "/users/me");
      const siteId = String(me?.site_id || "MLB");

      const data = await meliGet(env, `/sites/${encodeURIComponent(siteId)}/listing_prices`, {
        price: String(preco),
        category_id,
        listing_type_id,
        currency_id: currency_id || "BRL",
        logistic_type,
        shipping_mode,
        billable_weight:
          typeof billable_weight === "number" ? String(billable_weight) : undefined,
        channel: channel || "marketplace"
      });

      const entries = Array.isArray(data) ? data : data ? [data] : [];
      const selected =
        entries.find((entry: any) => entry?.listing_type_id === listing_type_id) ??
        entries[0] ??
        null;

      if (!selected) {
        throw new Error("O Mercado Livre nao retornou uma cotacao de custo para os parametros informados.");
      }

      const saleFeeAmount = Number(selected?.sale_fee_amount);
      const effectivePercentage =
        Number.isFinite(saleFeeAmount) && Number(preco) > 0
          ? Number(((saleFeeAmount / Number(preco)) * 100).toFixed(4))
          : null;

      return textResult({
        site_id: siteId,
        entrada: {
          preco,
          category_id,
          listing_type_id,
          logistic_type,
          shipping_mode,
          currency_id: currency_id || "BRL",
          billable_weight: billable_weight ?? null,
          channel: channel || "marketplace"
        },
        resultado: {
          listing_type_id: selected?.listing_type_id ?? listing_type_id,
          listing_type_name: selected?.listing_type_name ?? null,
          listing_exposure: selected?.listing_exposure ?? null,
          currency_id: selected?.currency_id ?? currency_id ?? "BRL",
          listing_fee_amount: selected?.listing_fee_amount ?? null,
          sale_fee_amount: selected?.sale_fee_amount ?? null,
          percentual_efetivo_total: effectivePercentage,
          percentage_fee: selected?.sale_fee_details?.percentage_fee ?? null,
          meli_percentage_fee: selected?.sale_fee_details?.meli_percentage_fee ?? null,
          fixed_fee: selected?.sale_fee_details?.fixed_fee ?? null,
          financing_add_on_fee: selected?.sale_fee_details?.financing_add_on_fee ?? null,
          gross_amount: selected?.sale_fee_details?.gross_amount ?? null,
          stop_time: selected?.stop_time ?? null
        },
        observacoes: [
          "O fixed_fee ja esta incluido em sale_fee_amount e nao deve ser somado novamente.",
          ...(billable_weight == null
            ? [
                "billable_weight nao foi informado. Se ele for relevante para a modalidade logistica, confirme o peso faturavel antes de considerar a precificacao definitiva."
              ]
            : [])
        ]
      });
    }
  );

  server.registerTool(
    "consultar_tendencias",
    {
      description:
        "Consulta as tendencias semanais de busca do Mercado Livre para o Brasil. Se o endpoint oficial /trends estiver temporariamente indisponivel, retorna um fallback de sinais de demanda usando busca e/ou mais vendidos, claramente identificado como fallback.",
      inputSchema: {
        category_id: z
          .string()
          .min(3)
          .optional()
          .describe("Categoria Mercado Livre, por exemplo MLB22664. Se omitida, consulta tendencias gerais do site."),
        termo: z
          .string()
          .min(1)
          .optional()
          .describe("Filtro local opcional. Quando /trends estiver indisponivel, tambem e usado para gerar sinais de busca do mercado.")
      }
    },
    async ({ category_id, termo }) => {
      const me = await meliGet(env, "/users/me");
      const siteId = String(me?.site_id || "MLB");
      const path = category_id
        ? `/trends/${encodeURIComponent(siteId)}/${encodeURIComponent(category_id)}`
        : `/trends/${encodeURIComponent(siteId)}`;

      try {
        const trends = await meliGet(env, path);
        const entries = Array.isArray(trends) ? trends : [];

        const normalized = entries.map((entry: any, index: number) => ({
          position: index + 1,
          grupo:
            index < 10
              ? "crescimento_mais_rapido"
              : index < 30
                ? "maior_volume_de_busca"
                : "tendencia_popular",
          keyword: entry?.keyword ?? null,
          url: entry?.url ?? null
        }));

        const filterTerm = termo?.trim().toLocaleLowerCase("pt-BR");
        const results = filterTerm
          ? normalized.filter((entry: any) =>
              String(entry.keyword || "").toLocaleLowerCase("pt-BR").includes(filterTerm)
            )
          : normalized;

        return textResult({
          site_id: siteId,
          category_id: category_id ?? null,
          fonte: "trends_api_oficial",
          fallback: false,
          atualizacao: "semanal",
          legenda_grupos: {
            posicoes_1_a_10: "crescimento_mais_rapido",
            posicoes_11_a_30: "maior_volume_de_busca",
            posicoes_31_a_50: "tendencia_popular"
          },
          total_recebido: normalized.length,
          total_retornado: results.length,
          results
        });
      } catch (error) {
        const trendsError = error instanceof Error ? error.message : String(error);
        if (!trendsError.includes("404")) throw error;

        const sinaisCatalogo: any[] = [];
        let catalogSearchError: string | null = null;
        const query = termo?.trim();

        let categoriaDetectada: any = null;
        let categoryDiscoveryError: string | null = null;
        let resolvedCategoryId = category_id ?? null;

        if (query && !resolvedCategoryId) {
          try {
            const predictions = await meliGet(
              env,
              `/sites/${encodeURIComponent(siteId)}/domain_discovery/search`,
              { q: query, limit: "1" }
            );
            const first = Array.isArray(predictions) ? predictions[0] : null;
            if (first) {
              categoriaDetectada = {
                category_id: first?.category_id ?? null,
                category_name: first?.category_name ?? null,
                domain_id: first?.domain_id ?? null,
                domain_name: first?.domain_name ?? null
              };
              resolvedCategoryId = first?.category_id ?? null;
            }
          } catch (discoveryFailure) {
            categoryDiscoveryError =
              discoveryFailure instanceof Error ? discoveryFailure.message : String(discoveryFailure);
          }
        }

        if (query) {
          try {
            const search = await meliGet(env, "/products/search", {
              status: "active",
              site_id: siteId,
              q: query
            });

            const rows = Array.isArray(search?.results) ? search.results : [];
            for (const [index, product] of rows.entries()) {
              sinaisCatalogo.push({
                position: index + 1,
                id: product?.id ?? null,
                name: product?.name ?? product?.title ?? null,
                domain_id: product?.domain_id ?? null,
                status: product?.status ?? null,
                listing_strategy: product?.settings?.listing_strategy ?? null
              });
            }
          } catch (searchFailure) {
            catalogSearchError =
              searchFailure instanceof Error ? searchFailure.message : String(searchFailure);
          }
        }

        const maisVendidos: any[] = [];
        let highlightsError: string | null = null;
        if (resolvedCategoryId) {
          try {
            const highlights = await meliGet(
              env,
              `/highlights/${encodeURIComponent(siteId)}/category/${encodeURIComponent(resolvedCategoryId)}`
            );
            const content = Array.isArray(highlights?.content) ? highlights.content : [];
            for (const [index, entry] of content.entries()) {
              maisVendidos.push({
                position: entry?.position ?? index + 1,
                id: entry?.id ?? null,
                type: entry?.type ?? null
              });
            }
          } catch (highlightsFailure) {
            highlightsError =
              highlightsFailure instanceof Error
                ? highlightsFailure.message
                : String(highlightsFailure);
          }
        }

        return textResult({
          site_id: siteId,
          category_id: category_id ?? null,
          categoria_detectada: categoriaDetectada,
          category_id_usada_no_fallback: resolvedCategoryId,
          fonte: "fallback_sinais_de_demanda",
          fallback: true,
          aviso:
            "O endpoint oficial /trends retornou 404. Estes dados sao sinais alternativos (catalogo relevante e mais vendidos) e NAO devem ser apresentados como o ranking oficial de tendencias.",
          erro_trends: trendsError,
          termo_consultado: query ?? null,
          sinais_catalogo: sinaisCatalogo,
          sinais_catalogo_error: catalogSearchError,
          category_discovery_error: categoryDiscoveryError,
          mais_vendidos_categoria: maisVendidos,
          mais_vendidos_error: highlightsError
        });
      }
    }
  );

  server.registerTool(
    "consultar_mais_vendidos_categoria",
    {
      description:
        "Consulta o ranking de ate 20 produtos ou anuncios mais vendidos de uma categoria do Mercado Livre. Pode detalhar os primeiros resultados para mostrar titulo/nome e dados uteis para comparar concorrentes.",
      inputSchema: {
        category_id: z.string().min(3).describe("Categoria Mercado Livre, por exemplo MLB22664"),
        limite_detalhes: z
          .number()
          .int()
          .min(0)
          .max(20)
          .optional()
          .default(10)
          .describe("Quantos resultados do ranking devem receber consulta de detalhes. Use 0 para retornar apenas o ranking.")
      }
    },
    async ({ category_id, limite_detalhes }) => {
      const me = await meliGet(env, "/users/me");
      const siteId = String(me?.site_id || "MLB");
      const highlights = await meliGet(
        env,
        `/highlights/${encodeURIComponent(siteId)}/category/${encodeURIComponent(category_id)}`
      );

      const content = Array.isArray(highlights?.content) ? highlights.content : [];
      const detailsLimit = Math.max(0, Math.min(20, Number(limite_detalhes ?? 10)));

      const results = await Promise.all(
        content.map(async (entry: any, index: number) => {
          const base = {
            id: entry?.id ?? null,
            position: entry?.position ?? index + 1,
            type: entry?.type ?? null
          };

          if (index >= detailsLimit || !entry?.id || !entry?.type) {
            return base;
          }

          try {
            if (entry.type === "ITEM") {
              const item = await meliGet(env, `/items/${encodeURIComponent(String(entry.id))}`);
              return {
                ...base,
                detalhe: {
                  id: item?.id ?? entry.id,
                  title: item?.title ?? null,
                  category_id: item?.category_id ?? null,
                  price: item?.price ?? null,
                  currency_id: item?.currency_id ?? null,
                  sold_quantity: item?.sold_quantity ?? null,
                  listing_type_id: item?.listing_type_id ?? null,
                  free_shipping: item?.shipping?.free_shipping ?? null,
                  permalink: item?.permalink ?? null,
                  catalog_product_id: item?.catalog_product_id ?? null,
                  user_product_id: item?.user_product_id ?? null
                }
              };
            }

            if (entry.type === "PRODUCT") {
              const product = await meliGet(env, `/products/${encodeURIComponent(String(entry.id))}`);
              return {
                ...base,
                detalhe: {
                  id: product?.id ?? entry.id,
                  name: product?.name ?? product?.title ?? null,
                  status: product?.status ?? null,
                  domain_id: product?.domain_id ?? null,
                  family_name: product?.family_name ?? null,
                  attributes: Array.isArray(product?.attributes)
                    ? product.attributes.map((attribute: any) => ({
                        id: attribute?.id ?? null,
                        name: attribute?.name ?? null,
                        value_name: attribute?.value_name ?? attribute?.values?.[0]?.name ?? null
                      }))
                    : []
                }
              };
            }

            if (entry.type === "USER_PRODUCT") {
              const userProduct = await meliGet(
                env,
                `/user-products/${encodeURIComponent(String(entry.id))}`
              );
              return {
                ...base,
                detalhe: {
                  id: userProduct?.id ?? entry.id,
                  name: userProduct?.name ?? null,
                  family_name: userProduct?.family_name ?? null,
                  family_id: userProduct?.family_id ?? null,
                  domain_id: userProduct?.domain_id ?? null,
                  user_id: userProduct?.user_id ?? null,
                  catalog_product_id: userProduct?.catalog_product_id ?? null,
                  attributes: Array.isArray(userProduct?.attributes)
                    ? userProduct.attributes.map((attribute: any) => ({
                        id: attribute?.id ?? null,
                        name: attribute?.name ?? null,
                        value_name: attribute?.value_name ?? attribute?.values?.[0]?.name ?? null
                      }))
                    : []
                }
              };
            }

            return base;
          } catch (error) {
            return {
              ...base,
              detalhe: null,
              erro_detalhe: error instanceof Error ? error.message : String(error)
            };
          }
        })
      );

      return textResult({
        site_id: siteId,
        category_id,
        query_data: highlights?.query_data ?? null,
        total: results.length,
        detalhes_solicitados: detailsLimit,
        results
      });
    }
  );


  server.registerTool(
    "consultar_ads_conta",
    {
      description:
        "Consulta, somente leitura, o anunciante Product Ads da Stop Kar e valida se a integracao do Mercado Ads esta autorizada.",
      inputSchema: {}
    },
    async () => {
      const advertiser = await getProductAdsAdvertiser(env);
      const storedToken = await loadToken(env);
      const tokenScopes = String(storedToken?.scope || "")
        .split(/\s+/)
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean);

      let application: any = null;
      let applicationError: string | null = null;
      if (env.MELI_CLIENT_ID) {
        try {
          const app = await meliGet(env, `/applications/${encodeURIComponent(env.MELI_CLIENT_ID)}`);
          application = {
            id: app?.id ?? env.MELI_CLIENT_ID,
            site_id: app?.site_id ?? null,
            active: app?.active ?? null,
            sandbox_mode: app?.sandbox_mode ?? null,
            project_id: app?.project_id ?? null,
            certification_status: app?.certification_status ?? null,
            max_requests_per_hour: app?.max_requests_per_hour ?? null
          };
        } catch (error) {
          applicationError = error instanceof Error ? error.message : String(error);
        }
      }

      let grant: any = null;
      let grantError: string | null = null;
      if (storedToken?.user_id && env.MELI_CLIENT_ID) {
        try {
          const apps = await meliGet(
            env,
            `/users/${encodeURIComponent(String(storedToken.user_id))}/applications`
          );
          const rows = Array.isArray(apps) ? apps : [];
          const match = rows.find((entry: any) => String(entry?.app_id) === String(env.MELI_CLIENT_ID));
          grant = match
            ? {
                user_id: match?.user_id ?? storedToken.user_id,
                app_id: match?.app_id ?? env.MELI_CLIENT_ID,
                date_created: match?.date_created ?? null,
                scopes: Array.isArray(match?.scopes) ? match.scopes : []
              }
            : null;
        } catch (error) {
          grantError = error instanceof Error ? error.message : String(error);
        }
      }

      let trendsHealth: any = null;
      try {
        const trends = await meliGet(env, `/trends/${encodeURIComponent(advertiser.site_id)}`);
        trendsHealth = {
          ok: true,
          total: Array.isArray(trends) ? trends.length : null
        };
      } catch (error) {
        trendsHealth = {
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        };
      }

      return textResult({
        product_id: "PADS",
        advertiser_id: advertiser.advertiser_id,
        site_id: advertiser.site_id,
        advertiser_name: advertiser.advertiser_name,
        modo: adsWritesEnabled(env) ? "leitura_e_escrita_controlada" : "somente_leitura",
        escrita_ads_habilitada: adsWritesEnabled(env),
        oauth_scope: storedToken?.scope ?? null,
        oauth_tem_read: tokenScopes.includes("read"),
        oauth_tem_write: tokenScopes.includes("write"),
        oauth_tem_offline_access: tokenScopes.includes("offline_access"),
        oauth_user_id: storedToken?.user_id ?? null,
        diagnostico_write:
          tokenScopes.includes("write")
            ? "Token atual possui scope write."
            : "Token atual NAO possui scope write; reautorize a conta apos salvar as permissoes do aplicativo.",
        application,
        application_error: applicationError,
        grant,
        grant_error: grantError,
        trends_health: trendsHealth
      });
    }
  );

  server.registerTool(
    "consultar_ads_campanhas",
    {
      description:
        "Consulta campanhas Product Ads da Stop Kar com metricas de desempenho. Somente leitura. Retorna investimento, impressoes, cliques, CTR, CPC, ACOS, ROAS, vendas atribuidas, vendas organicas e outras metricas oficiais do Mercado Ads.",
      inputSchema: {
        data_inicial: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .describe("Data inicial YYYY-MM-DD. As metricas do Mercado Ads aceitam janela recente de ate 90 dias."),
        data_final: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .describe("Data final YYYY-MM-DD."),
        status: z
          .enum(["active", "paused"])
          .optional()
          .describe("Filtra campanhas ativas ou pausadas."),
        limite: z.number().int().min(1).max(100).optional().default(50),
        offset: z.number().int().min(0).optional().default(0)
      }
    },
    async ({ data_inicial, data_final, status, limite, offset }) => {
      const advertiser = await getProductAdsAdvertiser(env);
      const data = await meliGet(
        env,
        `/advertising/${encodeURIComponent(advertiser.site_id)}/advertisers/${encodeURIComponent(
          String(advertiser.advertiser_id)
        )}/product_ads/campaigns/search`,
        {
          limit: String(limite ?? 50),
          offset: String(offset ?? 0),
          date_from: data_inicial,
          date_to: data_final,
          metrics: ADS_CAMPAIGN_METRICS,
          metrics_summary: "true",
          "filters[status]": status,
          "filters[channel]": "marketplace"
        },
        { "api-version": "2" }
      );

      return textResult({
        advertiser: {
          advertiser_id: advertiser.advertiser_id,
          site_id: advertiser.site_id,
          advertiser_name: advertiser.advertiser_name
        },
        periodo: {
          data_inicial,
          data_final
        },
        paging: data?.paging ?? null,
        metrics_summary: data?.metrics_summary ?? null,
        results: Array.isArray(data?.results) ? data.results : []
      });
    }
  );

  server.registerTool(
    "consultar_ads_anuncios",
    {
      description:
        "Consulta Ad Groups/anuncios Product Ads da Stop Kar com metricas por produto. Somente leitura. Inclui investimento, cliques, impressoes, CTR, CPC, ACOS, TACOS, CVR, ROAS, vendas atribuidas e organicas.",
      inputSchema: {
        data_inicial: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .describe("Data inicial YYYY-MM-DD."),
        data_final: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .describe("Data final YYYY-MM-DD."),
        campaign_id: z
          .union([z.string().min(1), z.number().int().positive()])
          .optional()
          .describe("ID opcional de uma campanha Product Ads."),
        status: z
          .enum(["active", "paused"])
          .optional()
          .describe("Filtra Ad Groups ativos ou pausados."),
        limite: z.number().int().min(1).max(200).optional().default(50),
        offset: z.number().int().min(0).optional().default(0),
        ordenar_por: z
          .enum(["cost", "clicks", "prints", "total_amount", "roas", "acos", "tacos"])
          .optional()
          .default("cost")
      }
    },
    async ({ data_inicial, data_final, campaign_id, status, limite, offset, ordenar_por }) => {
      const advertiser = await getProductAdsAdvertiser(env);
      const data = await meliGet(
        env,
        `/advertising/${encodeURIComponent(advertiser.site_id)}/advertisers/${encodeURIComponent(
          String(advertiser.advertiser_id)
        )}/product_ads/ad_groups/search`,
        {
          date_from: data_inicial,
          date_to: data_final,
          limit: String(limite ?? 50),
          offset: String(offset ?? 0),
          sort: "desc",
          sort_by: ordenar_por || "cost",
          metrics: ADS_AD_GROUP_METRICS,
          metrics_summary: "true",
          "filters[campaigns]": campaign_id !== undefined ? String(campaign_id) : undefined,
          "filters[statuses]": status,
          "filters[channel]": "marketplace",
          sll: "false"
        },
        { "api-version": "2" }
      );

      return textResult({
        advertiser: {
          advertiser_id: advertiser.advertiser_id,
          site_id: advertiser.site_id,
          advertiser_name: advertiser.advertiser_name
        },
        periodo: {
          data_inicial,
          data_final
        },
        paging: data?.paging ?? null,
        metrics_summary: data?.metrics_summary ?? null,
        results: Array.isArray(data?.results) ? data.results : []
      });
    }
  );

  server.registerTool(
    "consultar_ads_anuncio",
    {
      description:
        "Consulta as metricas Product Ads de um anuncio especifico pelo codigo MLB. Somente leitura. Mapeia o item para o Ad Group atual e retorna investimento, vendas atribuidas, TACOS, ACOS, ROAS, cliques, impressoes, CTR, CPC e CVR.",
      inputSchema: {
        item_id: z.string().min(3).describe("Codigo MLB do anuncio, por exemplo MLB1234567890"),
        data_inicial: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .describe("Data inicial YYYY-MM-DD."),
        data_final: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .describe("Data final YYYY-MM-DD.")
      }
    },
    async ({ item_id, data_inicial, data_final }) => {
      const advertiser = await getProductAdsAdvertiser(env);
      const adGroups = await meliGet(
        env,
        `/advertising/${encodeURIComponent(advertiser.site_id)}/advertisers/${encodeURIComponent(
          String(advertiser.advertiser_id)
        )}/product_ads/ad_groups/search`,
        {
          "filters[item_ids]": item_id,
          limit: "50"
        },
        { "api-version": "2" }
      );

      const groups = Array.isArray(adGroups?.results) ? adGroups.results : [];
      const results = await Promise.all(
        groups.map(async (group: any) => {
          const metrics = await meliGet(
            env,
            `/advertising/${encodeURIComponent(advertiser.site_id)}/product_ads/ad_groups/${encodeURIComponent(
              String(group?.id)
            )}/ads`,
            {
              date_from: data_inicial,
              date_to: data_final,
              metrics: ADS_AD_GROUP_METRICS.toLowerCase()
            },
            { "api-version": "2" }
          );

          return {
            ad_group: {
              id: group?.id ?? null,
              ad_group_external_id: group?.ad_group_external_id ?? null,
              status: group?.status ?? null,
              campaign_id: group?.campaign_id ?? null,
              advertiser_id: group?.advertiser_id ?? null,
              ad_group_type: group?.ad_group_type ?? null
            },
            metrics
          };
        })
      );

      return textResult({
        item_id,
        periodo: {
          data_inicial,
          data_final
        },
        advertiser: {
          advertiser_id: advertiser.advertiser_id,
          site_id: advertiser.site_id,
          advertiser_name: advertiser.advertiser_name
        },
        ad_groups_encontrados: groups.length,
        results
      });
    }
  );


  server.registerTool(
    "atualizar_ads_campanha",
    {
      description:
        "Pre-visualiza ou altera com protecoes uma campanha Product Ads. Por padrao apenas simula; para gravar, confirmar=true, motivo e ADS_WRITES_ENABLED=true sao obrigatorios.",
      inputSchema: {
        campaign_id: z.union([z.string().min(1), z.number().int().positive()]),
        status: z.enum(["active", "paused"]).optional(),
        budget: z.number().positive().optional(),
        roas_target: z.number().positive().optional(),
        name: z.string().min(1).max(100).optional(),
        confirmar: z.boolean().optional().default(false),
        permitir_campanha_nova: z.boolean().optional().default(false),
        motivo: z.string().max(300).optional()
      }
    },
    async ({ campaign_id, status, budget, roas_target, name, confirmar, permitir_campanha_nova, motivo }) => {
      const advertiser = await getProductAdsAdvertiser(env);
      const current = await getProductAdsCampaign(env, advertiser, campaign_id);
      if (!current) {
        throw new Error(`Campanha Product Ads ${String(campaign_id)} nao encontrada.`);
      }

      const requested: Record<string, unknown> = {};
      if (status !== undefined && status !== current.status) requested.status = status;
      if (budget !== undefined && Number(budget) !== Number(current.budget)) requested.budget = Number(budget);
      if (roas_target !== undefined && Number(roas_target) !== Number(current.roas_target)) {
        requested.roas_target = Number(roas_target);
      }
      if (name !== undefined && name !== current.name) requested.name = name;

      if (Object.keys(requested).length === 0) {
        return textResult({
          acao: "nenhuma_alteracao",
          campaign_id: current.id,
          campanha: current
        });
      }

      const ageHours = campaignAgeHours(current);
      const currentBudget = Number(current.budget);
      const nextBudget = requested.budget !== undefined ? Number(requested.budget) : null;
      const currentRoas = Number(current.roas_target);
      const nextRoas = requested.roas_target !== undefined ? Number(requested.roas_target) : null;

      const alertas: string[] = [];
      if (ageHours !== null && ageHours < 24) {
        alertas.push("Campanha com menos de 24 horas; a atribuicao pode estar atrasada.");
      }

      if (
        nextBudget !== null &&
        Number.isFinite(currentBudget) &&
        currentBudget > 0 &&
        Math.abs(nextBudget - currentBudget) / currentBudget > 0.25
      ) {
        throw new Error("Protecao Stop Kar: altere o budget em etapas de no maximo 25% por operacao.");
      }

      if (
        nextRoas !== null &&
        Number.isFinite(currentRoas) &&
        currentRoas > 0 &&
        Math.abs(nextRoas - currentRoas) / currentRoas > 0.25
      ) {
        throw new Error("Protecao Stop Kar: altere o ROAS objetivo em etapas de no maximo 25% por operacao.");
      }

      const preview = {
        acao: confirmar ? "gravar" : "simulacao",
        campaign_id: current.id,
        nome: current.name,
        idade_horas: ageHours === null ? null : Number(ageHours.toFixed(2)),
        antes: {
          status: current.status,
          budget: current.budget,
          roas_target: current.roas_target,
          strategy: current.strategy
        },
        solicitado: requested,
        alertas
      };

      if (!confirmar) return textResult(preview);

      if (!motivo || motivo.trim().length < 5) {
        throw new Error("Para gravar uma alteracao de Ads, informe um motivo objetivo com pelo menos 5 caracteres.");
      }
      if (ageHours !== null && ageHours < 24 && !permitir_campanha_nova) {
        throw new Error(
          "Protecao Stop Kar: campanha com menos de 24 horas. Reenvie com permitir_campanha_nova=true somente se a mudanca for realmente intencional."
        );
      }

      requireAdsWritesEnabled(env);

      const path = `/marketplace/advertising/${encodeURIComponent(
        advertiser.site_id
      )}/product_ads/campaigns/${encodeURIComponent(String(current.id))}`;
      const write = await meliWrite(env, "PUT", path, requested, { "api-version": "2" });
      const after = await getProductAdsCampaign(env, advertiser, current.id);
      const audit_id = await recordAdsAudit(env, {
        tipo: "campaign_update",
        campaign_id: current.id,
        motivo: motivo.trim(),
        antes: current,
        solicitado: requested,
        depois: after,
        endpoint: write.path_used
      });

      return textResult({
        ...preview,
        acao: "gravado",
        audit_id,
        endpoint_utilizado: write.path_used,
        resposta_api: write.data,
        depois: after
      });
    }
  );

  server.registerTool(
    "atualizar_ads_anuncio",
    {
      description:
        "Pre-visualiza ou altera o Ad Group correspondente a um MLB: ativa/pausa ou move entre campanhas. Por padrao apenas simula e nunca grava sem confirmar=true.",
      inputSchema: {
        item_id: z.string().min(3).describe("Codigo MLB do anuncio."),
        status: z.enum(["active", "paused"]).optional(),
        campaign_id: z.union([z.string().min(1), z.number().int().positive()]).optional(),
        confirmar: z.boolean().optional().default(false),
        permitir_campanha_nova: z.boolean().optional().default(false),
        motivo: z.string().max(300).optional()
      }
    },
    async ({ item_id, status, campaign_id, confirmar, permitir_campanha_nova, motivo }) => {
      const advertiser = await getProductAdsAdvertiser(env);
      const groups = await getProductAdsAdGroupsForItem(env, advertiser, item_id);

      if (groups.length === 0) {
        throw new Error("Nenhum Ad Group Product Ads foi encontrado para esse MLB.");
      }
      if (groups.length !== 1) {
        return textResult({
          acao: "bloqueado_por_ambiguidade",
          item_id,
          mensagem:
            "Mais de um Ad Group foi encontrado. Nenhuma alteracao foi feita para evitar atingir a familia/variante errada.",
          ad_groups: groups.map((group: any) => ({
            id: group?.id ?? null,
            campaign_id: group?.campaign_id ?? null,
            status: group?.status ?? null,
            ad_group_type: group?.ad_group_type ?? null,
            ad_group_external_id: group?.ad_group_external_id ?? null
          }))
        });
      }

      const current = groups[0];
      const requested: Record<string, unknown> = {};
      if (status !== undefined && String(status).toLowerCase() !== String(current?.status || "").toLowerCase()) {
        requested.status = status;
      }
      if (campaign_id !== undefined && String(campaign_id) !== String(current?.campaign_id)) {
        requested.campaign_id = Number(campaign_id);
      }

      if (Object.keys(requested).length === 0) {
        return textResult({
          acao: "nenhuma_alteracao",
          item_id,
          ad_group_id: current?.id ?? null,
          ad_group: current
        });
      }

      let targetCampaign: any = null;
      let targetAgeHours: number | null = null;
      if (requested.campaign_id !== undefined) {
        targetCampaign = await getProductAdsCampaign(env, advertiser, Number(requested.campaign_id));
        if (!targetCampaign) {
          throw new Error("Campanha de destino nao encontrada.");
        }
        targetAgeHours = campaignAgeHours(targetCampaign);
      }

      const preview = {
        acao: confirmar ? "gravar" : "simulacao",
        item_id,
        ad_group_id: current?.id ?? null,
        antes: {
          status: current?.status ?? null,
          campaign_id: current?.campaign_id ?? null,
          ad_group_type: current?.ad_group_type ?? null,
          ad_group_external_id: current?.ad_group_external_id ?? null
        },
        solicitado: requested,
        campanha_destino: targetCampaign
          ? {
              id: targetCampaign.id,
              name: targetCampaign.name,
              status: targetCampaign.status,
              idade_horas:
                targetAgeHours === null ? null : Number(targetAgeHours.toFixed(2))
            }
          : null
      };

      if (!confirmar) return textResult(preview);

      if (!motivo || motivo.trim().length < 5) {
        throw new Error("Para gravar uma alteracao de Ads, informe um motivo objetivo com pelo menos 5 caracteres.");
      }
      if (targetAgeHours !== null && targetAgeHours < 24 && !permitir_campanha_nova) {
        throw new Error(
          "Protecao Stop Kar: a campanha de destino tem menos de 24 horas. Reenvie com permitir_campanha_nova=true somente se a mudanca for realmente intencional."
        );
      }

      requireAdsWritesEnabled(env);

      const path = `/marketplace/advertising/${encodeURIComponent(
        advertiser.site_id
      )}/product_ads/ad_groups/${encodeURIComponent(String(current.id))}`;
      const write = await meliWrite(env, "PUT", path, requested, { "api-version": "2" });
      const afterGroups = await getProductAdsAdGroupsForItem(env, advertiser, item_id);
      const after =
        afterGroups.find((group: any) => String(group?.id) === String(current?.id)) ?? afterGroups[0] ?? null;
      const audit_id = await recordAdsAudit(env, {
        tipo: "ad_group_update",
        item_id,
        ad_group_id: current?.id ?? null,
        motivo: motivo.trim(),
        antes: current,
        solicitado: requested,
        depois: after,
        endpoint: write.path_used
      });

      return textResult({
        ...preview,
        acao: "gravado",
        audit_id,
        endpoint_utilizado: write.path_used,
        resposta_api: write.data,
        depois: after
      });
    }
  );

  server.registerTool(
    "consultar_ads_auditoria",
    {
      description:
        "Lista as alteracoes de Product Ads gravadas pela integracao Stop Kar nos ultimos 180 dias.",
      inputSchema: {
        limite: z.number().int().min(1).max(50).optional().default(20)
      }
    },
    async ({ limite }) => {
      if (!env.MELI_TOKENS) {
        throw new Error("KV MELI_TOKENS nao configurado.");
      }
      const listed = await env.MELI_TOKENS.list({ prefix: "ads:audit:", limit: Number(limite ?? 20) });
      const ordered = [...listed.keys].sort((a, b) => b.name.localeCompare(a.name));
      const results = (
        await Promise.all(
          ordered.map(async (entry) => {
            const value = await env.MELI_TOKENS!.get(entry.name, "json");
            return value;
          })
        )
      ).filter(Boolean);

      return textResult({
        escrita_ads_habilitada: adsWritesEnabled(env),
        total_retornado: results.length,
        results
      });
    }
  );

  return server;
}

function html(message: string, status = 200) {
  return new Response(
    `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Stop Kar Mercado Livre</title></head><body style="font-family:Arial,sans-serif;max-width:680px;margin:60px auto;padding:24px"><h1>Stop Kar Mercado Livre</h1><p>${message}</p></body></html>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8" } }
  );
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      let connected = false;
      let userId: number | undefined;
      try {
        const token = await loadToken(env);
        connected = Boolean(token?.access_token);
        userId = token?.user_id;
      } catch {
        connected = false;
      }

      return Response.json({
        ok: true,
        service: "Stop Kar Mercado Livre",
        version: SERVER_VERSION,
        mercadolivre_connected: connected,
        user_id: userId
      });
    }

    if (url.pathname === "/oauth/start") {
      try {
        const { clientId, redirectUri, tokens } = requireOAuthConfig(env);
        const state = crypto.randomUUID();
        await tokens.put(`oauth:state:${state}`, "1", { expirationTtl: 600 });

        const authorizeUrl = new URL(MELI_AUTH);
        authorizeUrl.searchParams.set("response_type", "code");
        authorizeUrl.searchParams.set("client_id", clientId);
        authorizeUrl.searchParams.set("redirect_uri", redirectUri);
        authorizeUrl.searchParams.set("state", state);

        return Response.redirect(authorizeUrl.toString(), 302);
      } catch (error) {
        return html(error instanceof Error ? error.message : "Falha ao iniciar OAuth.", 500);
      }
    }

    if (url.pathname === "/oauth/callback") {
      try {
        const { redirectUri, tokens } = requireOAuthConfig(env);
        const error = url.searchParams.get("error");
        if (error) {
          return html(`O Mercado Livre recusou a autorizacao: ${error}`, 400);
        }

        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");
        if (!code || !state) {
          return html("Callback sem code/state. Inicie novamente em /oauth/start.", 400);
        }

        const stateKey = `oauth:state:${state}`;
        const validState = await tokens.get(stateKey);
        if (!validState) {
          return html("Estado OAuth invalido ou expirado. Inicie novamente em /oauth/start.", 400);
        }
        await tokens.delete(stateKey);

        const data = await postToken(env, {
          grant_type: "authorization_code",
          code,
          redirect_uri: redirectUri
        });
        const stored = await saveTokenResponse(env, data);

        return html(
          `Conta autorizada com sucesso${stored.user_id ? ` (usuario ${stored.user_id})` : ""}. Os tokens foram guardados com seguranca na Cloudflare. Voce pode fechar esta aba.`
        );
      } catch (error) {
        return html(error instanceof Error ? error.message : "Falha ao concluir OAuth.", 500);
      }
    }

    if (url.pathname === "/oauth/status") {
      try {
        const token = await loadToken(env);
        return Response.json({
          connected: Boolean(token?.access_token),
          user_id: token?.user_id,
          expires_at: token?.expires_at
        });
      } catch {
        return Response.json({ connected: false });
      }
    }

    if (url.pathname === "/notifications") {
      if (request.method === "GET") {
        return Response.json({ ok: true, endpoint: "mercadolivre-notifications" });
      }

      if (request.method !== "POST") {
        return new Response("Method not allowed", { status: 405 });
      }

      try {
        const payload = await request.json<any>();
        console.log("Mercado Livre notification", {
          topic: payload?.topic,
          resource: payload?.resource,
          user_id: payload?.user_id,
          application_id: payload?.application_id,
          sent: payload?.sent
        });
      } catch {
        console.log("Mercado Livre notification received without JSON body");
      }

      return new Response(null, { status: 200 });
    }

    if (url.pathname === "/mcp" && env.MCP_SHARED_SECRET) {
      const authorization = request.headers.get("authorization");
      if (authorization !== `Bearer ${env.MCP_SHARED_SECRET}`) {
        return new Response("Unauthorized", { status: 401 });
      }
    }

    if (url.pathname === "/mcp") {
      return createMcpHandler(() => createServer(env))(request, env, ctx);
    }

    return new Response("Not found", { status: 404 });
  }
} satisfies ExportedHandler<Env>;

