# Stop Kar Full Scheduler

Extensao Chrome (Manifest V3) para monitorar datas visiveis na pagina de agendamento do Mercado Envios Full usando a sessao que ja esta aberta no navegador.

## Escopo da versao 0.1

- permite cadastrar uma ou mais datas desejadas;
- verifica a pagina a cada 30, 45, 60 ou 90 segundos;
- observa alteracoes dinamicas da pagina entre os ciclos;
- opcionalmente recarrega a aba quando nenhuma data foi encontrada;
- destaca visualmente a data localizada;
- envia notificacao do Chrome;
- no modo **Selecionar a data**, clica no elemento correspondente;
- **nao confirma o agendamento final** nesta versao.

A confirmacao final foi deixada manual de proposito para validar o comportamento na pagina real do Mercado Livre antes de automatizar qualquer acao irreversivel.

## Instalacao para teste

1. Baixe/descompacte esta pasta.
2. No Chrome, abra `chrome://extensions`.
3. Ative **Modo do desenvolvedor**.
4. Clique em **Carregar sem compactacao**.
5. Escolha a pasta `stopkar-full-scheduler`.
6. Abra o fluxo de envio Full no Mercado Livre e avance ate a tela onde aparecem as datas de entrega no centro de distribuicao.
7. Recarregue essa aba uma vez apos instalar a extensao.
8. Abra a extensao, adicione a data desejada e deixe inicialmente **Somente avisar**.
9. Clique em **Testar agora nesta pagina** e depois em **Iniciar monitoramento**.

## Recomendacao de validacao

Primeiro valide o modo **Somente avisar** com uma data que esteja visivel na tela. A extensao deve destacar a data e mostrar `DATA ENCONTRADA` no painel flutuante.

Depois disso, teste **Selecionar a data**. Esse modo clica na data encontrada, mas nao tenta clicar em botoes como `Continuar`, `Confirmar` ou equivalentes.

## Seguranca operacional

- A extensao nao pede usuario nem senha do Mercado Livre.
- Ela usa apenas a sessao ja autenticada no navegador.
- Nao tenta resolver CAPTCHA nem contornar bloqueios do site.
- O intervalo minimo e 30 segundos para evitar consultas excessivas.
- O monitoramento fica vinculado a uma unica aba.
- Se o Mercado Livre alterar a estrutura da tela, os seletores podem precisar de ajuste.

## Como a deteccao funciona

A extensao procura elementos visiveis e interativos da pagina (`button`, `a`, `role=button`, `role=option`, `role=gridcell`) cujo texto, `aria-label` ou `title` contenha uma representacao da data desejada, por exemplo:

- `07/10/2026`
- `07/10`
- `7 de outubro`

Quando encontra, destaca o elemento. No modo de selecao, clica apenas nesse elemento.

## Proxima etapa

Apos validar a tela real da conta Stop Kar, podemos endurecer os seletores para os componentes exatos do Mercado Livre e, se desejado, adicionar uma segunda etapa de confirmacao automatica com protecoes extras.
