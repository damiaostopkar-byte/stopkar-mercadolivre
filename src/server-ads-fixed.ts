import originalWorker from "./server";

interface Env {
  MELI_CLIENT_ID?: string;
  MELI_CLIENT_SECRET?: string;
  MELI_REDIRECT_URI?: string;
  MCP_SHARED_SECRET?: string;
  MELI_TOKENS?: KVNamespace;
  ADS_WRITES_ENABLED?: string;
}

type StoredToken = {
  access_token: string;
  refresh_token: string;
  token_type: string;
  scope?: string;
  user_id?: number;
  expires_at: number;
};

type MeliWriteMethod = "POST" | "PUT" | "DELETE";

const MELI_API = "https://api.mercadolibre.com";
const TOKEN_KEY = "mercadolivre:oauth:tokens";
const SAO_PAULO_TZ = "America/Sao_Paulo";

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

function rpcResult(id: unknown, result: unknown) {
  return Response.json({ jsonrpc: "2.0", id, result });
}

function rpcError(id: unknown, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return Response.json({ jsonrpc: "2.0", id, error: { code: -32000, message } }, { status: 200 });
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
  const body = new URLSearchParams({ client_id: clientId, client_secret: clientSecret, ...params });
  const response = await fetch(`${MELI_API}/oauth/token`, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body
  });
  const data = await parseApiResponse(response);
  if (!response.ok) {
    const message = data && typeof data === "object" ? data.message || data.error || JSON.stringify(data) : String(data);
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
  const data = await postToken(env, { grant_type: "refresh_token", refresh_token: current.refresh_token });
  return saveTokenResponse(env, data);
}

async function getAccessToken(env: Env): Promise<string> {
  const token = await loadToken(env);
  if (!token?.access_token) {
    throw new Error("Mercado Livre ainda nao autorizado. Abra /oauth/start para conectar a conta.");
  }
  if (token.expires_at <= Date.now() + 60_000) return (await refreshToken(env)).access_token;
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

async function meliGet(env: Env, path: string, params: Record<string, string | undefined> = {}, extraHeaders: Record<string, string> = {}) {
  const url = new URL(path, MELI_API);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") url.searchParams.set(key, value);
  }
  let accessToken = await getAccessToken(env);
  const send = (token: string) => fetch(url.toString(), { headers: { Authorization: `Bearer ${token}`, Accept: "application/json", ...extraHeaders } });
  let response = await send(accessToken);
  if (response.status === 401) response = await send((await refreshToken(env)).access_token);
  const data = await parseApiResponse(response);
  if (!response.ok && response.status !== 204) {
    const message = data && typeof data === "object" ? data.message || data.error || JSON.stringify(data) : String(data);
    throw new Error(`Mercado Livre API ${response.status}: ${message}`);
  }
  return data;
}

async function meliWrite(env: Env, method: MeliWriteMethod, path: string, body?: unknown, extraHeaders: Record<string, string> = {}) {
  const url = new URL(path, MELI_API);
  let accessToken = await getAccessToken(env);
  const send = (token: string) => fetch(url.toString(), {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...extraHeaders
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  let response = await send(accessToken);
  if (response.status === 401) response = await send((await refreshToken(env)).access_token);
  const data = await parseApiResponse(response);
  if (!response.ok && response.status !== 204) {
    const message = data && typeof data === "object"
      ? [data.message || data.error || "erro_sem_mensagem", Array.isArray(data.cause) && data.cause.length ? JSON.stringify(data.cause) : null].filter(Boolean).join(" | causes: ")
      : String(data);
    throw new Error(`Falha de escrita Product Ads. ${response.status} ${url.pathname} -> ${message}`);
  }
  return { data, path_used: url.pathname + url.search };
}

function adsWritesEnabled(env: Env) {
  return String(env.ADS_WRITES_ENABLED || "").toLowerCase() === "true";
}

function requireAdsWritesEnabled(env: Env) {
  if (!adsWritesEnabled(env)) {
    throw new Error("A escrita de Product Ads esta bloqueada pelo servidor. Defina ADS_WRITES_ENABLED=true antes de gravar.");
  }
}

function campaignAgeHours(campaign: any) {
  if (!campaign?.date_created) return null;
  const created = new Date(campaign.date_created).getTime();
  if (!Number.isFinite(created)) return null;
  return Math.max(0, (Date.now() - created) / 3_600_000);
}

async function getProductAdsAdvertiser(env: Env) {
  const data = await meliGet(env, "/advertising/advertisers", { product_id: "PADS" }, { "Api-Version": "1" });
  const advertisers = Array.isArray(data?.advertisers) ? data.advertisers : [];
  if (advertisers.length === 0) throw new Error("A conta autorizada nao retornou advertiser de Product Ads (PADS).");
  const me = await meliGet(env, "/users/me");
  const sellerSiteId = String(me?.site_id || "MLB");
  const advertiser = advertisers.find((entry: any) => String(entry?.site_id || "") === sellerSiteId) || advertisers[0];
  return {
    advertiser_id: advertiser?.advertiser_id,
    site_id: String(advertiser?.site_id || sellerSiteId),
    advertiser_name: advertiser?.advertiser_name ?? null
  };
}

async function getProductAdsCampaign(env: Env, advertiser: any, campaignId: string | number) {
  const data = await meliGet(
    env,
    `/marketplace/advertising/${encodeURIComponent(advertiser.site_id)}/advertisers/${encodeURIComponent(String(advertiser.advertiser_id))}/product_ads/campaigns/search`,
    { "filters[campaign_ids]": String(campaignId), limit: "20" },
    { "api-version": "2" }
  );
  const rows = Array.isArray(data?.results) ? data.results : [];
  return rows.find((row: any) => String(row?.id) === String(campaignId)) ?? null;
}

async function getProductAdsAdGroupsForItem(env: Env, advertiser: any, itemId: string) {
  const data = await meliGet(
    env,
    `/marketplace/advertising/${encodeURIComponent(advertiser.site_id)}/advertisers/${encodeURIComponent(String(advertiser.advertiser_id))}/product_ads/ad_groups/search`,
    { "filters[item_ids]": itemId, limit: "50" },
    { "api-version": "2" }
  );
  return Array.isArray(data?.results) ? data.results : [];
}

async function recordAdsAudit(env: Env, entry: Record<string, unknown>) {
  if (!env.MELI_TOKENS) return null;
  const timestamp = new Date().toISOString();
  const id = crypto.randomUUID();
  await env.MELI_TOKENS.put(`ads:audit:${timestamp}:${id}`, JSON.stringify({ id, timestamp, ...entry }), { expirationTtl: 60 * 60 * 24 * 180 });
  return id;
}

async function atualizarAdsAnuncioFixed(env: Env, args: any) {
  const { item_id, status, campaign_id, confirmar, permitir_campanha_nova, motivo } = args ?? {};
  const advertiser = await getProductAdsAdvertiser(env);
  const groups = await getProductAdsAdGroupsForItem(env, advertiser, String(item_id));

  if (groups.length === 0) throw new Error("Nenhum Ad Group Product Ads foi encontrado para esse MLB.");
  if (groups.length !== 1) {
    return textResult({
      acao: "bloqueado_por_ambiguidade",
      item_id,
      mensagem: "Mais de um Ad Group foi encontrado. Nenhuma alteracao foi feita para evitar atingir a familia/variante errada.",
      ad_groups: groups.map((group: any) => ({ id: group?.id ?? null, campaign_id: group?.campaign_id ?? null, status: group?.status ?? null, ad_group_type: group?.ad_group_type ?? null, ad_group_external_id: group?.ad_group_external_id ?? null }))
    });
  }

  const current = groups[0];
  const requested: Record<string, unknown> = {};
  if (status !== undefined && String(status).toLowerCase() !== String(current?.status || "").toLowerCase()) requested.status = status;
  if (campaign_id !== undefined && String(campaign_id) !== String(current?.campaign_id)) requested.campaign_id = Number(campaign_id);

  if (Object.keys(requested).length === 0) return textResult({ acao: "nenhuma_alteracao", item_id, ad_group_id: current?.id ?? null, ad_group: current });

  let targetCampaign: any = null;
  let targetAgeHours: number | null = null;
  if (requested.campaign_id !== undefined) {
    targetCampaign = await getProductAdsCampaign(env, advertiser, Number(requested.campaign_id));
    if (!targetCampaign) throw new Error("Campanha de destino nao encontrada.");
    targetAgeHours = campaignAgeHours(targetCampaign);
  }

  const preview = {
    acao: confirmar ? "gravar" : "simulacao",
    item_id,
    ad_group_id: current?.id ?? null,
    antes: { status: current?.status ?? null, campaign_id: current?.campaign_id ?? null, ad_group_type: current?.ad_group_type ?? null, ad_group_external_id: current?.ad_group_external_id ?? null },
    solicitado: requested,
    campanha_destino: targetCampaign ? { id: targetCampaign.id, name: targetCampaign.name, status: targetCampaign.status, idade_horas: targetAgeHours === null ? null : Number(targetAgeHours.toFixed(2)) } : null,
    endpoint_corrigido: "bulk_ad_groups_com_advertiser_id"
  };

  if (!confirmar) return textResult(preview);
  if (!motivo || motivo.trim().length < 5) throw new Error("Para gravar uma alteracao de Ads, informe um motivo objetivo com pelo menos 5 caracteres.");
  if (targetAgeHours !== null && targetAgeHours < 24 && !permitir_campanha_nova) {
    throw new Error("Protecao Stop Kar: a campanha de destino tem menos de 24 horas. Reenvie com permitir_campanha_nova=true somente se a mudanca for realmente intencional.");
  }

  requireAdsWritesEnabled(env);
  const adGroupId = Number(current.id);
  if (!Number.isFinite(adGroupId) || adGroupId <= 0) throw new Error("Ad Group ID invalido para escrita em lote.");

  const body = { ad_groups: [adGroupId], ...requested };
  const path = `/marketplace/advertising/${encodeURIComponent(advertiser.site_id)}/advertisers/${encodeURIComponent(String(advertiser.advertiser_id))}/product_ads/ad_groups`;
  const write = await meliWrite(env, "PUT", path, body, { "api-version": "2" });
  const afterGroups = await getProductAdsAdGroupsForItem(env, advertiser, String(item_id));
  const after = afterGroups.find((group: any) => String(group?.id) === String(current?.id)) ?? afterGroups[0] ?? null;
  const audit_id = await recordAdsAudit(env, { tipo: "ad_group_update_bulk_fixed", item_id, ad_group_id: current?.id ?? null, motivo: motivo.trim(), antes: current, solicitado: body, depois: after, endpoint: write.path_used });

  return textResult({ ...preview, acao: "gravado", audit_id, endpoint_utilizado: write.path_used, resposta_api: write.data, depois: after });
}

async function interceptMcpToolCall(request: Request, env: Env): Promise<Response | null> {
  if (request.method !== "POST") return null;
  let payload: any = null;
  try {
    payload = await request.clone().json();
  } catch {
    return null;
  }
  if (Array.isArray(payload)) return null;
  const method = String(payload?.method ?? "");
  const name = String(payload?.params?.name ?? "");
  const args = payload?.params?.arguments ?? {};
  if (method !== "tools/call" || name !== "atualizar_ads_anuncio") return null;

  try {
    const result = await atualizarAdsAnuncioFixed(env, args);
    return rpcResult(payload?.id ?? null, result);
  } catch (error) {
    return rpcError(payload?.id ?? null, error);
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/mcp") {
      const intercepted = await interceptMcpToolCall(request, env);
      if (intercepted) return intercepted;
    }
    return originalWorker.fetch(request, env, ctx);
  }
} satisfies ExportedHandler<Env>;
