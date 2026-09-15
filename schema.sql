-- =============================================================
-- PROQUAL Engenheiros e Associados, LDA — Registo de Presença
-- Schema Supabase (PostgreSQL + Storage + RLS) — versão completa
-- =============================================================
-- Como usar (projeto NOVO / de raiz):
-- 1. Cria um projeto em https://supabase.com
-- 2. Vai a "SQL Editor" -> "New query", cola este ficheiro inteiro e clica "Run"
-- 3. Vai a "Storage" e confirma que o bucket "presencas-fotos" foi criado
-- 4. Cria os utilizadores da Gestão em "Authentication" -> "Users" -> "Add user"
-- 5. No fundo deste ficheiro, ajusta o email para tornares esse
--    utilizador "admin"
--
-- Se já tens um projeto a funcionar (ex: ponto-proqual) e só queres
-- ACRESCENTAR as novidades (geofencing, níveis de acesso, edição de
-- registos), usa antes o ficheiro migration_v2.sql — não precisas de
-- correr este ficheiro completo outra vez.
-- =============================================================

-- Extensão usada para gerar UUIDs
create extension if not exists "pgcrypto";

-- -------------------------------------------------------------
-- Tabela: locations (obras E também escritório/sede)
-- "type" distingue um estaleiro de obra de um local de escritório
-- latitude/longitude/radius_m são usados para o geofencing: avisar
-- se o funcionário estiver longe do local escolhido.
-- -------------------------------------------------------------
create table if not exists public.locations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  -- 'externo' = serviço externo sem morada fixa (Finanças, banco, notário,
  -- fornecedores, etc.) — sem geofencing e sujeito a aprovação da Gestão.
  type text not null default 'obra' check (type in ('obra', 'escritorio', 'externo')),
  address text,
  latitude double precision,
  longitude double precision,
  radius_m integer not null default 100,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

-- -------------------------------------------------------------
-- Tabela: employees (funcionários de obra E de escritório)
-- -------------------------------------------------------------
create table if not exists public.employees (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  role text,                 -- ex: "Engenheiro Civil", "Administrativa", "Encarregado"
  department text,           -- ex: "Obra", "Escritório", "Financeiro"
  active boolean not null default true,
  created_at timestamptz not null default now()
);

-- -------------------------------------------------------------
-- Tabela: attendance_records (registos de entrada/saída)
-- -------------------------------------------------------------
create table if not exists public.attendance_records (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees(id) on delete restrict,
  location_id uuid not null references public.locations(id) on delete restrict,
  direction text not null check (direction in ('entrada', 'saida')),
  photo_path text,            -- caminho no bucket "presencas-fotos"
  latitude double precision,
  longitude double precision,
  accuracy_m double precision,
  gps_status text,            -- 'ok' | 'sem_sinal' | 'negado'
  distance_m double precision,     -- distância calculada até ao local escolhido
  within_geofence boolean,         -- se ficou dentro do raio definido para o local
  note text,                       -- nota livre do funcionário (ex: "Finanças, entrega de documentos")
  -- Estado de aprovação: só usado para locais do tipo 'externo' (sem
  -- geofencing) — a Gestão confirma manualmente se o funcionário esteve
  -- mesmo no sítio. Fica a null para registos normais em obra/escritório.
  review_status text check (review_status in ('pendente', 'aprovado', 'rejeitado')),
  reviewed_by text,           -- nome/email de quem aprovou ou rejeitou (auditoria)
  reviewed_at timestamptz,
  updated_by text,            -- nome/email de quem editou o registo pela última vez (auditoria)
  updated_at timestamptz,
  device_time timestamptz not null default now(),  -- hora do dispositivo/servidor no registo
  created_at timestamptz not null default now()
);

create index if not exists idx_attendance_employee on public.attendance_records(employee_id);
create index if not exists idx_attendance_location on public.attendance_records(location_id);
create index if not exists idx_attendance_created on public.attendance_records(created_at desc);

-- -------------------------------------------------------------
-- Tabela: admin_profiles (níveis de acesso da área de Gestão)
-- 'admin' pode gerir tudo; 'encarregado' só vê e marca presença
-- -------------------------------------------------------------
create table if not exists public.admin_profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  role text not null default 'encarregado' check (role in ('admin', 'encarregado')),
  full_name text,
  created_at timestamptz not null default now()
);

-- -------------------------------------------------------------
-- Tabela: absence_requests (justificação de faltas)
-- O funcionário pede pela app (sem login); fica "pendente" até a
-- Gestão (só admin) aprovar ou rejeitar — mesma lógica do Serviço
-- Externo, mas para dias em que o funcionário não compareceu.
-- -------------------------------------------------------------
create table if not exists public.absence_requests (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees(id) on delete restrict,
  absence_date date not null,
  reason text not null default 'outro' check (reason in ('doenca', 'licenca', 'pessoal', 'outro')),
  note text,
  photo_path text,           -- caminho no bucket "presencas-fotos" (ex: foto de um atestado médico)
  status text not null default 'pendente' check (status in ('pendente', 'aprovado', 'rejeitado')),
  created_at timestamptz not null default now(),
  reviewed_by text,          -- nome/email de quem aprovou ou rejeitou (auditoria)
  reviewed_at timestamptz
);

create index if not exists idx_absence_employee on public.absence_requests(employee_id);

-- -------------------------------------------------------------
-- Tabela: audit_log (registo de alterações da Gestão)
-- Append-only por desenho: não há política de update nem delete, para
-- que sirva mesmo como histórico de confiança (ninguém, nem admin,
-- consegue alterar ou apagar uma entrada já registada pela app).
-- -------------------------------------------------------------
create table if not exists public.audit_log (
  id uuid primary key default gen_random_uuid(),
  actor_email text,
  actor_name text,
  action text not null check (action in ('editar', 'apagar', 'aprovar', 'rejeitar')),
  entity_type text not null check (entity_type in ('presenca', 'falta')),
  entity_id uuid,
  entity_label text,          -- descrição legível (ex: nome do funcionário + data), guardada
                               -- porque o registo original pode já ter sido apagado
  created_at timestamptz not null default now()
);

create index if not exists idx_audit_created on public.audit_log(created_at desc);

-- -------------------------------------------------------------
-- Row Level Security
-- Regra geral do projeto:
--  - Qualquer pessoa com o link da app pode LER locais/funcionários ativos
--    e CRIAR um registo de presença (é um quiosque público de ponto,
--    tal como o "Ponto de Obra" original — não tem login para o funcionário).
--  - Utilizadores autenticados (equipa de Gestão) podem ver tudo.
--  - Só quem tem role='admin' em admin_profiles pode editar/apagar
--    funcionários, locais e registos. Quem não é admin ("encarregado")
--    só consegue ver.
-- -------------------------------------------------------------

alter table public.locations enable row level security;
alter table public.employees enable row level security;
alter table public.attendance_records enable row level security;
alter table public.admin_profiles enable row level security;
alter table public.absence_requests enable row level security;
alter table public.audit_log enable row level security;

-- locations
create policy "locations_select_public" on public.locations
  for select using (true);
create policy "locations_insert_auth" on public.locations
  for insert to authenticated with check (true);
create policy "locations_update_admin" on public.locations
  for update to authenticated using (
    exists (select 1 from public.admin_profiles where id = auth.uid() and role = 'admin')
  );
create policy "locations_delete_admin" on public.locations
  for delete to authenticated using (
    exists (select 1 from public.admin_profiles where id = auth.uid() and role = 'admin')
  );

-- employees
create policy "employees_select_public" on public.employees
  for select using (true);
create policy "employees_insert_public" on public.employees
  -- permite que o próprio funcionário se auto-registe no quiosque ("+ Novo funcionário"),
  -- tal como no site original. Remove esta política se quiseres que só a Gestão adicione.
  for insert to anon, authenticated with check (true);
create policy "employees_update_admin" on public.employees
  for update to authenticated using (
    exists (select 1 from public.admin_profiles where id = auth.uid() and role = 'admin')
  );
create policy "employees_delete_admin" on public.employees
  for delete to authenticated using (
    exists (select 1 from public.admin_profiles where id = auth.uid() and role = 'admin')
  );

-- attendance_records
create policy "attendance_insert_public" on public.attendance_records
  for insert to anon, authenticated with check (true);
create policy "attendance_select_auth" on public.attendance_records
  for select to authenticated using (true);
create policy "attendance_update_admin" on public.attendance_records
  for update to authenticated using (
    exists (select 1 from public.admin_profiles where id = auth.uid() and role = 'admin')
  );
create policy "attendance_delete_admin" on public.attendance_records
  for delete to authenticated using (
    exists (select 1 from public.admin_profiles where id = auth.uid() and role = 'admin')
  );

-- admin_profiles: cada um só vê o seu próprio papel
create policy "admin_profiles_select_own" on public.admin_profiles
  for select to authenticated using (auth.uid() = id);

-- absence_requests
create policy "absence_insert_public" on public.absence_requests
  for insert to anon, authenticated with check (true);
create policy "absence_select_auth" on public.absence_requests
  for select to authenticated using (true);
create policy "absence_update_admin" on public.absence_requests
  for update to authenticated using (
    exists (select 1 from public.admin_profiles where id = auth.uid() and role = 'admin')
  );
create policy "absence_delete_admin" on public.absence_requests
  for delete to authenticated using (
    exists (select 1 from public.admin_profiles where id = auth.uid() and role = 'admin')
  );

-- audit_log: qualquer conta de Gestão (admin ou encarregado) pode ver o
-- histórico (transparência) e criar entradas; não há update/delete —
-- é um livro de registo, não uma tabela editável.
create policy "audit_insert_auth" on public.audit_log
  for insert to authenticated with check (true);
create policy "audit_select_auth" on public.audit_log
  for select to authenticated using (true);

-- -------------------------------------------------------------
-- Storage: bucket para as fotos de presença
-- -------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('presencas-fotos', 'presencas-fotos', true)
on conflict (id) do nothing;

create policy "presencas_fotos_insert_public" on storage.objects
  for insert to anon, authenticated
  with check (bucket_id = 'presencas-fotos');

create policy "presencas_fotos_select_public" on storage.objects
  for select using (bucket_id = 'presencas-fotos');

create policy "presencas_fotos_delete_auth" on storage.objects
  for delete to authenticated using (bucket_id = 'presencas-fotos');

-- -------------------------------------------------------------
-- Dados iniciais de exemplo (podes apagar/editar depois pela app)
-- -------------------------------------------------------------
insert into public.locations (name, type, address) values
  ('Sede / Escritório PROQUAL', 'escritorio', null)
on conflict do nothing;

-- -------------------------------------------------------------
-- IMPORTANTE: torna o teu utilizador de Gestão em "admin"
-- (troca o email abaixo pelo que criaste em Authentication -> Users)
-- -------------------------------------------------------------
insert into public.admin_profiles (id, role)
select id, 'admin' from auth.users
where email = 'proqual.ea@gmail.com'
on conflict (id) do update set role = 'admin';
