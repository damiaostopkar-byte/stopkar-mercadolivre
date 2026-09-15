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

async function postToken(
  env: Env,
  params: Record<string, string>
): Promise<any> {
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
    // Caso duas requisicoes tentem renovar ao mesmo tempo, outra pode ter
    // gravado o novo refresh token. Releia o armazenamento antes de falhar.
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
  params: Record<string, string | undefined> = {}
): Promise<any> {
  const url = new URL(path, MELI_API);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") {
      url.searchParams.set(key, value);
    }
  }

  let accessToken = await getAccessToken(env);
  let response = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json"
    }
  });

  if (response.status === 401) {
    accessToken = (await refreshToken(env)).access_token;
    response = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json"
      }
    });
  }

  const data = await parseApiResponse(response);

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
    version: "0.2.0"
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
        version: "0.2.0",
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
