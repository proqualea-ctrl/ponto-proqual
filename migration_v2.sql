-- =============================================================
-- PROQUAL — Ponto de Presença — Migração v2
-- Corre isto no SQL Editor do projeto "ponto-proqual" (o que já
-- está a funcionar) — só ACRESCENTA coisas, não apaga nada do
-- que já tens.
-- =============================================================

-- -------------------------------------------------------------
-- 1) Geofencing: coordenadas e raio de cada local
-- -------------------------------------------------------------
alter table public.locations
  add column if not exists latitude double precision,
  add column if not exists longitude double precision,
  add column if not exists radius_m integer not null default 100;

-- Se já tinhas corrido uma versão anterior desta migração (com o raio
-- por defeito a 150m), isto ajusta para 100m os locais que ainda estão
-- com o valor antigo por defeito. Não mexe em locais onde já tenhas
-- definido um raio à mão (diferente de 150).
update public.locations set radius_m = 100 where radius_m = 150;

-- -------------------------------------------------------------
-- 2) Guardar a distância calculada e se ficou dentro do raio
-- -------------------------------------------------------------
alter table public.attendance_records
  add column if not exists distance_m double precision,
  add column if not exists within_geofence boolean;

-- -------------------------------------------------------------
-- 1b) Novo tipo de local: "Serviço Externo" (Finanças, banco, notário,
-- fornecedores, etc.) — sem morada fixa, por isso sem geofencing.
-- -------------------------------------------------------------
alter table public.locations drop constraint if exists locations_type_check;
alter table public.locations add constraint locations_type_check
  check (type in ('obra', 'escritorio', 'externo'));

-- Nota livre do funcionário no registo (ex: "Finanças, entrega de
-- documentos") e estado de aprovação da Gestão. O estado só é usado
-- para registos em locais do tipo 'externo' (sem geofencing) — a
-- Gestão confirma manualmente se o funcionário esteve mesmo no sítio.
alter table public.attendance_records
  add column if not exists note text,
  add column if not exists review_status text
    check (review_status in ('pendente', 'aprovado', 'rejeitado'));

-- -------------------------------------------------------------
-- 3) Níveis de acesso da Gestão: admin vs encarregado
-- -------------------------------------------------------------
create table if not exists public.admin_profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  role text not null default 'encarregado' check (role in ('admin', 'encarregado')),
  full_name text,
  created_at timestamptz not null default now()
);

alter table public.admin_profiles enable row level security;

drop policy if exists "admin_profiles_select_own" on public.admin_profiles;
create policy "admin_profiles_select_own" on public.admin_profiles
  for select to authenticated using (auth.uid() = id);

-- Torna automaticamente "admin" o primeiro utilizador de Gestão que
-- já tens criado (ajusta o email se quiseres que seja outra pessoa).
-- Podes correr isto quantas vezes quiseres — não duplica.
insert into public.admin_profiles (id, role)
select id, 'admin' from auth.users
where email = 'proqual.ea@gmail.com'
on conflict (id) do update set role = 'admin';

-- Para adicionar um "encarregado" mais tarde (depois de criares o
-- utilizador em Authentication -> Users), corre manualmente:
--   insert into public.admin_profiles (id, role)
--   select id, 'encarregado' from auth.users where email = 'email-da-pessoa@exemplo.com'
--   on conflict (id) do update set role = 'encarregado';

-- -------------------------------------------------------------
-- 4) Atualizar permissões: só quem é "admin" pode gerir/editar/apagar
--    (um "encarregado" continua a poder ver tudo e marcar presença,
--    mas não pode corrigir registos nem gerir funcionários/locais)
-- -------------------------------------------------------------

-- locations
drop policy if exists "locations_update_auth" on public.locations;
drop policy if exists "locations_update_admin" on public.locations;
create policy "locations_update_admin" on public.locations
  for update to authenticated using (
    exists (select 1 from public.admin_profiles where id = auth.uid() and role = 'admin')
  );

drop policy if exists "locations_delete_auth" on public.locations;
drop policy if exists "locations_delete_admin" on public.locations;
create policy "locations_delete_admin" on public.locations
  for delete to authenticated using (
    exists (select 1 from public.admin_profiles where id = auth.uid() and role = 'admin')
  );

-- employees
drop policy if exists "employees_update_auth" on public.employees;
drop policy if exists "employees_update_admin" on public.employees;
create policy "employees_update_admin" on public.employees
  for update to authenticated using (
    exists (select 1 from public.admin_profiles where id = auth.uid() and role = 'admin')
  );

drop policy if exists "employees_delete_auth" on public.employees;
drop policy if exists "employees_delete_admin" on public.employees;
create policy "employees_delete_admin" on public.employees
  for delete to authenticated using (
    exists (select 1 from public.admin_profiles where id = auth.uid() and role = 'admin')
  );

-- attendance_records: agora também dá para editar (update), só admin
drop policy if exists "attendance_delete_auth" on public.attendance_records;
drop policy if exists "attendance_delete_admin" on public.attendance_records;
create policy "attendance_delete_admin" on public.attendance_records
  for delete to authenticated using (
    exists (select 1 from public.admin_profiles where id = auth.uid() and role = 'admin')
  );

drop policy if exists "attendance_update_admin" on public.attendance_records;
create policy "attendance_update_admin" on public.attendance_records
  for update to authenticated using (
    exists (select 1 from public.admin_profiles where id = auth.uid() and role = 'admin')
  );

-- Nota: um utilizador de Gestão que ainda não tenha uma linha em
-- admin_profiles é tratado como "encarregado" (só vê, não gere) —
-- a app também aplica esta regra visualmente, escondendo os botões
-- de gerir/editar/apagar para quem não é admin.

-- -------------------------------------------------------------
-- 5) Justificação de faltas: o funcionário pede pela app (sem
--    login), fica "pendente" e só a Gestão (admin) aprova/rejeita —
--    a mesma lógica já usada para o "Serviço Externo".
-- -------------------------------------------------------------
create table if not exists public.absence_requests (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees(id) on delete restrict,
  absence_date date not null,
  reason text not null default 'outro' check (reason in ('doenca', 'licenca', 'pessoal', 'outro')),
  note text,
  status text not null default 'pendente' check (status in ('pendente', 'aprovado', 'rejeitado')),
  created_at timestamptz not null default now(),
  reviewed_at timestamptz
);

-- Foto opcional (ex: atestado médico) — caso já tenhas corrido uma versão
-- anterior desta secção sem esta coluna, isto acrescenta-a sem apagar nada.
alter table public.absence_requests add column if not exists photo_path text;

create index if not exists idx_absence_employee on public.absence_requests(employee_id);

alter table public.absence_requests enable row level security;

drop policy if exists "absence_insert_public" on public.absence_requests;
create policy "absence_insert_public" on public.absence_requests
  for insert to anon, authenticated with check (true);

drop policy if exists "absence_select_auth" on public.absence_requests;
create policy "absence_select_auth" on public.absence_requests
  for select to authenticated using (true);

drop policy if exists "absence_update_admin" on public.absence_requests;
create policy "absence_update_admin" on public.absence_requests
  for update to authenticated using (
    exists (select 1 from public.admin_profiles where id = auth.uid() and role = 'admin')
  );

drop policy if exists "absence_delete_admin" on public.absence_requests;
create policy "absence_delete_admin" on public.absence_requests
  for delete to authenticated using (
    exists (select 1 from public.admin_profiles where id = auth.uid() and role = 'admin')
  );

-- -------------------------------------------------------------
-- 6) Registo de alterações (auditoria): quem editou/apagou/aprovou/
--    rejeitou o quê e quando. Guarda o nome/email de quem fez cada
--    ação diretamente nos registos, e mantém também um livro de
--    registo à parte (audit_log) — este último é append-only (sem
--    update/delete no schema), para sobreviver mesmo que o registo
--    original seja apagado, e para servir de histórico de confiança.
-- -------------------------------------------------------------
alter table public.attendance_records
  add column if not exists reviewed_by text,
  add column if not exists reviewed_at timestamptz,
  add column if not exists updated_by text,
  add column if not exists updated_at timestamptz;

alter table public.absence_requests
  add column if not exists reviewed_by text;

create table if not exists public.audit_log (
  id uuid primary key default gen_random_uuid(),
  actor_email text,
  actor_name text,
  action text not null check (action in ('editar', 'apagar', 'aprovar', 'rejeitar')),
  entity_type text not null check (entity_type in ('presenca', 'falta')),
  entity_id uuid,
  entity_label text,
  created_at timestamptz not null default now()
);

create index if not exists idx_audit_created on public.audit_log(created_at desc);

alter table public.audit_log enable row level security;

drop policy if exists "audit_insert_auth" on public.audit_log;
create policy "audit_insert_auth" on public.audit_log
  for insert to authenticated with check (true);

drop policy if exists "audit_select_auth" on public.audit_log;
create policy "audit_select_auth" on public.audit_log
  for select to authenticated using (true);

-- -------------------------------------------------------------
-- 7) Tarefas realizadas no turno (preenchidas na Saída)
-- -------------------------------------------------------------
-- Lista de { description, percent } em JSON, ex.:
-- [{"description":"Instalação elétrica","percent":40}, ...].
-- Fica a null nos registos de Entrada (não se pede tarefas nesse
-- momento) e continua opcional na Saída.
alter table public.attendance_records
  add column if not exists tasks jsonb;

-- -------------------------------------------------------------
-- 8) Correção: alargar o audit_log para aceitar o registo de
-- alterações de segurança (trocar a própria palavra-passe, na tab
-- "Conta" ou por link de recuperação). Sem isto, essas ações eram
-- bloqueadas pela restrição da coluna e nunca ficavam guardadas no
-- Histórico (a app continuava a funcionar na mesma, só o registo no
-- Histórico falhava silenciosamente).
-- -------------------------------------------------------------
alter table public.audit_log drop constraint if exists audit_log_action_check;
alter table public.audit_log add constraint audit_log_action_check
  check (action in ('editar', 'apagar', 'aprovar', 'rejeitar', 'seguranca'));

alter table public.audit_log drop constraint if exists audit_log_entity_type_check;
alter table public.audit_log add constraint audit_log_entity_type_check
  check (entity_type in ('presenca', 'falta', 'conta'));

-- -------------------------------------------------------------
-- 9) Fotos de presença: tornar o bucket privado
-- -------------------------------------------------------------
-- Até aqui, as fotos ficavam num bucket público — quem tivesse o link
-- direto via uma foto (mesmo sem login) conseguia vê-la. A partir de
-- agora o bucket passa a privado, e só a Gestão (contas autenticadas)
-- consegue gerar um link temporário para ver cada foto (a app já foi
-- atualizada para pedir esse link em vez do link público antigo).
update storage.buckets set public = false where id = 'presencas-fotos';

drop policy if exists "presencas_fotos_select_public" on storage.objects;
create policy "presencas_fotos_select_auth" on storage.objects
  for select to authenticated using (bucket_id = 'presencas-fotos');

-- -------------------------------------------------------------
-- 10) Só a Gestão pode registar novos funcionários
-- -------------------------------------------------------------
-- Até aqui, qualquer pessoa no quiosque conseguia criar-se a si própria
-- como funcionário ("+ Novo funcionário", sem sessão iniciada). Isso
-- permitia nomes de teste/duplicados. A partir de agora só contas de
-- Gestão autenticadas (admin ou encarregado) podem criar funcionários —
-- a app já foi atualizada para deixar de mostrar essa opção no ecrã do
-- funcionário; esta política é o que impede mesmo que alguém contorne a
-- interface e insira diretamente na base de dados.
drop policy if exists "employees_insert_public" on public.employees;
create policy "employees_insert_auth" on public.employees
  for insert to authenticated with check (true);
