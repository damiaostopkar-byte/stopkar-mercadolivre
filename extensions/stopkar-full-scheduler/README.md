# Stop Kar Full Scheduler v0.4.0

Extensao Chrome para a tela de agendamento do Mercado Envios Full.

## Validacao transacional da data

A versao 0.4.0 foi refeita para evitar falsos positivos. No modo **Selecionar a data**, a extensao so considera sucesso depois que:

1. abre o calendario;
2. localiza o dia na posicao correta do mes/ano;
3. o Mercado Livre aceita a selecao visual daquele dia;
4. a extensao clica no botao **Confirmar** que fica dentro do calendario;
5. o campo de coleta passa a exibir a data escolhida.

Somente depois dessas cinco etapas a extensao mostra **DATA CONFIRMADA**, envia a notificacao e interrompe o monitoramento quando essa opcao estiver ativada.

O botao **Confirmar** final da pagina continua manual nesta versao.

## Configuracao recomendada

- Verificar a cada: 30 segundos
- Ao encontrar: Selecionar a data
- Atualizar a pagina automaticamente: ativado
- Parar quando encontrar: ativado

## Instalacao

1. Abra `chrome://extensions`.
2. Remova a versao anterior.
3. Ative **Modo do desenvolvedor**.
4. Clique em **Carregar sem compactacao**.
5. Selecione a pasta `stopkar-full-scheduler`.
6. Volte para a pagina de agendamento do Full e pressione F5 uma vez.

A extensao usa somente a sessao ja aberta no navegador e nao solicita usuario ou senha do Mercado Livre.
