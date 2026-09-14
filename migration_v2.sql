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
