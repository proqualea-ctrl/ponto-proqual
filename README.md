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
   de horas e dias trabalhados por funcionário, num mês à escolha (inclui
   também as faltas já aprovadas nesse mês — ver item 14).
7. **Editar/apagar registos** — cada registo tem agora botões "Editar" e
   "Apagar" (só visíveis para administradores) para corrigir enganos.
8. **Dois níveis de acesso na Gestão**:
   - **admin** — acesso total (gerir funcionários/locais, editar/apagar
     registos, tudo o resto).
   - **encarregado** — só vê registos, resumo e exporta; não pode gerir
     funcionários/locais nem editar/apagar registos.
9. **Local do tipo "Serviço Externo" + aprovação da Gestão** — para quando
   um funcionário precisa de se deslocar em nome da empresa a um sítio sem
   morada fixa (Finanças, banco, notário, fornecedores, etc.). Este tipo de
   local não tem geofencing (não avisa sobre localização), o funcionário
   pode escrever uma nota a explicar onde foi, e o registo fica marcado
   como **"⏳ Pendente"** até a Gestão o **Aprovar** ou **Rejeitar** —
   registos rejeitados não contam para as horas no Resumo mensal.
10. **Só a Gestão cria obras/locais** — o ecrã do funcionário deixou de ter
    o botão "+ Novo local"; ele só escolhe entre os locais que a Gestão já
    criou (isto já estava protegido na base de dados, agora também está
    refletido na interface).
11. **Identidade institucional** — rodapé com o nome legal da empresa e o
    lema "O Futuro com Precisão" visível em todos os ecrãs da app, e os
    relatórios Excel passam a sair com um cabeçalho oficial (nome da
    empresa, NUIT/morada se preenchidos em `config.js`, título do
    relatório e data/hora de geração) antes da tabela de dados.
12. **Justificação de faltas** — novo botão no ecrã inicial, "JUSTIFICAR
    FALTA": o funcionário escolhe o seu nome, indica a data, o motivo
    (Doença, Licença, Motivo pessoal, Outro), pode escrever uma nota e
    anexar uma **foto** (ex: atestado médico, tirada na hora ou escolhida
    da galeria). O pedido fica **"⏳ Pendente"** até a Gestão o **Aprovar**
    ou **Rejeitar** na nova tab **"Faltas"** (só administradores decidem; o
    número entre parênteses no separador mostra quantos pedidos estão por
    rever, e a foto anexada aparece em miniatura, clicável para ver em
    tamanho grande).
13. **Registo de alterações (auditoria)** — nova tab **"Histórico"** na
    Gestão com o registo de todas as edições, aprovações, rejeições e
    eliminações feitas por um administrador: quem fez, o quê, e quando
    (ex: "Aprovou um registo de presença — Bruno Costa · 14/09/2026,
    15:32"). Cada registo/pedido também mostra diretamente quem o
    aprovou/rejeitou/editou. Este histórico é permanente — mesmo que um
    registo seja apagado depois, a entrada no Histórico mantém-se, e não
    existe forma de editar ou apagar uma entrada do Histórico pela app
    (nem um administrador consegue).
14. **Faltas no Resumo mensal** — as faltas já **aprovadas** pela Gestão
    passam a contar no separador "Resumo": cada funcionário com falta
    justificada nesse mês mostra uma linha extra, ex: "🗓️ 1 falta(s)
    justificada(s)". Faltas ainda pendentes ou rejeitadas não aparecem
    aqui (só depois de aprovadas é que contam como confirmadas).
15. **Cópia de segurança completa** — na tab "Registos", novo botão
    "💾 Cópia de segurança completa (todos os dados)" (só administradores)
    gera, com um clique, um único ficheiro `.xlsx` com **todos** os dados
    da app em separadores distintos: Funcionários, Locais, Registos
    (presenças), Faltas e Histórico. Pensado como cópia de segurança
    independente do Supabase — vale a pena gerar uma de vez em quando e
    guardá-la num sítio seguro (ex: uma pasta na cloud da empresa), como
    salvaguarda extra além dos backups automáticos do Supabase.
16. **Ponto Individual (folha de ponto por funcionário)** — novo separador
    "Ponto Individual" na Gestão: escolhe um funcionário e um mês e vês a
    folha de ponto desse funcionário dia a dia — hora de entrada, hora de
    saída, horas trabalhadas nesse dia, e as faltas já aprovadas nesse mês
    ("Falta justificada — Doença", etc.), com o total de horas, dias
    trabalhados e faltas no topo. A partir daí é possível **exportar em
    Excel** ou em **PDF já formatado como folha de ponto oficial**
    (cabeçalho institucional + tabela + linhas de assinatura do
    funcionário e da Gestão), pronta a imprimir e assinar. Disponível
    para administradores e encarregados (só ver/exportar, tal como o
    Resumo mensal).
17. **Descrição das tarefas na Saída** — depois de tirar a foto para
    marcar **Saída** (só na saída, não na entrada), aparece uma secção
    "Tarefas realizadas neste turno" onde o funcionário descreve o que
    fez e, se possível, indica quanto tempo levou cada tarefa em
    percentagem (ex: "Instalação elétrica — 60%", "Reunião com cliente —
    40%"), com um botão para adicionar mais tarefas e um total que ajuda
    a confirmar que chega aos 100%. É obrigatório indicar pelo menos uma
    tarefa para poder confirmar a saída (a percentagem em si é opcional,
    mas ajuda a Gestão a perceber como o tempo foi distribuído). As
    tarefas ficam visíveis no registo em **Registos**, no separador
    **Ponto Individual** (nova coluna "Tarefas"), e são incluídas tanto
    na **Exportação para Excel** como na **Cópia de segurança completa**.

---

## 1. Atualizar a base de dados (Supabase) — 2 minutos

O projeto Supabase (`ponto-proqual`) já existe e já tem dados — **não é
preciso apagar nada**. Só falta acrescentar as tabelas/colunas novas:

1. Entra em **https://supabase.com/dashboard/project/jvmrsgrfkfafueyfqziy**
2. Vai a **SQL Editor → New query**
3. Cola o conteúdo do ficheiro [`migration_v2.sql`](./migration_v2.sql) e
   clica **Run**

Isto acrescenta: colunas de geofencing em `locations` e `attendance_records`,
a tabela `admin_profiles` (níveis de acesso), a tabela `absence_requests`
(justificação de faltas), a tabela `audit_log` (histórico de alterações),
a coluna `tasks` em `attendance_records` (descrição das tarefas na Saída),
e atualiza as permissões para só o `admin` poder editar/apagar. Podes
correr este ficheiro mais do que uma vez sem problema (não duplica nada).

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

### Preparar uma obra com antecedência (sem lá estar fisicamente)

Cenário comum: um funcionário é destacado para uma obra nova amanhã de
manhã e pode não passar pelo escritório. Como o registo de presença já
deixa escolher **qualquer** local da lista (não só o escritório), basta
que essa obra já esteja criada antes de ele chegar — a app não obriga
ninguém a passar pela sede primeiro.

Para criar a obra a partir do escritório, sem estares lá:

1. Gestão → tab **Obras/Escritório**
2. Escreve o nome da obra e escolhe o tipo
3. Em vez do botão "Usar localização atual" (que exige estar no local),
   preenche à mão os campos **Latitude** e **Longitude** — a forma mais
   fácil é abrir o [Google Maps](https://maps.google.com), clicar com o
   botão direito sobre o ponto exato da obra, e clicar nas coordenadas que
   aparecem no menu (copiam automaticamente no formato `latitude,
   longitude`).
4. Ajusta o **Raio (m)** se quiseres (por defeito 100m — pensado para
   confirmar que a pessoa está mesmo no local sem ser demasiado
   apertado). Para um local mais pequeno/compacto podes descer até
   50m; para uma obra grande ou espalhada, vale a pena subir para
   200–300m, para não gerar avisos de geofencing desnecessários.
   > Nota: o GPS de um telemóvel normal tem um erro típico de 5 a
   > 20m ao ar livre (e pode ser bem pior perto de edifícios/dentro
   > de casas). Um raio de 50m já é bastante rigoroso — funciona
   > bem lá fora, mas pode gerar avisos falsos com o funcionário
   > dentro de um edifício. 100m é mais seguro para o dia a dia.
5. Podes deixar Latitude/Longitude em branco se ainda não souberes as
   coordenadas — a obra fica na lista na mesma, sem aviso de geofencing.

Assim que a obra estiver na lista, qualquer funcionário já a vê em **SOU
FUNCIONÁRIO → escolher local** e regista a presença ali diretamente, sem
qualquer passo pelo escritório.

### Deslocações a serviços externos (Finanças, banco, notário, etc.)

Para o caso de um funcionário ter de se deslocar em nome da empresa a um
sítio sem morada fixa (ex: entregar documentos nas Finanças), cria um local
do tipo **"Serviço Externo"**:

1. Gestão → tab **Obras/Escritório**
2. Nome (ex: "Serviços Externos" — pode ser um único local genérico e
   reutilizável, não precisas de criar um por cada sítio) e tipo **"Serviço
   Externo (sem morada fixa)"**
3. Deixa Latitude/Longitude em branco — não é preciso, e este tipo de local
   nunca mostra aviso de geofencing

No dia a dia, o funcionário escolhe esse local como qualquer outro, e pode
escrever uma nota opcional a explicar onde foi (ex: "Finanças, entrega de
documentos"). Como não há validação automática de localização para este
tipo, o registo fica marcado como **pendente** até a Gestão o rever: em
**Registos**, cada entrada pendente mostra os botões **"✅ Aprovar"** e
**"❌ Rejeitar"** (só para administradores). Um registo rejeitado fica
identificado como tal e não entra na contagem de horas do Resumo mensal.

### Justificar uma falta (funcionário que não compareceu)

Diferente do "Serviço Externo" (que é para quem esteve fora do local
habitual mas trabalhou na mesma), isto é para o dia em que o funcionário
**não esteve presente de todo** — doença, licença, ou qualquer outro
motivo:

1. No ecrã inicial da app, o funcionário toca em **"JUSTIFICAR FALTA"**
   (em vez de "SOU FUNCIONÁRIO").
2. Escolhe o seu nome na lista, tal como faria para marcar presença.
3. Indica a **data da falta**, escolhe o **motivo** (Doença, Licença,
   Motivo pessoal ou Outro), pode escrever uma nota com mais detalhe e,
   se quiser, anexar uma **foto** (ex: atestado médico) — o botão de
   escolher ficheiro abre a câmara do telemóvel ou a galeria, conforme o
   funcionário preferir. Não é obrigatório, mas ajuda a Gestão a decidir
   mais depressa.
4. Envia o pedido — não precisa de GPS, porque não esteve em lado nenhum
   a marcar.

O pedido fica **"⏳ Pendente"**. Em **Gestão → Faltas** (novo separador),
cada pedido pendente aparece com os botões **"✅ Aprovar"** e **"❌
Rejeitar"** (só administradores) — o número entre parênteses no nome do
separador mostra sempre quantos pedidos ainda estão por decidir.

## 2. Atualizar os ficheiros do site (GitHub Pages)

O site está publicado a partir do repositório GitHub
`proqualea-ctrl/ponto-proqual`, com todos os ficheiros na raiz (sem
subpastas). Para atualizar:

1. Abre o repositório em **https://github.com/proqualea-ctrl/ponto-proqual**
2. Para cada ficheiro deste pacote, usa **Add file → Upload files** (ou edita
   cada um individualmente) e substitui o ficheiro existente pelo novo:
   - `index.html`, `style.css`, `app.js` — obrigatório substituir sempre
   - `sw.js` — **também obrigatório substituir sempre**, em toda e
     qualquer atualização (não só na primeira vez) — ver aviso importante
     logo a seguir.
   - `manifest.json` — normalmente só muda na primeira instalação da PWA,
     mas não há problema nenhum em substituir sempre também.
   - `logo.png`, `icon-192.png`, `icon-512.png`, `icon-apple-touch.png`,
     `favicon.png` — só mudam se um dia atualizares a marca/ícones.
   - `config.js` — **já vem com os teus valores reais preenchidos** (o
     mesmo URL e chave que já estavam no site); podes substituir sem
     medo de perder a ligação ao Supabase. Se quiseres que o NUIT e a
     morada da empresa apareçam no cabeçalho dos relatórios Excel, edita
     as linhas `COMPANY_NUIT` e `COMPANY_ADDRESS` neste ficheiro antes de
     subir — se deixares em branco, essas linhas simplesmente não
     aparecem no relatório.
   - `schema.sql`, `migration_v2.sql`, `README.md` — documentação, não
     afetam o site, mas é bom manter atualizados no repositório.
3. Faz commit ("Update to v2"). O GitHub Pages atualiza o site sozinho
   (demora cerca de 1 minuto — vês o progresso em **Settings → Pages**).

> Nota: como todos os ficheiros estão na raiz do repositório (sem pastas
> `css/`/`js/`), basta arrastar os ficheiros deste pacote para a raiz e
> confirmar que substituem os antigos com o mesmo nome.

> ⚠️ **Importante — porque é que às vezes "não aparece nada" depois de
> atualizar:** a app funciona como PWA (é instalável) e por isso guarda
> uma cópia dos ficheiros no telemóvel/navegador para funcionar mais
> depressa e offline. Isto significa que, mesmo depois de o site já
> estar atualizado no GitHub, quem já tinha a app aberta ou instalada
> pode continuar a ver a versão antiga durante algum tempo. Corrigi isto
> nesta versão (o `sw.js` agora tem um número de versão que sobe a cada
> atualização, o que obriga o telemóvel a ir buscar tudo de novo) — mas
> para isto funcionar, o `sw.js` tem mesmo de ser substituído no GitHub
> em **todas** as atualizações futuras, não só nesta. Se depois de
> atualizares (e substituíres o `sw.js`) ainda não vires as novidades,
> fecha a app por completo e volta a abri-la (no telemóvel, ou faz um
> refresh "forçado" no computador — normalmente Ctrl+Shift+R ou
> Cmd+Shift+R).

## 3. Testar

1. Abre **https://proqualea-ctrl.github.io/ponto-proqual/** no telemóvel.
2. No ecrã inicial deve aparecer o logótipo real da PROQUAL e, pouco depois,
   o botão **"📲 Instalar a app neste telemóvel"** (em Android/Chrome; no
   iPhone/Safari, instala-se por **Partilhar → Adicionar ao ecrã principal**).
3. Testa o fluxo normal (**SOU FUNCIONÁRIO** → escolher/criar → **Entrada**
   ou **Saída** → foto → confirmar) e confirma que aparece o aviso de
   localização se estiveres longe do local escolhido. Ao marcar **Saída**,
   depois de tirares a foto deve aparecer a secção "Tarefas realizadas
   neste turno" — tenta confirmar sem escrever nenhuma tarefa (deve
   avisar que é preciso indicar pelo menos uma) e depois preenche uma ou
   mais tarefas com percentagem antes de confirmar; ao marcar **Entrada**
   essa secção não deve aparecer.
4. Testa também **"JUSTIFICAR FALTA"** a partir do ecrã inicial: escolhe um
   funcionário, indica data e motivo, envia — deve aparecer uma mensagem a
   confirmar que ficou pendente de aprovação.
5. Entra em **GESTÃO** com a tua conta e confirma:
   - o crachá ao lado de "GESTÃO" mostra "Administrador" ou "Encarregado";
   - a tab **Resumo** mostra horas por funcionário no mês atual — depois de
     aprovares uma falta (ver abaixo), o funcionário correspondente deve
     mostrar também "🗓️ N falta(s) justificada(s)";
   - a tab **Faltas** mostra o pedido que acabaste de enviar como
     "⏳ Pendente", e (se fores admin) consegues **Aprovar**/**Rejeitar**;
   - a tab **Histórico** mostra as ações que acabaste de fazer (aprovar,
     editar, apagar);
   - a tab **Registos** mostra o registo de Saída que acabaste de enviar
     com a lista de tarefas que escreveste (ex: "🛠️ Instalação elétrica
     (60%), Reunião com cliente (40%)");
   - o botão **Exportar para Excel** descarrega um `.xlsx` (agora com uma
     coluna "Tarefas");
   - (se fores admin) o botão **💾 Cópia de segurança completa** descarrega
     um `.xlsx` com vários separadores (Funcionários, Locais, Registos,
     Faltas, Histórico) — não deve aparecer para uma conta "Encarregado";
   - a tab **Ponto Individual**: escolhe um funcionário e o mês atual e
     confirma que aparece a folha de ponto dia a dia (entrada, saída,
     horas, as tarefas dessa saída, e a falta aprovada acima, se já a
     tiveres aprovado); testa os botões **Exportar Excel** e
     **Exportar PDF** dessa tab — o PDF deve sair já com cabeçalho da
     empresa, tabela e linhas de assinatura;
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
- Correção nesta versão: alguns botões marcados como "só para
  administradores" (ex: 💾 Cópia de segurança completa, adicionar
  funcionário/local) ficavam tecnicamente escondidos para uma conta
  "Encarregado" mas continuavam visíveis no ecrã por um pormenor de CSS —
  a base de dados já bloqueava sempre a ação em si (nunca foi possível
  usá-los sem ser admin), mas agora também ficam corretamente invisíveis.
