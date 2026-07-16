# Painel Contingência — Dashboard multi-loja Shopify

Dashboard local com visual **Airy Tech** (modo claro, minimalista e arejado, com cartões de vidro suaves) que agrega as métricas de **todas as suas lojas Shopify** em uma tela só, no estilo do Shopify Analytics:

- **Vendas totais, pedidos, ticket médio e itens vendidos** com comparativo automático (vs ontem no mesmo horário, vs período anterior)
- **Ao vivo**: pedidos e receita dos últimos 60 minutos + feed de pedidos recentes de todas as lojas (atualiza sozinho a cada 25s)
- **Gráfico de vendas** por hora (hoje/ontem) ou por dia (7/30 dias), com o período anterior sobreposto para comparação
- **Vendas por loja** com participação de cada uma no total, e o gráfico alterna entre **Total** e **Por loja** (uma linha por loja — dá para ver na hora se uma loja caiu)
- **Produtos mais vendidos** somando todas as lojas
- **Notificação de novo pedido** — som de "cha-ching" 🔔 + aviso na tela quando cai pedido em qualquer loja (dá para silenciar no sininho)
- **Meta do dia** — clique em "✎ meta" no card de vendas para definir sua meta e acompanhar a barra de progresso
- **Pedidos recentes** — tabela com número, loja, cidade, valor e status (PAGO / PENDENTE / REEMBOLSADO)
- **Suas lojas** — card com status de conexão de cada loja e atalho para conectar novas
- **🛰 Command Center** — aba com globo 3D estilo Shopify Live View (pedidos pingando no mapa com país de origem), alertas automáticos (loja sem vender há X horas, falha de conexão, queda de vendas), saúde por loja com nível de risco e ranking de vendas por país
- **🔀 Flow** — aba de contingência vitrine → checkout: você escolhe a loja vitrine (que recebe o tráfego) e as demais viram lojas de checkout em fila; cada uma tem um limite de "vendas para pular", e quando a loja ativa atinge o limite o flow rotaciona automaticamente para a próxima (com botão de pular manual). A configuração fica em `data/flow.json`
- Filtro por loja e períodos (hoje / ontem / 7 dias / 30 dias)

O painel usa **somente dados reais** das suas lojas (Admin API). Enquanto nenhuma loja estiver conectada, ele fica vazio — conecte a primeira em **Lojas → Conectar loja**.

## Como rodar (local)

Precisa do [Node.js](https://nodejs.org) 20.12 ou superior.

```
npm install
npm start
```

Depois abra **http://localhost:3030** no navegador.

Sem configuração, o painel guarda tudo em `data/*.json` e roda sem senha (ele só escuta em `127.0.0.1`, ou seja, apenas a sua máquina). Para usar Supabase/senha localmente, copie `.env.example` para `.env` e preencha.

## Deploy (Vercel + Supabase)

O mesmo código roda hospedado: **Vercel** serve o painel e a API, **Supabase** guarda os dados.

**1. Banco:** no Supabase, rode `supabase/schema.sql` (Dashboard → SQL Editor). Ele cria a tabela `app_state` com RLS ligado — assim a chave pública (anon) não consegue ler seus tokens.

**2. Variáveis de ambiente na Vercel** (Settings → Environment Variables):

| Variável | Para quê |
|---|---|
| `SUPABASE_URL` | URL do projeto Supabase |
| `SUPABASE_SERVICE_ROLE_KEY` | Chave de serviço (só no servidor, nunca no navegador) |
| `ENCRYPTION_KEY` | Criptografa os tokens da Shopify. Gere com `openssl rand -hex 32`. **Não troque depois de conectar lojas** — os tokens salvos ficariam ilegíveis |
| `PANEL_PASSWORD` | Senha de acesso ao painel |
| `CRON_SECRET` | *(opcional)* protege o endpoint do cron |

> Sem `PANEL_PASSWORD`, o painel **se recusa a servir** quando hospedado — de propósito, para sua URL pública não expor as lojas e os tokens.

**3. Cron do pós-compra:** o `vercel.json` já agenda `/api/cron/post-purchase` de hora em hora. Rodando local isso não é usado (o processo varre sozinho a cada 60s). Se o seu plano da Vercel limitar a frequência de cron, dá para apontar um cron externo para essa mesma URL.

### Segurança

- Os tokens da Shopify ficam **criptografados** (AES-256-GCM) no banco — nunca em texto puro.
- `data/` e `.env` estão no `.gitignore`: segredos não vão para o repositório.
- O acesso ao painel exige senha (cookie de sessão assinado com HMAC, HttpOnly).

## Como conectar uma loja

Para cada loja, você cria um "app personalizado" no admin da Shopify (leva ~2 minutos):

1. No admin da loja: **Configurações → Apps e canais de vendas → Desenvolver apps**
   (se for a primeira vez, clique em "Permitir desenvolvimento de apps personalizados")
2. **Criar um app** → dê um nome qualquer (ex.: "Painel")
3. Em **Configuração → Escopos do Admin API**, marque:
   - `read_orders` — **obrigatório**: vendas, faturamento, ticket e a contagem que faz a rotação pular de loja
   - `read_products` — **obrigatório**: contagem de produtos e o AutoMatch por SKU
   - `write_orders` — *opcional*: só para o pós-compra digital (criar o pedido do produto digital)
   - `read_themes` + `write_themes` — *opcional*: só para injetar o script de rastreamento no tema, o que **exige o painel numa URL pública** (não funciona rodando local)
4. Clique em **Instalar app** e copie o **token de acesso do Admin API** (começa com `shpat_` — ele só aparece uma vez!)

> Se você marcar escopos **depois** de instalar o app, salve, clique em **Instalar app** de novo e **gere um token novo** — o token antigo não ganha as permissões.
5. No painel, clique em **Gerenciar lojas**, preencha nome, domínio `.myshopify.com` e o token, teste a conexão e adicione

Repita para cada loja da contingência. Os tokens ficam salvos **somente no seu computador**, em `data/stores.json` — não compartilhe esse arquivo.

## Observações

- **"Visitantes ao vivo" não existe na API da Shopify** — esse dado fica restrito ao analytics interno deles. A seção "Ao vivo" do painel usa pedidos em tempo real (últimos 60 min).
- As lojas devem usar a **mesma moeda** para o total agregado fazer sentido.
- O servidor só escuta em `127.0.0.1` (sua máquina) e faz cache de 25–45s para respeitar o rate limit da Shopify.
- Em períodos com volume muito alto (mais de ~2.500 pedidos por loja), o painel indica "volume alto — parcial" no card de itens.
