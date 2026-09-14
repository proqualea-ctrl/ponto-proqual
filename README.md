# Ponto PROQUAL — Registo de Presença (v2)

Aplicação web de registo de presença da **PROQUAL Engenheiros e Associados,
Lda** — serve tanto as **obras** como o **escritório**: qualquer funcionário
regista a sua entrada/saída no mesmo sítio, com **foto**, **hora** e
**localização (GPS)** carimbadas no momento.

- Site já em produção em: **https://proqualea-ctrl.github.io/ponto-proqual/**
- Backend (base de dados, autenticação, fotos): projeto Supabase `ponto-proqual`
  (`https://jvmrsgrfkfafueyfqziy.supabase.co`)

Este documento descreve as **novidades da versão 2** e como as ativar no
projeto que já está a funcionar. Não é preciso recomeçar do zero.

---

## Novidades desta versão

1. **Marca própria** — logótipo real da PROQUAL em vez do texto/placeholder,
   cores da app alinhadas com a identidade da empresa.
2. **App instalável (PWA)** — no telemóvel aparece um botão "Instalar a app
   neste telemóvel" no ecrã inicial; depois de instalada, abre como uma app
   normal (ícone no ecrã principal, sem barra de endereço).
3. **Validação de localização (geofencing)** — cada obra/escritório pode ter
   coordenadas GPS e um raio definidos; se o funcionário estiver longe desse
   raio no momento do registo, aparece um aviso (o registo continua a ser
   feito, mas fica assinalado para a Gestão).
4. **Aviso de registos duplicados** — se um funcionário tentar marcar
   "Entrada" quando já tem uma entrada sem saída correspondente (ou
   vice-versa), aparece um aviso antes de confirmar.
5. **Exportar para Excel** — na área de Gestão, tab "Registos", botão
   "Exportar para Excel" gera um ficheiro `.xlsx` com os registos filtrados.
6. **Resumo mensal por funcionário** — novo separador "Resumo" com o total
   de horas e dias trabalhados por funcionário, num mês à escolha.
7. **Editar/apagar registos** — cada registo tem agora botões "Editar" e
   "Apagar" (só visíveis para administradores) para corrigir enganos.
8. **Dois níveis de acesso na Gestão**:
   - **admin** — acesso total (gerir funcionários/locais, editar/apagar
     registos, tudo o resto).
   - **encarregado** — só vê registos, resumo e exporta; não pode gerir
     funcionários/locais nem editar/apagar registos.

---

## 1. Atualizar a base de dados (Supabase) — 2 minutos

O projeto Supabase (`ponto-proqual`) já existe e já tem dados — **não é
preciso apagar nada**. Só falta acrescentar as tabelas/colunas novas:

1. Entra em **https://supabase.com/dashboard/project/jvmrsgrfkfafueyfqziy**
2. Vai a **SQL Editor → New query**
3. Cola o conteúdo do ficheiro [`migration_v2.sql`](./migration_v2.sql) e
   clica **Run**

Isto acrescenta: colunas de geofencing em `locations` e `attendance_records`,
a tabela `admin_profiles` (níveis de acesso), e atualiza as permissões para
só o `admin` poder editar/apagar. Podes correr este ficheiro mais do que uma
vez sem problema (não duplica nada).

> Se um dia precisares de criar o projeto Supabase **de raiz** (ex: para uma
> filial nova), usa antes o [`schema.sql`](./schema.sql) completo — já inclui
> tudo o que o `migration_v2.sql` acrescenta.

### Definir quem é "admin"

O script já promove automaticamente `proqual.ea@gmail.com` a **admin**. Para
dar acesso de **encarregado** a outra pessoa:

1. **Authentication → Users → Add user** — cria a conta dela normalmente
   (com "Auto Confirm User" ligado, para não depender de email).
2. **SQL Editor**, corre:
   ```sql
   insert into public.admin_profiles (id, role)
   select id, 'encarregado' from auth.users where email = 'email-da-pessoa@exemplo.com'
   on conflict (id) do update set role = 'encarregado';
   ```
   (troca `'encarregado'` por `'admin'` se quiseres dar-lhe acesso total.)

Uma conta de Gestão sem linha em `admin_profiles` é tratada como
"encarregado" por defeito.

### Dar coordenadas GPS a uma obra/escritório existente

Sem coordenadas, essa localização simplesmente não tem aviso de geofencing
(continua a funcionar normalmente). Para ativar, na área de Gestão → tab
**Obras/Escritório**, ao criar um local novo usa o botão **"📍 Usar
localização atual"** estando fisicamente no local — ou edita a linha
diretamente na tabela `locations` no Supabase (colunas `latitude`,
`longitude`, `radius_m`).

## 2. Atualizar os ficheiros do site (GitHub Pages)

O site está publicado a partir do repositório GitHub
`proqualea-ctrl/ponto-proqual`, com todos os ficheiros na raiz (sem
subpastas). Para atualizar:

1. Abre o repositório em **https://github.com/proqualea-ctrl/ponto-proqual**
2. Para cada ficheiro deste pacote, usa **Add file → Upload files** (ou edita
   cada um individualmente) e substitui o ficheiro existente pelo novo:
   - `index.html`, `style.css`, `app.js` — obrigatório substituir
   - `manifest.json`, `sw.js` — ficheiros novos (PWA)
   - `logo.png`, `icon-192.png`, `icon-512.png`, `icon-apple-touch.png`,
     `favicon.png` — ficheiros novos (marca/ícones)
   - `config.js` — **já vem com os teus valores reais preenchidos** (o
     mesmo URL e chave que já estavam no site); podes substituir sem
     medo de perder a ligação ao Supabase.
   - `schema.sql`, `migration_v2.sql`, `README.md` — documentação, não
     afetam o site, mas é bom manter atualizados no repositório.
3. Faz commit ("Update to v2"). O GitHub Pages atualiza o site sozinho
   (demora cerca de 1 minuto — vês o progresso em **Settings → Pages**).

> Nota: como todos os ficheiros estão na raiz do repositório (sem pastas
> `css/`/`js/`), basta arrastar os ficheiros deste pacote para a raiz e
> confirmar que substituem os antigos com o mesmo nome.

## 3. Testar

1. Abre **https://proqualea-ctrl.github.io/ponto-proqual/** no telemóvel.
2. No ecrã inicial deve aparecer o logótipo real da PROQUAL e, pouco depois,
   o botão **"📲 Instalar a app neste telemóvel"** (em Android/Chrome; no
   iPhone/Safari, instala-se por **Partilhar → Adicionar ao ecrã principal**).
3. Testa o fluxo normal (**SOU FUNCIONÁRIO** → escolher/criar → **Entrada**
   ou **Saída** → foto → confirmar) e confirma que aparece o aviso de
   localização se estiveres longe do local escolhido.
4. Entra em **GESTÃO** com a tua conta e confirma:
   - o crachá ao lado de "GESTÃO" mostra "Administrador" ou "Encarregado";
   - a tab **Resumo** mostra horas por funcionário no mês atual;
   - o botão **Exportar para Excel** descarrega um `.xlsx`;
   - (se fores admin) consegues **Editar**/**Apagar** um registo.

---

## Domínio próprio (para mais tarde)

A app já está pronta para um domínio próprio (ex: `ponto.proqual.pt`) assim
que a PROQUAL tiver um registado. Quando o tiveres, avisa-me e trato de:

1. Configurar o `CNAME` no GitHub Pages (**Settings → Pages → Custom
   domain**);
2. Adicionar o registo DNS correspondente junto de quem gere o domínio;
3. Confirmar o certificado HTTPS automático do GitHub Pages para esse
   domínio.

Até lá, o link **https://proqualea-ctrl.github.io/ponto-proqual/** funciona
normalmente e pode continuar a ser partilhado com os funcionários.

---

## Estrutura do projeto

Todos os ficheiros ficam na raiz (sem subpastas), tal como já estão no
repositório GitHub:

```
index.html          # toda a interface
style.css           # visual — cores em variáveis no topo do ficheiro
config.js           # chaves do Supabase + textos da marca (já preenchido)
app.js              # toda a lógica (navegação, câmara, GPS, Supabase, etc.)
manifest.json       # configuração da app instalável (PWA)
sw.js               # service worker (cache da app para funcionar como PWA)
logo.png            # logótipo PROQUAL usado na interface
icon-192.png / icon-512.png / icon-apple-touch.png / favicon.png
                     # ícones da app/instalação/aba do browser
schema.sql           # schema completo (só para um projeto Supabase novo)
migration_v2.sql     # migração aditiva para o projeto já existente
```

## Notas sobre segurança e permissões

- Marcar presença continua a **não exigir login** — é um registo tipo
  quiosque, pensado para ser rápido no telemóvel de cada funcionário. Só a
  área de **Gestão** exige email+password.
- Editar e apagar registos, e gerir funcionários/locais, está agora
  restrito a contas com papel `admin` em `admin_profiles` (ver secção 1).
- As fotos continuam num bucket público por defeito (só quem tem o link
  direto da foto a vê). Se quiseres torná-las privadas, é só ajustar o
  `schema.sql`/`migration_v2.sql` — diz-me e faço essa alteração.
