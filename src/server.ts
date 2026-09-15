import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";

interface Env {
  MELI_ACCESS_TOKEN?: string;
  MCP_SHARED_SECRET?: string;
}

const MELI_API = "https://api.mercadolibre.com";

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

function getAccessToken(env: Env): string {
  if (!env.MELI_ACCESS_TOKEN) {
    throw new Error(
      "Mercado Livre ainda nao autorizado. Configure MELI_ACCESS_TOKEN como secret na Cloudflare."
    );
  }
  return env.MELI_ACCESS_TOKEN;
}

async function meliGet(
  env: Env,
  path: string,
  params: Record<string, string | undefined> = {}
): Promise<any> {
  const url = new URL(path, MELI_API);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") {
      url.searchParams.set(key, value);
    }
  }

  const response = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${getAccessToken(env)}`,
      Accept: "application/json"
    }
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
    throw new Error(`Mercado Livre API ${response.status}: ${message}`);
  }

  return data;
}

function compactItem(item: any) {
  return {
    id: item.id,
    title: item.title,
    status: item.status,
    sub_status: item.sub_status,
    price: item.price,
    base_price: item.base_price,
    original_price: item.original_price,
    currency_id: item.currency_id,
    available_quantity: item.available_quantity,
    sold_quantity: item.sold_quantity,
    listing_type_id: item.listing_type_id,
    seller_custom_field: item.seller_custom_field,
    inventory_id: item.inventory_id,
    permalink: item.permalink,
    logistic_type: item.shipping?.logistic_type,
    free_shipping: item.shipping?.free_shipping,
    variations: Array.isArray(item.variations)
      ? item.variations.map((variation: any) => ({
          id: variation.id,
          price: variation.price,
          available_quantity: variation.available_quantity,
          sold_quantity: variation.sold_quantity,
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

function createServer(env: Env) {
  const server = new McpServer({
    name: "Stop Kar Mercado Livre",
    version: "0.1.0"
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
        "Busca um anuncio da Stop Kar pelo codigo MLB e retorna preco, estoque, vendas, status, logistica e variacoes.",
      inputSchema: {
        item_id: z
          .string()
          .min(3)
          .describe("Codigo do anuncio, por exemplo MLB1234567890")
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
      description:
        "Consulta o preco atual de um anuncio Mercado Livre da Stop Kar.",
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
        "Consulta pedidos/vendas da conta Mercado Livre da Stop Kar. Pode filtrar por periodo e status. Nao retorna dados pessoais do comprador.",
      inputSchema: {
        data_inicial: z
          .string()
          .optional()
          .describe("Data/hora ISO inicial, por exemplo 2026-09-01T00:00:00-03:00"),
        data_final: z
          .string()
          .optional()
          .describe("Data/hora ISO final, por exemplo 2026-09-15T23:59:59-03:00"),
        status: z
          .string()
          .optional()
          .describe("Status do pedido, por exemplo paid ou cancelled"),
        limite: z.number().int().min(1).max(50).optional().default(20)
      }
    },
    async ({ data_inicial, data_final, status, limite }) => {
      const me = await meliGet(env, "/users/me");
      const orders = await meliGet(env, "/orders/search", {
        seller: String(me.id),
        "order.date_created.from": data_inicial,
        "order.date_created.to": data_final,
        "order.status": status,
        sort: "date_desc",
        limit: String(limite ?? 20),
        offset: "0"
      });

      const results = Array.isArray(orders.results)
        ? orders.results.map((order: any) => ({
            id: order.id,
            status: order.status,
            date_created: order.date_created,
            date_closed: order.date_closed,
            total_amount: order.total_amount,
            paid_amount: order.paid_amount,
            currency_id: order.currency_id,
            pack_id: order.pack_id,
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
          }))
        : [];

      return textResult({
        paging: orders.paging,
        results
      });
    }
  );

  return server;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return Response.json({
        ok: true,
        service: "Stop Kar Mercado Livre",
        version: "0.1.0"
      });
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
