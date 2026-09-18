import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";

interface Env {
  MELI_CLIENT_ID?: string;
  MELI_CLIENT_SECRET?: string;
  MELI_REDIRECT_URI?: string;
  MCP_SHARED_SECRET?: string;
  MELI_TOKENS?: KVNamespace;
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
const SERVER_VERSION = "0.7.0";

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
        "Busca um anuncio da Stop Kar pelo codigo MLB e retorna preco, estoque, vendas, SKU, codigo personalizado, status, logistica e variacoes.",
      inputSchema: {
        item_id: z.string().min(3).describe("Codigo do anuncio, por exemplo MLB1234567890")
      }
    },
    async ({ item_id }) => {
      const item = await meliGet(env, `/items/${encodeURIComponent(item_id)}`, {
        include_attributes: "all"
      });
      return textResult(compactItem(item));
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
        "Consulta as tendencias semanais de busca do Mercado Livre para o Brasil, opcionalmente filtradas por categoria. Retorna ate 50 termos com a posicao e o grupo de tendencia documentado pelo Mercado Livre.",
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
          .describe("Filtro local opcional para retornar apenas tendencias que contenham este termo.")
      }
    },
    async ({ category_id, termo }) => {
      const me = await meliGet(env, "/users/me");
      const siteId = String(me?.site_id || "MLB");
      const path = category_id
        ? `/trends/${encodeURIComponent(siteId)}/${encodeURIComponent(category_id)}`
        : `/trends/${encodeURIComponent(siteId)}`;
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
