# Stop Kar Full Scheduler v0.4.2

Esta versao corrige dois problemas reais encontrados nos testes da Stop Kar:

- o pacote podia entrar na pagina antes de o Mercado Livre terminar de carregar o fluxo de coleta;
- depois de um reload, o campo de envio podia voltar sem `Coleta a domicilio`, fazendo o campo `Escolha um dia` desaparecer.

## Fluxo v0.4.2

1. Aguarda o Mercado Livre carregar.
2. Se necessario, restaura `Coleta a domicilio`.
3. Aguarda `Escolha um dia` aparecer.
4. Abre o calendario.
5. Localiza a data na posicao correta do mes.
6. Tenta selecionar o dia e confirma dentro do calendario.
7. So considera sucesso quando a data aparece no campo de coleta.
8. O `Confirmar` final da pagina continua manual.

A extensao nao recarrega a pagina enquanto o fluxo de coleta ainda estiver carregando.
