# Stop Kar Full Scheduler v0.5.0

Esta versao troca a deteccao antiga por uma leitura visual da estrutura da tela do Mercado Livre.

## O que foi corrigido

- o bloco "Escolha como voce deseja envia-los" agora e encontrado pelo titulo e pelo painel ao redor, nao pelo menor div da pagina;
- o seletor de "Coleta a domicilio" e localizado mesmo quando o componente nao usa button/role padrao;
- o campo "Escolha um dia" e encontrado pelo texto e pelo contorno visual do campo;
- os cliques usam uma sequencia de mouse compativel com componentes React;
- o calendario so e procurado depois que o fluxo de coleta estiver realmente pronto;
- o sucesso continua sendo validado somente quando a data entra no campo de coleta.

## Configuracao recomendada

- Verificar: 30 segundos
- Ao encontrar: Selecionar a data
- Atualizar a pagina automaticamente: ativado
- Parar quando encontrar: ativado

A confirmacao final da pagina continua manual.
