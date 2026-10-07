# Stop Kar Full Scheduler v0.4.1

Correcao de empacotamento da versao 0.4: o motor novo agora esta realmente dentro da extensao carregada pelo Chrome.

## Fluxo

1. Aguarda a tela do Mercado Livre terminar de carregar.
2. Abre o seletor `Escolha um dia`.
3. Localiza a data na posicao correta do mes e ano.
4. Tenta selecionar o dia.
5. Clica em `Confirmar` dentro do calendario.
6. So considera sucesso se o campo de coleta passar a mostrar a data escolhida.
7. A confirmacao final da pagina permanece manual.

## Instalacao limpa

1. Abra `chrome://extensions`.
2. Remova qualquer versao anterior do Stop Kar Full Scheduler.
3. Descompacte este ZIP.
4. Ative `Modo do desenvolvedor`.
5. Clique em `Carregar sem compactacao`.
6. Escolha a pasta `stopkar-full-scheduler`.
7. Abra novamente a tela de agendamento do Full e pressione F5 uma vez.

A versao 0.4.1 redefine o modo inicial para `Selecionar a data`, ativa a atualizacao automatica e para quando encontrar.
