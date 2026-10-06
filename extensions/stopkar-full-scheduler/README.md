# Stop Kar Full Scheduler

Extensao Chrome (Manifest V3) para monitorar datas visiveis na pagina de agendamento do Mercado Envios Full usando a sessao que ja esta aberta no navegador.

## Escopo da versao 0.3.5

- permite cadastrar uma ou mais datas desejadas;
- verifica a pagina a cada 30, 45, 60 ou 90 segundos;
- observa alteracoes dinamicas da pagina entre os ciclos;
- opcionalmente recarrega a aba quando nenhuma data foi encontrada e reabre o calendario automaticamente apos o recarregamento;
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


## Identidade visual Stop Kar

A versao 0.3 usa a logo oficial fornecida pela Stop Kar no popup, no aviso flutuante da pagina, nas notificacoes e no icone da extensao.


## Correcao do calendario apos atualizar

Na versao 0.3.2, quando a atualizacao automatica esta ativada, a extensao salva o estado antes do reload e reabre o seletor `Escolha um dia` assim que a pagina termina de carregar. Tambem foi removida a corrida entre dois temporizadores de verificacao que podia atualizar a pagina antes de concluir a checagem.


## Correcao do calendario piscando

Na versao 0.3.3 o monitor de mudancas do DOM foi removido. Ele estava disparando novas verificacoes durante a propria animacao de abertura do calendario, o que podia alternar abrir/fechar rapidamente. A deteccao do calendario tambem passou a reconhecer o painel real do Mercado Livre pelo mes/ano, dias e botao Confirmar. Agora a verificacao ocorre no intervalo configurado, mantendo o calendario estavel entre os ciclos.


## Deteccao real da disponibilidade

Na versao 0.3.4 a extensao passou a identificar diretamente o calendario aberto do Mercado Livre, localizar o numero do dia dentro do mes/ano correto e diferenciar um dia visivel porem indisponivel de um dia realmente clicavel. O monitor mostra esse estado no painel e so considera a data encontrada quando o dia estiver disponivel para selecao.


## Validacao da selecao real

Na versao 0.3.5 a extensao nao considera mais uma data como encontrada apenas porque o numero do dia esta visivel e parece clicavel. No modo `Selecionar a data`, ela tenta selecionar o dia e depois valida se o Mercado Livre realmente aceitou a selecao, observando estado selecionado, mudanca do campo de data, habilitacao do botao de confirmacao ou mudanca visual persistente. Se o clique nao surtir efeito, o dia e tratado como indisponivel e o monitoramento continua sem disparar notificacao de sucesso.
