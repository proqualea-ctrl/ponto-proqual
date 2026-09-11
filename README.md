# Ponto PROQUAL — Registo de Presença

Aplicação web (sem instalação, funciona em qualquer telemóvel/computador com
browser) igual em funcionamento ao "Ponto de Obra" original, mas:

- serve **obras** *e* **escritório** — qualquer funcionário (de obra ou
  administrativo) regista a sua entrada/saída no mesmo sítio;
- cada registo fica com **foto**, **hora** e **localização (GPS)** carimbadas;
- tem uma área de **Gestão** (com login) para a PROQUAL ver todos os registos,
  filtrar por funcionário/local/dia, e gerir a lista de funcionários e locais.

Não tem build step — é HTML/CSS/JS simples. A base de dados, autenticação e
armazenamento de fotos usam o [Supabase](https://supabase.com) (tem plano
gratuito, suficiente para começar).

---

## 1. Criar o backend (Supabase) — 10 minutos

1. Cria uma conta grátis em **https://supabase.com** e um novo projeto
   (escolhe uma password forte para a base de dados — guarda-a nas tuas
   notas, não é a mesma coisa que as contas dos funcionários).
2. No painel do projeto, vai a **SQL Editor → New query**, cola o conteúdo
   do ficheiro [`supabase/schema.sql`](./supabase/schema.sql) e clica **Run**.
   Isto cria as tabelas (`employees`, `locations`, `attendance_records`), o
   armazenamento das fotos, e as regras de acesso.
3. Vai a **Authentication → Users → Add user** e cria uma conta (email +
   password) para cada pessoa da PROQUAL que vai usar a área de **Gestão**
   (ex: `gestao@proqual.co.mz`). Estas são as únicas contas com login — os
   funcionários que só marcam presença não precisam de conta.
4. Vai a **Project Settings → API** e copia:
   - o **Project URL**
   - a chave **anon public**

## 2. Ligar a app ao Supabase

Abre o ficheiro [`js/config.js`](./js/config.js) e substitui:

```js
SUPABASE_URL: "https://SEU-PROJETO.supabase.co",
SUPABASE_ANON_KEY: "SUA-CHAVE-ANON-PUBLICA",
```

pelos valores que copiaste no passo anterior. Podes também ajustar
`COMPANY_NAME`, `APP_TITLE` e `APP_SUBTITLE` nesse mesmo ficheiro.

> A chave "anon public" é segura para ficar no código do site — é a chave
> pensada para correr no browser do utilizador. As regras de acesso (quem
> pode ler/escrever o quê) estão definidas no `schema.sql`, não nesta chave.

## 3. Publicar no Netlify (tal como o site original)

**Opção mais simples — arrastar a pasta:**

1. Vai a **https://app.netlify.com/drop**
2. Arrasta a pasta `proqual-ponto` inteira para a página
3. Pronto — o Netlify dá-te um link (podes depois mudar o nome do site em
   *Site settings → Change site name*, ou associar um domínio próprio como
   `ponto.proqual.co.mz`)

**Opção com Git (recomendada a prazo, permite atualizações fáceis):**

1. Cria um repositório novo no GitHub e envia estes ficheiros para lá
2. Em Netlify: **Add new site → Import an existing project → GitHub** →
   escolhe o repositório
3. Não é preciso "build command" nem "publish directory" especiais — é um
   site estático simples (publish directory: `.` / raiz do projeto)

## 4. Testar

1. Abre o link do site num telemóvel (a câmara e o GPS só funcionam por
   HTTPS — o Netlify já serve tudo em HTTPS automaticamente).
2. Escolhe **SOU FUNCIONÁRIO** → cria o teu nome → escolhe **Obra** ou
   **Escritório** → **Entrada** → autoriza a câmara e a localização → tira a
   foto → confirma.
3. Volta ao ecrã inicial, escolhe **GESTÃO**, entra com a conta criada no
   passo 1.3, e confirma que o registo aparece na lista com a foto, hora e
   link para o mapa.

---

## Estrutura do projeto

```
proqual-ponto/
├── index.html          # toda a interface (um único ficheiro HTML)
├── css/style.css        # visual — cores em variáveis no topo do ficheiro
├── js/config.js         # chaves do Supabase + textos da marca (edita aqui)
├── js/app.js            # toda a lógica (navegação, câmara, GPS, Supabase)
└── supabase/schema.sql  # tabelas, storage e permissões (corre uma vez)
```

## Personalizar a identidade visual da PROQUAL

Abre `css/style.css` e muda as variáveis no topo (`:root`), por exemplo:

```css
--accent: #e8720c;   /* cor principal dos botões */
--bg: #17181c;        /* cor de fundo */
```

Para usar o logótipo real da PROQUAL em vez da letra "P", substitui o bloco
`.brand-mark` em `index.html` por uma tag `<img src="assets/logo.png" ...>`
(coloca o ficheiro do logo dentro da pasta `assets/`).

## Notas sobre segurança e permissões

- Tal como no site original, marcar presença **não exige login** — é um
  registo tipo quiosque, pensado para ser rápido no telemóvel de cada
  funcionário. Só a área de **Gestão** exige email+password.
- Se preferires que só possa marcar presença quem tiver conta (mais
  seguro, mas mais lento no dia-a-dia), diz-me e ajusto as políticas em
  `supabase/schema.sql` e o fluxo da app.
- As fotos ficam num bucket público por defeito (só quem tem o link direto
  da foto a vê — os links não são listados em lado nenhum público). Se
  quiseres torná-las privadas (só acessíveis a quem faz login na Gestão),
  também é só ajustar o `schema.sql` — é mais uma linha de configuração.
