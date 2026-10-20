# Bisca

Jogo de Bisca para o navegador, nos modos **1 × 1** e **2 × 2**, contra o computador ou online com amigos em
salas com convite. Segue as regras da [Wikipedia](https://en.wikipedia.org/wiki/Bisca_(card_game)), com a
variação capixaba opcional.

## Como jogar

- **Sozinho, sem internet:** abra o arquivo **`index.html`** no navegador (duplo clique).
- **Online:** rode o servidor (`npm install` e depois `npm start`) e abra http://localhost:5173, ou use o site
  publicado no Render.

- Clique numa carta da sua mão para jogá-la (ou use as teclas **1–9**, da esquerda para a direita).
- Menu inicial: modo (1×1 / 2×2), dificuldade (fácil / médio / difícil), regras (clássica / capixaba), tamanho
  da partida (jogo único, melhor de 3, melhor de 5; na capixaba, quanto valem os 120 pontos) e número de cartas na
  mão (3 tradicional, 7 ou 9).
- Botão **Regras** no jogo, e **⚙** para ligar/desligar a pontuação ao vivo, mudar a velocidade e a dificuldade.

## Regras implementadas

| Item | Regra |
| --- | --- |
| Baralho | 40 cartas (sem 8, 9 e 10) |
| Força | Ás, 7, Rei, Valete, Dama, 6, 5, 4, 3, 2 |
| Pontos | Ás 11 · 7 10 · Rei 4 · Valete 3 · Dama 2 · demais 0 (120 no total) |
| Distribuição | 3 cartas cada; a carta seguinte é virada (define o trunfo) e fica sob o monte. O carteador passa para a direita a cada mão |
| Primeira vaza | Abre quem está à esquerda do carteador (quem corta) |
| Jogada | Sentido anti-horário; **não é obrigatório seguir o naipe** |
| Vaza | Maior trunfo; sem trunfo, maior carta do naipe da primeira carta jogada |
| Compra | Vencedor compra primeiro e abre a próxima vaza; o último a comprar fica com o trunfo virado |
| Fim da mão | Acabaram as cartas, ou uma equipe chegou a 61+ pontos. 60 a 60 é empate |
| Duplas (2×2) | Parceiros sentam frente a frente e somam os pontos |
| Jogos | Quem vence a mão ganha 1 ponto de jogo (set) |

Decisões onde a Wikipedia não especifica: a ordem de jogo na vaza com 4 jogadores segue o sentido anti-horário a
partir de quem abre; o jogador que compra por último recebe a carta do trunfo; ao atingir 61 pontos a mão termina
na hora; 60 × 60 não conta ponto de jogo.

## Bisca Capixaba

Variação do Espírito Santo, escolhida no menu. Mesma mecânica de vazas; muda a pontuação da partida:

| Item | Regra |
| --- | --- |
| Partida | Até **4 pontos**, com quantas mãos forem precisas. A mão vai até a última carta |
| 61 | Quem vence a mão ganha 1 ponto (Copas: 2). 60 a 60 não pontua |
| Capote | Perdedor com menos de 31: o vencedor ganha 2 (Copas: 3) |
| 120 | Fazer os 120 pontos vale 2, 3 ou 4 (escolha no menu; padrão 4, fecha a partida) |
| Heley | Ás de trunfo depois do 7 de trunfo adversário na mesma vaza: +1 para quem jogou o Ás (Copas: +2) |
| Heley de fundo | 7 de trunfo jogado depois do Ás de trunfo adversário: +1 para quem jogou o Ás (Copas: +2) |
| Heley de Roda | 2×2: o 7 de trunfo abre a vaza e o Ás é a 4ª carta: +1 para a dupla do Ás (Copas: +2) |

Ás e 7 de trunfo da mesma dupla na mesma vaza não rendem nada (não há Heley de Parceiros).
| Rodar o 7 | Abrir a 1ª vaza com o 7 de trunfo sem levar o Ás em cima: +1 (Copas: +2) |
| Copas | Quem corta (à esquerda do carteador) pode **bater** no baralho: o trunfo vira Copas. O computador bate quando está perdendo |
| Trunfo | A carta virada nunca é Bisca (7 ou Ás) |
| Naipe não repete | Em cada ciclo de 4 quedas (mãos) cada naipe é trunfo uma vez; depois o ciclo recomeça. Com Copas já usada no ciclo, não dá para bater |
| Ás depois do 7 | O Ás de trunfo só pode ser jogado depois que o 7 de trunfo saiu, exceto se for a última carta na mão. Na tela ele fica apagado enquanto estiver bloqueado |

Os pontos extras contam na hora: se uma dupla chega a 4 durante a mão, a partida termina ali.

Interpretações: "Heley de fundo" foi tratado como o 7 caindo por baixo do Ás já jogado; o Heley de Roda só existe
no 2×2 (no 1×1 a vaza tem duas cartas).

## Computador

- **Fácil**: joga uma carta aleatória em ~40% das vezes.
- **Médio**: heurística que estima o valor esperado de cada carta (chance de levar a vaza, pontos em jogo,
  quanto vale guardar o trunfo) usando as cartas já jogadas.
- **Difícil**: Monte Carlo — sorteia várias distribuições possíveis das cartas que não viu e simula o resto da
  mão para cada jogada. Em simulações vence o nível médio em cerca de 70% das mãos.

Nenhum nível enxerga as cartas dos outros jogadores.

## Salas online

1. No menu, escolha modo, regras e cartas, digite seu nome e toque em **Criar sala e convidar**.
2. Na sala aparece um código de 4 letras e o link de convite (botões **Copiar/Compartilhar** e **WhatsApp**).
   Quem abre o link cai no menu com o código preenchido: é só digitar o nome e **Entrar na sala**.
3. No 2 × 2, cada um escolhe o lugar com **Sentar aqui** (Dupla A = lugares 1 e 3, Dupla B = 2 e 4).
4. O anfitrião toca em **Começar partida**. Lugares vazios ficam com o computador (no nível escolhido no menu).

- O servidor embaralha e confere as jogadas; cada navegador só recebe as próprias cartas.
- Quem cai ou recarrega a página volta ao mesmo lugar (o navegador guarda a vaga). Enquanto estiver fora, o
  computador joga por ele.
- No fim de cada mão qualquer jogador pode tocar em **Próxima mão**. No fim da partida, todos voltam para a sala.
- As salas ficam na memória do servidor: se ele reiniciar (no plano gratuito do Render ele dorme depois de
  15 minutos sem uso), as salas abertas somem e é preciso criar outra.

## Publicação (Render)

O `render.yaml` cria um **Web Service** Node gratuito: `npm install` e `node server.js`, com verificação em
`/health`. No Render: **New → Blueprint**, escolha este repositório e confirme.

## Arquivos

| Arquivo | Conteúdo |
| --- | --- |
| `index.html` | Estrutura da página, menu, sala e diálogos |
| `style.css` | Visual (mesa, cartas desenhadas em CSS/SVG, layout responsivo) |
| `engine.js` | Regras do jogo, sem DOM (também roda no Node) |
| `ai.js` | Jogadores controlados pelo computador |
| `app.js` | Interface, animações, fluxo da partida e cliente das salas online |
| `server.js` | Servidor: arquivos do jogo e salas (WebSocket em `/ws`) |
| `render.yaml` | Configuração do Render |

## Testes rápidos no Node

```bash
node -e "const B=require('./engine.js'),AI=require('./ai.js');const r=B.seeded(1);const s=B.newHand({n:2,hs:3,dealer:0,rng:r});while(!s.over){if(s.turn<0)B.resolveTrick(s);else B.play(s,AI.choose(s,s.turn,'medium',r));}console.log(s.pts)"
```

A soma dos pontos de uma mão jogada até o fim é sempre 120.
