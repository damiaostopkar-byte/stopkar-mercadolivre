import { z } from "zod";

/**
 * Correcao de peso e dimensoes declaradas da embalagem (ME2).
 * Esta operacao nao altera medidas aferidas/administradas pelo Mercado Livre,
 * preco, estoque, titulo, anuncio ou campanhas.
 */
type Medidas = { altura_cm: number; largura_cm: number; comprimento_cm: number; peso_g: number };
type Dependencies = {
  meliGet: (env: any, path: string, params?: Record<string, string | undefined>) => Promise<any>;
  meliWrite: (env: any, method: "PUT", path: string, body: unknown) => Promise<{data: any; path_used: string}>;
  textResult: (result: unknown) => any;
  requireListingWritesEnabled: (env: any) => void;
  recordOperationAudit: (env: any, prefix: string, data: Record<string, unknown>) => Promise<string | null>;
};

const CAMPOS = {
  altura_cm: "SELLER_PACKAGE_HEIGHT",
  largura_cm: "SELLER_PACKAGE_WIDTH",
  comprimento_cm: "SELLER_PACKAGE_LENGTH",
  peso_g: "SELLER_PACKAGE_WEIGHT"
} as const;

function lerMedida(attributes: any[], id: string, unidade: "cm" | "g"): number | null {
  const attr = attributes.find((entry: any) => entry?.id === id);
  if (!attr) return null;
  const structured = attr.value_struct ?? attr.values?.[0]?.struct;
  if (structured && typeof structured.number === "number") {
    if (String(structured.unit ?? unidade).toLowerCase() === unidade &&
        Number.isFinite(structured.number) && structured.number > 0) {
      return structured.number;
    }
  }
  const match = String(attr.value_name ?? "").trim().match(/^(\d+(?:[.,]\d+)?)\s*(cm|g)?$/i);
  if (!match || (match[2] && match[2].toLowerCase() !== unidade)) return null;
  const n = Number(match[1].replace(",", "."));
  return Number.isFinite(n) && n > 0 ? n : null;
}

function extrairMedidas(attrs: any[], prefix: "SELLER_PACKAGE_" | "PACKAGE_") {
  return {
    altura_cm: lerMedida(attrs, prefix + "HEIGHT", "cm"),
    largura_cm: lerMedida(attrs, prefix + "WIDTH", "cm"),
    comprimento_cm: lerMedida(attrs, prefix + "LENGTH", "cm"),
    peso_g: lerMedida(attrs, prefix + "WEIGHT", "g")
  };
}

function medidasIguais(a: Record<string, number | null>, b: Medidas) {
  return (Object.keys(CAMPOS) as Array<keyof Medidas>)
    .every((chave) => a[chave] === b[chave]);
}

function formatoFrete(m: Medidas): string {
  // API de cotacao: altura x largura x comprimento, peso em gramas.
  return [m.altura_cm, m.largura_cm, m.comprimento_cm].join("x") + "," + m.peso_g;
}

async function simularFrete(
  deps: Dependencies, env: any, sellerId: string, item: any, medidas?: Medidas
) {
  try {
    const data = await deps.meliGet(env, "/users/" + encodeURIComponent(sellerId) + "/shipping_options/free", {
      ...(medidas ? { dimensions: formatoFrete(medidas) } : { item_id: String(item.id) }),
      item_price: String(item.price),
      listing_type_id: String(item.listing_type_id),
      logistic_type: String(item.shipping.logistic_type),
      mode: String(item.shipping.mode),
      condition: String(item.condition || "new"),
      free_shipping: String(item.shipping.free_shipping === true),
      verbose: "true"
    });
    const valor = data?.coverage?.all_country?.list_cost;
    const custo = valor === null || valor === undefined ? null : Number(valor);
    return { custo_estimado: custo !== null && Number.isFinite(custo) ? custo : null,
      peso_cobravel: data?.coverage?.all_country?.billable_weight ?? null,
      erro: null as string | null };
  } catch (error) {
    return { custo_estimado: null as number | null, peso_cobravel: null,
      erro: error instanceof Error ? error.message.slice(0, 350) : "Simulacao indisponivel" };
  }
}

export function registerMedidasTools(server: any, env: any, deps: Dependencies): void {
  server.registerTool(
    "revisar_corrigir_medidas_anuncio",
    {
      description: "Consulta, simula e, somente com aprovacao explicita, atualiza peso e dimensoes reais da embalagem em UM anuncio Mercado Livre ME2. Usa somente Mercado Livre (nunca Tray). Verifica frete, exige confirmacao da medicao fisica, bloqueia Full e relê o anuncio apos gravar.",
      inputSchema: {
        item_id: z.string().regex(/^MLB\d+$/),
        altura_cm: z.number().int().min(1).max(300).optional(),
        largura_cm: z.number().int().min(1).max(300).optional(),
        comprimento_cm: z.number().int().min(1).max(300).optional(),
        peso_g: z.number().int().min(1).max(50000).optional(),
        medidas_embalagem_confirmadas: z.boolean().optional().default(false),
        permitir_aumento_frete: z.boolean().optional().default(false),
        permitir_sem_simulacao_frete: z.boolean().optional().default(false),
        confirmar: z.boolean().optional().default(false),
        motivo: z.string().max(300).optional()
      }
    },
    async (input: any) => {
      const { item_id, altura_cm, largura_cm, comprimento_cm, peso_g,
        medidas_embalagem_confirmadas, permitir_aumento_frete,
        permitir_sem_simulacao_frete, confirmar, motivo } = input;

      const [seller, item] = await Promise.all([
        deps.meliGet(env, "/users/me"),
        deps.meliGet(env, "/items/" + encodeURIComponent(item_id), {
          include_attributes: "all", include_internal_attributes: "true"
        })
      ]);

      if (!seller?.id || String(item?.seller_id) !== String(seller.id)) {
        throw new Error("Anuncio nao pertence a conta vendedora autenticada. Nenhuma alteracao realizada.");
      }

      const attrs = Array.isArray(item.attributes) ? item.attributes : [];
      const atuais = extrairMedidas(attrs, "SELLER_PACKAGE_");
      const aferidas_ml = extrairMedidas(attrs, "PACKAGE_");
      const tipo = String(item.shipping?.logistic_type || "");
      const modo = String(item.shipping?.mode || "");
      const editavel = item.status === "active" &&
        modo === "me2" && ["cross_docking", "xd_drop_off", "drop_off"].includes(tipo);
      const bloqueio = tipo === "fulfillment"
        ? "Full: dimensoes controladas pela operacao logistica. Nao e permitido alterar por esta ferramenta."
        : modo !== "me2"
          ? "Esta ferramenta trata somente Mercado Envios 2."
          : item.status !== "active"
            ? "O anuncio nao esta ativo para atualizacao."
            : !editavel
              ? "Modalidade logistica nao validada para esta atualizacao."
              : null;

      const supplied = [altura_cm, largura_cm, comprimento_cm, peso_g];
      const alguma = supplied.some((n) => n !== undefined);
      const todas = supplied.every((n) => n !== undefined);
      if (alguma && !todas) {
        throw new Error("Informe os quatro valores da embalagem: altura, largura, comprimento e peso.");
      }
      if (confirmar && !todas) {
        throw new Error("Nenhuma medida foi informada para gravacao.");
      }

      const propostas: Medidas | null = todas
        ? { altura_cm, largura_cm, comprimento_cm, peso_g }
        : null;
      const unchanged = propostas ? medidasIguais(atuais, propostas) : false;

      let atualFrete: Awaited<ReturnType<typeof simularFrete>> | null = null;
      let novoFrete: Awaited<ReturnType<typeof simularFrete>> | null = null;
      if (propostas && editavel && !unchanged) {
        // Se existirem medidas declaradas completas, simula o frete delas; se nao,
        // consulta o custo do anuncio atual como referencia.
        const atuaisCompletas = Object.values(atuais).every((n) => typeof n === "number" && n > 0);
        [atualFrete, novoFrete] = await Promise.all([
          simularFrete(deps, env, String(seller.id), item,
            atuaisCompletas ? atuais as unknown as Medidas : undefined),
          simularFrete(deps, env, String(seller.id), item, propostas)
        ]);
      }

      const comparavel = atualFrete?.custo_estimado !== null &&
        atualFrete?.custo_estimado !== undefined &&
        novoFrete?.custo_estimado !== null &&
        novoFrete?.custo_estimado !== undefined;
      const aumento = comparavel
        ? Number((novoFrete!.custo_estimado! - atualFrete!.custo_estimado!).toFixed(2))
        : null;
      const impedimentos: string[] = [];
      if (bloqueio) impedimentos.push(bloqueio);
      if (propostas && !unchanged) {
        if (!medidas_embalagem_confirmadas) {
          impedimentos.push("Confirme que os quatro valores sao da embalagem real, pronta para envio.");
        }
        if (!comparavel && !permitir_sem_simulacao_frete) {
          impedimentos.push("Simulacao de frete incompleta: exige autorizacao explicita para prosseguir.");
        }
        if (aumento !== null && aumento > 0 && !permitir_aumento_frete) {
          impedimentos.push("O frete estimado aumenta R$ " + aumento.toFixed(2) +
            ". Exige autorizacao explicita para esse aumento.");
        }
      }
      if (confirmar && (!motivo || motivo.trim().length < 10)) {
        impedimentos.push("Informe um motivo com pelo menos 10 caracteres.");
      }

      const preview = {
        item_id, titulo: item.title ?? null, sku: attrs.find((x: any) => x?.id === "SELLER_SKU")?.value_name ?? item.seller_custom_field ?? null,
        status: item.status, logistica: tipo, modo, seller_id: seller.id,
        declaradas_atuais: atuais, aferidas_pelo_ml: aferidas_ml,
        medidas_propostas: propostas,
        dimensoes_shipping: item.shipping?.dimensions ?? null,
        frete_atual: atualFrete, frete_proposto: novoFrete,
        variacao_frete_reais: aumento,
        alteracao_necessaria: propostas ? !unchanged : null,
        impedimentos, observacao:
          "Medidas aferidas pelo ML nao sao uma autorizacao automatica. Use os valores reais do pacote. O alerta do painel pode ter origem em moderacao que exige revisao manual."
      };

      if (!confirmar) return deps.textResult({ ...preview, acao: "simulacao", somente_leitura: true });
      if (unchanged) return deps.textResult({ ...preview, acao: "sem_alteracao" });
      if (impedimentos.length) return deps.textResult({ ...preview, acao: "bloqueado" });

      deps.requireListingWritesEnabled(env);
      const atributos = (Object.keys(CAMPOS) as Array<keyof Medidas>).map((chave) => ({
        id: CAMPOS[chave],
        value_name: String(propostas![chave]) + (chave === "peso_g" ? " g" : " cm")
      }));
      const write = await deps.meliWrite(
        env, "PUT", "/items/" + encodeURIComponent(item_id), { attributes: atributos }
      );

      let depois: any = null;
      let erro_verificacao: string | null = null;
      try {
        depois = await deps.meliGet(env, "/items/" + encodeURIComponent(item_id), {
          include_attributes: "all", include_internal_attributes: "true"
        });
      } catch (error) {
        erro_verificacao = error instanceof Error ? error.message : String(error);
      }
      const depoisMedidas = depois
        ? extrairMedidas(Array.isArray(depois.attributes) ? depois.attributes : [], "SELLER_PACKAGE_")
        : null;
      const confirmado = depoisMedidas ? medidasIguais(depoisMedidas, propostas!) : false;

      const audit_id = await deps.recordOperationAudit(env, "listing:dimensions:audit", {
        tipo: "seller_package_dimensions_update", item_id,
        motivo: motivo.trim(), antes: atuais, depois: depoisMedidas,
        solicitado: propostas, frete_antes: atualFrete, frete_depois: novoFrete,
        confirmar_medicao_fisica: true, endpoint: write.path_used,
        verificacao_confirmada: confirmado, erro_verificacao
      });
      return deps.textResult({
        ...preview, acao: confirmado ? "gravado_e_confirmado" : "gravado_verificacao_pendente",
        depois: depoisMedidas, confirmado_na_api: confirmado,
        audit_id, erro_verificacao, endpoint_utilizado: write.path_used,
        aviso: confirmado ? null
          : "A API aceitou a requisicao, mas as medidas nao foram confirmadas na releitura. Nao considere corrigido."
      });
    }
  );
}
