import test from "node:test";
import assert from "node:assert/strict";
import { classify, parseRow, ledger, scan } from "../src/shipping-billing-tools.ts";

const period = "2026-11-01";
function row(id: string, value: number, description: string, type = "CHARGE", ref?: string) {
  return {
    charge_info: {
      detail_id: id, detail_amount: value, transaction_detail: description,
      detail_type: type, detail_sub_type: "CXD",
      ...(ref ? { charge_bonified_id: ref } : {})
    },
    shipping_info: { shipping_id: "48484871883" },
    sales_info: [
      { order_id: "2000019460921776" }, { order_id: "2000019460921777" }
    ]
  };
}

test("detects weight/dimension difference without an ordinary freight description", () => {
  assert.equal(classify("Diferença por peso e medidas", "", ""), "diferenca_peso_medidas");
  assert.equal(classify("Envio Mercado Livre", "CXD", ""), "frete_normal");
});

test("parses multiple orders associated with the same shipment", () => {
  const item = parseRow(row("12345", 34.2, "Diferença de peso e medidas"), "BILL", period);
  assert.deepEqual(item?.venda_ids, ["2000019460921776", "2000019460921777"]);
  assert.equal(item?.envio_id, "48484871883");
});

test("does not report ordinary freight as an additional charge", () => {
  const a = parseRow(row("12345", 14.75, "Envio Mercado Livre"), "BILL", period);
  const b = parseRow(row("12346", 34.2, "Diferença de peso e medidas"), "BILL", period);
  assert.equal(ledger([a!, b!]).resumo.cobrancas_documentais, 34.2);
});

test("links later-month credit note without double counting identical bill bonus", () => {
  const charge = parseRow(row("12345", 34.2, "Diferença por peso e medidas"), "BILL", "2026-10-01");
  const credit = parseRow(row("12346", 10.0, "Bônus frete", "BONUS", "12345"),
    "CREDIT_NOTE", "2026-11-01");
  const mirror = parseRow(row("12347", 10.0, "Bônus frete", "BONUS", "12345"),
    "BILL", "2026-11-01");
  const book = ledger([charge!, credit!, mirror!]);
  assert.equal(book.resumo.creditos_documentais_vinculados, 10);
  assert.equal(book.resumo.saldo_documental, 24.2);
  assert.equal(book.bonus_com_possivel_duplicidade.length, 1);
});

test("paginates and marks unfinished scan accurately", async () => {
  const pages: string[] = [];
  const read = async (path: string, params?: Record<string,string|undefined>) => {
    pages.push(params?.document_type + "/" + params?.from_id);
    if (params?.document_type === "BILL") {
      return { results: [row("12345", 34.2, "Diferença por peso e medidas")], last_id: 12345 };
    }
    return { results: [] };
  };
  const book = await scan(read, [period], 1, 1);
  assert.equal(book.completo, false);
  assert.equal(book.paginacao[period + ":BILL"].proximo_from_id, "12345");
  assert.deepEqual(pages, ["BILL/0", "CREDIT_NOTE/0"]);
});

test("rejects invalid periods and does not call the API", async () => {
  const read = async () => { throw new Error("should not call"); };
  await assert.rejects(scan(read, ["2026-13-01"], 50, 1), /Periodo invalido/);
});
