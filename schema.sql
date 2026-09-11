-- =============================================================
-- PROQUAL Engenheiros e Associados, LDA — Registo de Presença
-- Schema Supabase (PostgreSQL + Storage + RLS)
-- =============================================================
-- Como usar:
-- 1. Cria um projeto em https://supabase.com
-- 2. Vai a "SQL Editor" -> "New query", cola este ficheiro inteiro e clica "Run"
-- 3. Vai a "Storage" e confirma que o bucket "presencas-fotos" foi criado
-- 4. Cria os utilizadores da Gestão em "Authentication" -> "Users" -> "Add user"
-- =============================================================

-- Extensão usada para gerar UUIDs
create extension if not exists "pgcrypto";

-- -------------------------------------------------------------
-- Tabela: locations (obras E também escritório/sede)
-- "type" distingue um estaleiro de obra de um local de escritório
-- -------------------------------------------------------------
create table if not exists public.locations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  type text not null default 'obra' check (type in ('obra', 'escritorio')),
  address text,
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
  device_time timestamptz not null default now(),  -- hora do dispositivo/servidor no registo
  created_at timestamptz not null default now()
);

create index if not exists idx_attendance_employee on public.attendance_records(employee_id);
create index if not exists idx_attendance_location on public.attendance_records(location_id);
create index if not exists idx_attendance_created on public.attendance_records(created_at desc);

-- -------------------------------------------------------------
-- Row Level Security
-- Regra geral do projeto:
--  - Qualquer pessoa com o link da app pode LER locais/funcionários ativos
--    e CRIAR um registo de presença (é um quiosque público de ponto,
--    tal como o "Ponto de Obra" original — não tem login para o funcionário).
--  - Só utilizadores autenticados (equipa de Gestão) podem
--    ALTERAR/APAGAR funcionários, locais, e ver/gerir tudo.
-- Ajusta estas políticas se quiseres exigir login também para marcar presença.
-- -------------------------------------------------------------

alter table public.locations enable row level security;
alter table public.employees enable row level security;
alter table public.attendance_records enable row level security;

-- locations: leitura pública dos ativos; escrita só autenticado
create policy "locations_select_public" on public.locations
  for select using (true);
create policy "locations_insert_auth" on public.locations
  for insert to authenticated with check (true);
create policy "locations_update_auth" on public.locations
  for update to authenticated using (true);
create policy "locations_delete_auth" on public.locations
  for delete to authenticated using (true);

-- employees: leitura pública dos ativos; escrita só autenticado
create policy "employees_select_public" on public.employees
  for select using (true);
create policy "employees_insert_public" on public.employees
  -- permite que o próprio funcionário se auto-registe no quiosque ("+ Novo funcionário"),
  -- tal como no site original. Remove esta política se quiseres que só a Gestão adicione.
  for insert to anon, authenticated with check (true);
create policy "employees_update_auth" on public.employees
  for update to authenticated using (true);
create policy "employees_delete_auth" on public.employees
  for delete to authenticated using (true);

-- attendance_records: qualquer pessoa pode criar (marcar presença);
-- só a Gestão (autenticado) pode ler o histórico e apagar
create policy "attendance_insert_public" on public.attendance_records
  for insert to anon, authenticated with check (true);
create policy "attendance_select_auth" on public.attendance_records
  for select to authenticated using (true);
create policy "attendance_delete_auth" on public.attendance_records
  for delete to authenticated using (true);

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
