import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

/**
 * Vínculos de Loja Oficial: exclusivamente remover associação dos MLBs da
 * Stop Kar que NÃO são da Universal Automotive Systems. Não altera marca,
 * título, preço, status, estoque, anúncios ou catálogo.
 *
 * A API do Mercado Livre documenta PUT /items/:id com official_store_id;
 * a possibilidade de enviar null depende da conta/categoria. Nunca declarar
 * sucesso sem uma leitura posterior confirmando official_store_id === null.
 */
type Read = (path: string, params?: Record<string, string | undefined>) => Promise<any>;
type Write = (path: string, body: unknown) => Promise<{ data: any; path_used: string }>;
type Audit = (prefix: string, entry: Record<string, unknown>) => Promise<string | null>;
type Dependencies = {
  read: Read;
  write: Write;
  requireWritesEnabled: () => void;
  audit: Audit;
};

const MLB = /^MLB\d{5,20}$/;
const OFFICIAL_NAME = "universal automotive systems";
const textResult = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }]
});

function normalize(value: unknown): string {
  return typeof value === "string"
    ? value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().replace(/\s+/g, " ").toLowerCase()
    : "";
}
function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
function safeStoreId(value: unknown): string | null {
  const id = String(value ?? "");
  return /^\d{1,20}$/.test(id) && id !== "0" ? id : null;
}
export function brandFromItem(item: any): string | null {
  const attrs = Array.isArray(item?.attributes) ? item.attributes : [];
  const attr = attrs.find((a: any) => a?.id === "BRAND");
  return stringValue(attr?.value_name) || stringValue(attr?.values?.[0]?.name);
}
function storeName(entry: any): string | null {
  return stringValue(entry?.name) || stringValue(entry?.fantasy_name);
}
function isUniversalStore(entry: any): boolean {
  const names = [entry?.name, entry?.fantasy_name, entry?.brand_registry?.brand_name];
  return names.some((name) => normalize(name) === OFFICIAL_NAME);
}

/** Deterministic classifier; unknown brand, owner or store means no write. */
export function inspectOfficialStoreLink(item: any, sellerId: string, brands: any[]) {
  const itemId = stringValue(item?.id);
  const ownerId = String(item?.seller_id ?? "");
  const id = safeStoreId(item?.official_store_id);
  const fichaBrand = brandFromItem(item);
  const linked = brands.find((entry: any) => safeStoreId(entry?.official_store_id) === id);
  const isTargetStore = Boolean(linked && isUniversalStore(linked));
  let situacao = "candidato_desvinculacao";
  if (!itemId || !MLB.test(itemId) || ownerId !== sellerId) situacao = "bloqueado_conta_diferente";
  else if (!id) situacao = "sem_vinculo_loja_oficial";
  else if (!linked) situacao = "bloqueado_loja_nao_identificada";
  else if (!isTargetStore) situacao = "fora_loja_universal";
  else if (!fichaBrand) situacao = "bloqueado_marca_ausente";
  else if (normalize(fichaBrand) === OFFICIAL_NAME) situacao = "protegido_produto_universal";
  else if (normalize(fichaBrand).includes("universal")) situacao = "bloqueado_marca_ambigua";

  return {
    item_id: itemId,
    titulo: stringValue(item?.title),
    user_product_id: stringValue(item?.user_product_id),
    status_anuncio: stringValue(item?.status),
    preco: typeof item?.price === "number" ? item.price : null,
    estoque: typeof item?.available_quantity === "number" ? item.available_quantity : null,
    marca_ficha: fichaBrand,
    loja_oficial_id: id,
    loja_oficial_nome: storeName(linked),
    situacao,
    elegivel: situacao === "candidato_desvinculacao"
  };
}

function ensureSnapshotMatches(
  oldSnapshot: ReturnType<typeof inspectOfficialStoreLink>,
  current: ReturnType<typeof inspectOfficialStoreLink>,
  expectedBrand: string | undefined,
  expectedStoreId: string | undefined
) {
  if (!oldSnapshot.elegivel || !current.elegivel) {
    throw new Error("Anuncio sem elegibilidade confirmada. Nenhuma alteracao foi feita.");
  }
  if (!expectedBrand || !expectedStoreId) {
    throw new Error("Confirme a marca e o ID da Loja Oficial retornados na simulacao.");
  }
  if (expectedBrand !== oldSnapshot.marca_ficha || expectedStoreId !== oldSnapshot.loja_oficial_id) {
    throw new Error("Marca/Loja Oficial confirmadas nao correspondem a simulacao. Nenhuma alteracao.");
  }
  if (
    current.item_id !== oldSnapshot.item_id ||
    current.marca_ficha !== oldSnapshot.marca_ficha ||
    current.loja_oficial_id !== oldSnapshot.loja_oficial_id ||
    current.user_product_id !== oldSnapshot.user_product_id
  ) {
    throw new Error("Marca, anuncio ou vinculacao mudou desde a simulacao. Nenhuma alteracao.");
  }
}

async function readSellerAndBrands(read: Read) {
  const me = await read("/users/me");
  const sellerId = safeStoreId(me?.id);
  if (!sellerId) throw new Error("Nao foi possivel identificar a conta Mercado Livre autorizada.");
  const associations = await read("/users/" + sellerId + "/brands");
  if (!Array.isArray(associations?.brands)) {
    throw new Error("O Mercado Livre nao retornou a relacao de Lojas Oficiais. Escrita bloqueada.");
  }
  return { sellerId, brands: associations.brands as any[] };
}

async function readItem(read: Read, itemId: string) {
  return read("/items/" + itemId, { include_attributes: "all" });
}

export function registerOfficialStoreTools(server: McpServer, deps: Dependencies) {
  server.registerTool(
    "auditar_loja_oficial_universal",
    {
      description:
        "Audita ate 10 MLBs da Stop Kar: consulta o ID da Loja Oficial e a marca real da ficha tecnica. Identifica quais anuncios de outras marcas estao vinculados a Loja Oficial da Universal. Somente leitura, sem alteracoes.",
      inputSchema: {
        item_ids: z.array(z.string().regex(MLB)).min(1).max(10)
      }
    },
    async ({ item_ids }) => {
      const { sellerId, brands } = await readSellerAndBrands(deps.read);
      const uniqueIds = [...new Set(item_ids)];
      const results = await Promise.all(uniqueIds.map(async (id) => {
        try {
          const item = await readItem(deps.read, id);
          return inspectOfficialStoreLink(item, sellerId, brands);
        } catch (error) {
          return {
            item_id: id,
            situacao: "erro_consulta",
            elegivel: false,
            erro: error instanceof Error ? error.message : String(error)
          };
        }
      }));
      return textResult({
        somente_leitura: true,
        conta_vendedora: sellerId,
        analisados: results.length,
        candidatos_confirmados: results.filter((r) => r.elegivel).length,
        erros: results.filter((r) => r.situacao === "erro_consulta").length,
        observacao: "Os candidatos apenas serao removidos por ferramenta separada, apos aprovacao por MLB.",
        results
      });
    }
  );

  server.registerTool(
    "desvincular_anuncio_loja_oficial_universal",
    {
      description:
        "Simula ou desvincula UM MLB de marca nao Universal da Loja Oficial Universal Automotive Systems. Exige marca e ID da loja confirmados, motivo, confirmacao explicita e escrita habilitada. PUT official_store_id=null, com conferencia depois. Nunca pausa ou exclui anuncio. Pode ser bloqueado pela API do Mercado Livre.",
      inputSchema: {
        item_id: z.string().regex(MLB),
        confirmar: z.boolean().optional().default(false),
        marca_esperada: z.string().min(1).max(255).optional(),
        loja_oficial_id_esperada: z.string().regex(/^\d{1,20}$/).optional(),
        motivo: z.string().min(10).max(300).optional()
      }
    },
    async ({ item_id, confirmar, marca_esperada, loja_oficial_id_esperada, motivo }) => {
      const { sellerId, brands } = await readSellerAndBrands(deps.read);
      const item = await readItem(deps.read, item_id);
      const before = inspectOfficialStoreLink(item, sellerId, brands);
      const preview = {
        item_id,
        antes: before,
        operacao: "desvincular_apenas_loja_oficial",
        payload_proposto: { official_store_id: null },
        altera_preco_estoque_titulo_status: false
      };

      if (!before.elegivel) {
        return textResult({
          ...preview,
          acao: "bloqueado",
          alterou: false,
          mensagem: "Este anuncio nao esta comprovadamente vinculado a Universal com marca de outro fabricante."
        });
      }
      if (!confirmar) {
        return textResult({
          ...preview,
          acao: "simulacao",
          alterou: false,
          para_confirmar: {
            item_id,
            confirmar: true,
            marca_esperada: before.marca_ficha,
            loja_oficial_id_esperada: before.loja_oficial_id,
            motivo: "Desvincular marca nao Universal da Loja Oficial Universal Automotive Systems"
          }
        });
      }
      if (!motivo || motivo.trim().length < 10) {
        throw new Error("Para gravar, informe motivo com ao menos 10 caracteres.");
      }
      deps.requireWritesEnabled();
      const latestItem = await readItem(deps.read, item_id);
      const latest = inspectOfficialStoreLink(latestItem, sellerId, brands);
      ensureSnapshotMatches(before, latest, marca_esperada, loja_oficial_id_esperada);

      let write: { data: any; path_used: string } | null = null;
      let writeError: string | null = null;
      try {
        write = await deps.write("/items/" + item_id, { official_store_id: null });
      } catch (error) {
        writeError = error instanceof Error ? error.message : String(error);
      }

      // Even a network error can happen after the server received the PUT.
      // Never assert failure or success before a fresh GET.
      let afterRaw: any = null;
      let readError: string | null = null;
      try {
        afterRaw = await readItem(deps.read, item_id);
      } catch (error) {
        readError = error instanceof Error ? error.message : String(error);
      }
      const after = afterRaw ? inspectOfficialStoreLink(afterRaw, sellerId, brands) : null;
      const detached = Boolean(after && after.loja_oficial_id === null);
      const keyFieldsPreserved = Boolean(after &&
        after.status_anuncio === before.status_anuncio &&
        after.preco === before.preco &&
        after.estoque === before.estoque &&
        after.marca_ficha === before.marca_ficha);
      const success = detached && keyFieldsPreserved;
      const auditEntry = {
        tipo: "desvinculacao_loja_universal",
        item_id,
        motivo: motivo.trim(),
        seller_id: sellerId,
        antes: before,
        depois: after,
        payload: { official_store_id: null },
        resposta_erro: writeError,
        erro_verificacao: readError,
        confirmado: success,
        endpoint: write?.path_used ?? null
      };
      let auditId: string | null = null;
      try {
        auditId = await deps.audit("official-store-unlink", auditEntry);
      } catch {
        // O resultado da leitura pos-gravacao continua sendo a fonte de verdade.
      }
      return textResult({
        ...preview,
        acao: success ? "desvinculado_confirmado" : (readError ? "resultado_nao_verificado" : "nao_desvinculado_ou_divergencia"),
        sucesso_confirmado: success,
        vinculo_removido: detached,
        campos_principais_preservados: keyFieldsPreserved,
        audit_id: auditId,
        erro_api: writeError,
        erro_verificacao: readError,
        depois: after,
        proxima_acao: success ? "nenhuma" :
          "Nao repetir automaticamente. Conferir status no Mercado Livre e, se a API rejeitar null, solicitar suporte da plataforma."
      });
    }
  );
}
