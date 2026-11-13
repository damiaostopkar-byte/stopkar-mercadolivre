# Checklist de seguranca e implantacao Stop Kar

## Antes de publicar

1. Confirmar no ambiente Cloudflare Worker que `MCP_SHARED_SECRET` ja esta configurado. A nova protecao **rejeita requisições MCP** quando estiver ausente. Configurar o mesmo segredo no cliente MCP conectado ao ChatGPT. **Nao** colocar o segredo no repositório ou mensagens.
2. Validar que o Worker atual responde em `/health` e que `/mcp` sem Authorization devolve HTTP 401.
3. Criar secrets no GitHub Actions: `CLOUDFLARE_API_TOKEN` (token de deploy com privilegios minimos) e `CLOUDFLARE_ACCOUNT_ID`. Nao sao tokens OAuth do Mercado Livre ou Tray.
4. Executar o GitHub Actions de validacao e fazer deploy somente depois da revisao. O workflow executa `tsc --noEmit` e `scripts/check-mcp-auth.mjs`.
5. Apos deploy, testar `consultar_conta`, `buscar_anuncio` MLB/MLBU, `consultar_produto_tray`, `consultar_promocoes_anuncio` e `consultar_ads_conta` (apenas leitura).
6. Testar escrita Ads somente em preview, sem alterar campanhas ou anuncios. Erros HTTP 401/403 podem requerer escopos/permissoes no Mercado Ads e nao sao resolvidos pelo token de deploy Cloudflare.

## Diagnosticos independentes

* O Render `stop-kar-central-ia` usa outro repositório e configuracoes. Falhas dele **nao comprovam** defeito na Cloudflare.
* A Cloudflare continua a executar a versao implantada enquanto o pipeline GitHub falha; um erro no deploy **nao significa** conexao OAuth revogada.
* Chamadas ML que ora respondem e ora falham precisam de traces/logs HTTP na Cloudflare antes de atribuir a causa a token, rate-limit ou falha de infraestrutura.

## Escopo deste patch

* Restringir o interceptador de escrita de Ads ao mesmo controle de acesso do endpoint MCP.
* Falhar fechado quando `MCP_SHARED_SECRET` nao estiver configurado.
* Adicionar verificacao automatica contra regressao dessa ordem de autenticacao.
* Habilitar CI em pull requests sem acessar secrets ou disparar deploy.

Nenhuma operacao de compra, anuncio, preco, estoque, campanha ou OAuth eh executada pelo patch.
