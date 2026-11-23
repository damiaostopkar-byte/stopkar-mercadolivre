import test from "node:test";
import assert from "node:assert/strict";
import { inspectOfficialStoreLink, brandFromItem } from "../src/official-store-tools";

const seller = "123456";
const brands = [
  { official_store_id: 76543, name: "Universal Automotive Systems", fantasy_name: "Universal Automotive Systems" },
  { official_store_id: 99998, name: "Outra marca", fantasy_name: "Outra marca" }
];
function item(brand: string | null, store: number | null = 76543, owner = 123456) {
  return {
    id: "MLB5402198042",
    title: "Calota HB20",
    seller_id: owner,
    official_store_id: store,
    status: "active",
    price: 35,
    available_quantity: 18,
    attributes: brand === null ? [] : [{ id: "BRAND", value_name: brand }]
  };
}
test("marca diferente na Loja Universal: candidato sem alterar anuncio", () => {
  const original = item("Grid");
  const r = inspectOfficialStoreLink(original, seller, brands);
  assert.equal(r.situacao, "candidato_desvinculacao");
  assert.equal(r.elegivel, true);
  assert.equal(original.official_store_id, 76543);
  assert.equal(r.marca_ficha, "Grid");
});
test("Universal confirmada e protegida", () => {
  const r = inspectOfficialStoreLink(item("Universal Automotive Systems"), seller, brands);
  assert.equal(r.elegivel, false);
  assert.equal(r.situacao, "protegido_produto_universal");
});
test("marca ambigua nao e removida", () => {
  const r = inspectOfficialStoreLink(item("Universal"), seller, brands);
  assert.equal(r.elegivel, false);
  assert.equal(r.situacao, "bloqueado_marca_ambigua");
});
test("nao remove anuncios nao vinculados ou associados a outra loja", () => {
  assert.equal(inspectOfficialStoreLink(item("Grid", null), seller, brands).elegivel, false);
  assert.equal(inspectOfficialStoreLink(item("Grid", 99998), seller, brands).elegivel, false);
  assert.equal(inspectOfficialStoreLink(item("Grid", 76543), seller, []).elegivel, false);
});
test("nao remove anuncio de conta diferente nem sem marca", () => {
  assert.equal(inspectOfficialStoreLink(item("Grid", 76543, 555555), seller, brands).elegivel, false);
  assert.equal(inspectOfficialStoreLink(item(null), seller, brands).elegivel, false);
});
test("respeita atributo BRAND e nao adivinha marca pelo titulo", () => {
  assert.equal(brandFromItem(item(null)), null);
  assert.equal(brandFromItem(item("NATT")), "NATT");
});
