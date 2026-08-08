-- Phase 5: department ownership + a single "what's this about?" question
--
-- Run this in the Supabase SQL editor BEFORE deploying the Phase 5 code.
-- Safe to run more than once: every statement is guarded.
--
-- Two changes:
--
--   1. profiles.department_id — which desk a rep/admin belongs to. Until
--      now a *ticket* could be routed to a department but a person could
--      not belong to one, so "send hostel issues to the hostel rep" had
--      nowhere to look.
--
--   2. departments.category — lets one dropdown drive both fields. The
--      student picks a department ("Hostel"), and the API derives the
--      category enum from this column instead of asking twice.

-- ------------------------------------------------------------
-- 1. Staff -> department
-- ------------------------------------------------------------

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS department_id UUID;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'profiles_department_id_fkey'
  ) THEN
    ALTER TABLE public.profiles
      ADD CONSTRAINT profiles_department_id_fkey
      FOREIGN KEY (department_id) REFERENCES public.departments(id)
      -- A deleted department must not delete the person: they keep their
      -- account and simply become unassigned.
      ON DELETE SET NULL;
  END IF;
END $$;

-- Partial: only staff rows ever carry one, and students are the bulk of
-- the table.
CREATE INDEX IF NOT EXISTS idx_profiles_department
  ON public.profiles (department_id)
  WHERE department_id IS NOT NULL;

-- ------------------------------------------------------------
-- 2. Department -> category
-- ------------------------------------------------------------

ALTER TABLE public.departments
  ADD COLUMN IF NOT EXISTS category public."TicketCategory";

-- Backfill from the slugs seeded earlier. Anything unrecognised falls to
-- OTHER, which is a valid routing target rather than a broken one.
UPDATE public.departments SET category = CASE
  WHEN slug ILIKE '%ict%'      OR slug ILIKE '%network%'  THEN 'ICT'
  WHEN slug ILIKE '%academ%'                              THEN 'ACADEMIC'
  WHEN slug ILIKE '%welfare%'                             THEN 'WELFARE'
  WHEN slug ILIKE '%hostel%'   OR slug ILIKE '%facilit%'
    OR slug ILIKE '%infra%'    OR slug ILIKE '%maintenance%' THEN 'INFRASTRUCTURE'
  WHEN slug ILIKE '%admin%'    OR slug ILIKE '%bursary%'  THEN 'ADMINISTRATION'
  ELSE 'OTHER'
END
WHERE category IS NULL;

ALTER TABLE public.departments
  ALTER COLUMN category SET DEFAULT 'OTHER';

-- Only enforce NOT NULL once every row has a value, so a half-seeded
-- table can't wedge the migration.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.departments WHERE category IS NULL) THEN
    ALTER TABLE public.departments ALTER COLUMN category SET NOT NULL;
  END IF;
END $$;

-- ------------------------------------------------------------
-- 3. A hostel desk, since the category enum has never had one
-- ------------------------------------------------------------

INSERT INTO public.departments (id, name, slug, description, category, is_active)
VALUES (
  gen_random_uuid(),
  'Hostel & Accommodation',
  'hostel',
  'Room allocation, facilities and anything else hostel-related.',
  'INFRASTRUCTURE',
  TRUE
)
ON CONFLICT (slug) DO NOTHING;
