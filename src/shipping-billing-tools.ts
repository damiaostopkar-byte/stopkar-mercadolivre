import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

// Official Mercado Livre billing data, strictly read-only. Never infer that a
// fiscal credit note is a refund actually received in Mercado Pago.
type ReadApi = (path: string, params?: Record<string, string | undefined>, headers?: Record<string, string>) => Promise<any>;
type Kind = "diferenca_peso_medidas" | "possivel_ajuste_frete" | "frete_normal" | "outro";
type DocType = "BILL" | "CREDIT_NOTE";
type Entry = {
  periodo: string; documento: DocType; lancamento_id: string | null;
  referencia_cobranca_id: string | null; envio_id: string | null;
  venda_ids: string[]; pack_id: string | null; valor: number;
  tipo: string; subtipo: string; status: string; descricao: string;
  classificacao: Kind; numero_documento: string | null; data: string | null;
};
const PERIOD = /^\d{4}-(0[1-9]|1[0-2])-01$/;
const DIGITS = /^\d{3,24}$/;
const round = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const number = (value: unknown): number | null => {
  if (value === null || value === undefined || value === "" || typeof value === "boolean") return null;
  const n = Number(value);
  return Number.isFinite(n) ? round(n) : null;
};
const str = (v: unknown, max = 140) => typeof v === "string" ? v.slice(0, max) : "";
const obj = (x: any): Record<string, any> => x && typeof x === "object" && !Array.isArray(x) ? x : {};
const id = (x: any): string | null => x != null && DIGITS.test(String(x)) ? String(x) : null;
const latin = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
const textResult = (v: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(v, null, 2) }] });

function validatePeriod(period: string) {
  if (!PERIOD.test(period)) throw new Error("Periodo invalido: use YYYY-MM-01.");
  const d = new Date(period + "T00:00:00Z");
  if (Number.isNaN(d.valueOf()) || d.toISOString().slice(0, 10) !== period) {
    throw new Error("Periodo inexistente.");
  }
}
function periodsBetween(first: string, last: string): string[] {
  validatePeriod(first); validatePeriod(last);
  if (first > last) throw new Error("Periodo final anterior ao inicial.");
  const periods: string[] = [];
  const d = new Date(first + "T00:00:00Z");
  while (d.toISOString().slice(0, 10) <= last) {
    periods.push(d.toISOString().slice(0, 10));
    if (periods.length > 3) throw new Error("Limite de 3 meses por consulta. Consulte os demais meses em outra chamada.");
    d.setUTCMonth(d.getUTCMonth() + 1);
  }
  return periods;
}
function classify(description: string, subType: string, concept: string): Kind {
  const t = latin(description);
  const c = latin(concept);
  const freight = /frete|envio|envios|shipment|shipping|pacote|logistic|transporte/.test(t)
    || /^(cxd|bxd|cflx|bflx)$/i.test(subType) || c === "shipping";
  const dimensions = /pes[oa]|medid|dimens|cuba(g|d)|volume|weight|measurement/.test(t);
  const diff = /diferenc|diverg|ajust|adicion|sobretaxa|incorret|surcharge|compens|correc|extra/.test(t);
  if (freight && dimensions && diff) return "diferenca_peso_medidas";
  if (freight && diff) return "possivel_ajuste_frete";
  return freight ? "frete_normal" : "outro";
}
function parseRow(raw: any, doc: DocType, periodo: string): Entry | null {
  if (!raw || typeof raw !== "object") return null;
  const info = obj(raw.charge_info);
  const shipping = obj(raw.shipping_info);
  const sales = Array.isArray(raw.sales_info) ? raw.sales_info : raw.sales_info ? [raw.sales_info] : [];
  const orders: string[] = [];
  for (const sale of sales.slice(0, 60)) {
    const order = id(obj(sale).order_id);
    if (order && !orders.includes(order)) orders.push(order);
  }
  const nestedOrder = id(obj(shipping.order).order_id) || id(obj(raw.order).order_id);
  if (nestedOrder && !orders.includes(nestedOrder)) orders.push(nestedOrder);
  const value = number(info.detail_amount);
  if (value === null) return null;
  const desc = str(info.transaction_detail || info.detail_description, 220);
  const sub = str(info.detail_sub_type, 35).toUpperCase();
  const concept = str(info.concept_type, 60);
  const classification = classify(desc, sub, concept);
  return {
    periodo, documento: doc, lancamento_id: id(info.detail_id),
    referencia_cobranca_id: id(info.charge_bonified_id) || id(info.detail_associated_id),
    envio_id: id(shipping.shipping_id), venda_ids: orders, pack_id: id(shipping.pack_id),
    valor: value, tipo: str(info.detail_type, 30).toUpperCase(),
    subtipo: sub, status: str(info.status || info.legal_document_status, 45).toUpperCase(),
    descricao: desc, classificacao: classification,
    numero_documento: str(info.legal_document_number, 80) || null,
    data: str(info.creation_date_time, 40) || null,
  };
}
function isAdjustment(r: Entry) {
  return r.documento === "BILL" && r.valor > 0
    && (r.tipo === "CHARGE" || r.tipo === "")
    && (r.classificacao === "diferenca_peso_medidas" || r.classificacao === "possivel_ajuste_frete");
}
function isBonus(r: Entry) {
  return r.valor > 0 && (r.documento === "CREDIT_NOTE" || r.tipo === "BONUS");
}
function ledger(all: Entry[]) {
  const unique = new Map<string, Entry>();
  all.forEach((r, i) => unique.set(r.documento + ":" + (r.lancamento_id || r.periodo + ":" + i), r));
  const records = [...unique.values()];
  const charges = records.filter(isAdjustment);
  const credits = records.filter(isBonus);
  const linked = new Map(charges.map(r => [r.lancamento_id, 0]));
  const linkedCredits: Entry[] = [];
  const unmatchedCredits: Entry[] = [];
  const byId = new Map(charges.filter(r => r.lancamento_id).map(r => [r.lancamento_id, r]));
  for (const cr of credits) {
    const ref = cr.referencia_cobranca_id;
    if (ref && byId.has(ref)) {
      linked.set(ref, round((linked.get(ref) || 0) + cr.valor));
      linkedCredits.push(cr);
    } else {
      unmatchedCredits.push(cr);
    }
  }
  const results = charges.map(r => {
    const offset = linked.get(r.lancamento_id) || 0;
    return { ...r, creditos_vinculados: offset, saldo_documental: round(r.valor - offset),
      estorno_financeiro_confirmado: false, prejuizo_liquido_comprovado: null,
      precisa_validar: r.classificacao === "possivel_ajuste_frete" ? "motivo_da_cobranca" : "debito_e_estorno_financeiro" };
  });
  const total = round(results.reduce((sum, r) => sum + r.valor, 0));
  const bonus = round(results.reduce((sum, r) => sum + r.creditos_vinculados, 0));
  const groups = new Map<string, { envio_id: string | null; venda_ids: string[]; lancamentos: string[]; adicionais: number; creditos: number }>();
  for (const r of results) {
    const key = r.envio_id || "sem_envio_identificado";
    const group = groups.get(key) || { envio_id: r.envio_id, venda_ids: [], lancamentos: [], adicionais: 0, creditos: 0 };
    for (const orderId of r.venda_ids) if (!group.venda_ids.includes(orderId)) group.venda_ids.push(orderId);
    if (r.lancamento_id) group.lancamentos.push(r.lancamento_id);
    group.adicionais = round(group.adicionais + r.valor);
    group.creditos = round(group.creditos + r.creditos_vinculados);
    groups.set(key, group);
  }
  return {
    cobrancas: results,
    creditos_vinculados: linkedCredits,
    creditos_sem_vinculo_comprovado: unmatchedCredits,
    envios: [...groups.values()].map(g => ({ ...g, saldo_documental: round(g.adicionais - g.creditos) })),
    resumo: {
      quantidade_ajustes_identificados: results.length,
      diferencas_peso_medidas: results.filter(r => r.classificacao === "diferenca_peso_medidas").length,
      outros_ajustes_frete_a_validar: results.filter(r => r.classificacao === "possivel_ajuste_frete").length,
      cobrancas_documentais: total, creditos_documentais_vinculados: bonus,
      saldo_documental: round(total - bonus), estornos_realmente_recebidos: null,
      prejuizo_liquido_real: null,
      aviso: "Saldo documental nao e prejuizo financeiro confirmado. Confirmar debitos, estornos pagos e medidas antes de solicitar reembolso."
    }
  };
}
async function readPage(read: ReadApi, periodo: string, tipo: DocType, cursor: string, limit: number) {
  validatePeriod(periodo);
  if (cursor !== "0" && !DIGITS.test(cursor)) throw new Error("Cursor from_id invalido.");
  const path = "/billing/integration/periods/key/" + periodo + "/group/ML/details";
  const data = await read(path, {
    document_type: tipo, limit: String(limit), from_id: cursor,
    sort_by: "ID", order_by: "ASC"
  });
  if (!data || !Array.isArray(data.results) || data.errors?.length) throw new Error("Dados de faturamento invalidos ou parciais.");
  const rows = data.results as any[];
  const last = id(data.last_id) || id(obj(rows[rows.length - 1]).charge_info?.detail_id);
  const finished = rows.length < limit;
  if (!finished && (!last || last === cursor)) throw new Error("Paginacao nao avancou; consulta interrompida para evitar lacunas.");
  const entries = rows.map(row => parseRow(row, tipo, periodo)).filter((r): r is Entry => !!r);
  return {
    encontrados: entries.filter(r => r.classificacao === "diferenca_peso_medidas"
      || r.classificacao === "possivel_ajuste_frete" || r.referencia_cobranca_id != null),
    scanned: rows.length, next: finished ? null : last, finished,
    total_informado: typeof data.total === "number" ? data.total : null,
  };
}
async function scan(read: ReadApi, periods: string[], limit: number, maxPages: number,
                    firstBill = "0", firstCredit = "0") {
  const rows: Entry[] = [];
  const cursors: Record<string, { completo: boolean; proximo_from_id: string | null; paginas_lidas: number; registros_lidos: number }> = {};
  for (const p of periods) {
    for (const doc of ["BILL", "CREDIT_NOTE"] as DocType[]) {
      let cursor = periods.length === 1 ? (doc === "BILL" ? firstBill : firstCredit) : "0";
      let finished = false, scanned = 0, pages = 0;
      while (pages < maxPages && !finished) {
        const data = await readPage(read, p, doc, cursor, limit);
        pages += 1;
        scanned += data.scanned;
        rows.push(...data.encontrados);
        finished = data.finished;
        cursor = data.next || cursor;
      }
      cursors[p + ":" + doc] = {
        completo: finished, proximo_from_id: finished ? null : cursor,
        paginas_lidas: pages, registros_lidos: scanned
      };
    }
  }
  const complete = Object.values(cursors).every(x => x.completo);
  return { somente_leitura: true, fonte: "api_mercado_livre_billing", periodos: periods,
    completo: complete, paginacao: cursors, ...ledger(rows),
    alcance_dos_totais: complete ? "periodos_informados_completos" : "somente_paginas_consultadas",
    avisos: [
      "Documentos BILL e CREDIT_NOTE foram consultados em sequencia.",
      "Creditos de meses posteriores so serao reconhecidos se o periodo correspondente estiver incluso.",
      ...(!complete ? ["Paginacao ainda pendente. Continue usando os cursores; totais parciais nao representam todas as vendas."] : [])
    ] };
}

export function registerShippingBillingTools(server: McpServer, read: ReadApi) {
  server.registerTool("consultar_compensacao_frete_envio", {
    description: "Consulta oficial de ajustes por peso e dimensoes de um envio, sem alterar nada. Consulta costs e compensation_costs, diferencia custo original, ajuste estimado e estorno financeiro nao confirmado.",
    inputSchema: { shipment_id: z.union([z.string().regex(/^\d{5,24}$/), z.number().int().positive()]) }
  }, async ({ shipment_id }) => {
    const sid = String(shipment_id);
    const [account, costs] = await Promise.all([
      read("/users/me"),
      read("/shipments/" + sid + "/costs", {}, { "x-format-new": "true" })
    ]);
    const sellerId = String(account?.id || "");
    const senders = Array.isArray(costs?.senders) ? costs.senders : [];
    const own = senders.filter((r: any) => String(r?.user_id) === sellerId);
    if (!sellerId || own.length === 0) throw new Error("Envio nao pertence a conta Mercado Livre autorizada ou custo inacessivel.");
    let comp: any = null, detailStatus = "nao_consultado";
    try {
      comp = await read("/marketplace/shipments/" + sid + "/compensation_costs", {
        weight_unit: "g", dimensions_unit: "cm"
      });
      detailStatus = comp ? "disponivel" : "resposta_vazia";
    } catch (error) {
      const msg = String(error);
      if (/Mercado Livre API (403|404|422):/.test(msg)) {
        detailStatus = "indisponivel_" + (msg.match(/API (403|404|422):/) || [])[1];
      } else throw error;
    }
    const compAmount = number(comp?.costs?.compensation);
    const original = round(own.reduce((s: number, r: any) => s + (number(r?.cost) || 0), 0));
    const adjustmentRows = own.flatMap((r: any) => Array.isArray(r.compensations) ? r.compensations : []);
    const adjustment = round(adjustmentRows.reduce((s: number, r: any) => s + (number(r?.amount) || 0), 0));
    return textResult({
      shipment_id: sid, vendedor_id: sellerId, frete_original: original,
      compensacao_logistica: compAmount !== null ? compAmount : (adjustmentRows.length ? adjustment : null),
      fonte_compensacao: compAmount !== null ? "compensation_costs" : adjustmentRows.length ? "shipments_costs" : null,
      detalhamento_disponivel: detailStatus, medidas_verificadas: comp?.package || null,
      dimension_by: comp?.dimension_by || null, cobrancas_costs: adjustmentRows,
      divergencia_entre_endpoints: compAmount !== null && adjustmentRows.length > 0 ? round(compAmount - adjustment) : null,
      estorno_financeiro_confirmado: false, prejuizo_liquido_real: null,
      observacao: "Compensacao logistica e calculo de frete nao demonstram debito ou estorno efetivo. Concilie com BILL e CREDIT_NOTE."
    });
  });

  server.registerTool("consultar_periodos_faturamento_frete", {
    description: "Lista periodos fiscais do Mercado Livre para consultar faturas (BILL) e notas de credito (CREDIT_NOTE). Somente leitura; evitar consultas repetitivas.",
    inputSchema: {
      documento: z.enum(["BILL", "CREDIT_NOTE"]).default("BILL"),
      offset: z.number().int().min(0).max(500).default(0)
    }
  }, async ({ documento, offset }) => {
    const data = await read("/billing/integration/monthly/periods", {
      group: "ML", document_type: documento, limit: "12", offset: String(offset)
    });
    if (!Array.isArray(data?.results)) throw new Error("Mercado Livre nao devolveu lista valida de periodos.");
    return textResult({
      somente_leitura: true, documento, total: data.total ?? null, offset,
      periodos: data.results.map((r: any) => ({
        periodo: str(r?.key, 10), inicio: str(r?.period?.date_from, 20),
        fim: str(r?.period?.date_to, 20), status: str(r?.period_status, 40)
      }))
    });
  });

  server.registerTool("auditar_cobrancas_frete_periodo", {
    description: "Consulta cobranças adicionais de frete e notas de crédito de UM periodo fiscal, com paginacao retomavel por from_id. Identifica divergencias de peso/medidas, vendas e estornos documentais (sem confundir com estorno recebido). Somente leitura.",
    inputSchema: {
      periodo: z.string().regex(PERIOD),
      bill_from_id: z.string().regex(/^\d{1,24}$/).default("0"),
      credit_from_id: z.string().regex(/^\d{1,24}$/).default("0"),
      limite: z.number().int().min(50).max(1000).default(300),
      max_paginas: z.number().int().min(1).max(4).default(2)
    }
  }, async ({ periodo, bill_from_id, credit_from_id, limite, max_paginas }) =>
    textResult(await scan(read, [periodo], limite, max_paginas, bill_from_id, credit_from_id)));

  server.registerTool("auditar_cobrancas_frete_historico", {
    description: "Percorre sequencialmente ate 3 meses de faturamento Mercado Livre (BILL e CREDIT_NOTE), cruza cobranças extras, vendas e notas de credito entre meses. Paginacao e total parcial explicitos; somente leitura.",
    inputSchema: {
      primeiro_periodo: z.string().regex(PERIOD),
      ultimo_periodo: z.string().regex(PERIOD),
      limite: z.number().int().min(50).max(1000).default(300),
      max_paginas: z.number().int().min(1).max(4).default(2)
    }
  }, async ({ primeiro_periodo, ultimo_periodo, limite, max_paginas }) => {
    const periods = periodsBetween(primeiro_periodo, ultimo_periodo);
    return textResult(await scan(read, periods, limite, max_paginas));
  });
}
