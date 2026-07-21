-- Supabase auth-to-application profile bridge and least-privilege profile policies.
-- The backend still loads roles from OrganizationMember and never trusts JWT metadata roles.

CREATE OR REPLACE FUNCTION public.handle_texasrenters_auth_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Some deployments apply the Propertyware migrations before the Prisma
  -- foundation migration. Do not break auth.users writes in that state.
  IF to_regclass('public."UserProfile"') IS NULL THEN
    RETURN NEW;
  END IF;

  INSERT INTO public."UserProfile" (
    "id",
    "authUserId",
    "email",
    "displayName",
    "isActive",
    "createdAt",
    "updatedAt"
  )
  VALUES (
    gen_random_uuid(),
    NEW.id::text,
    COALESCE(NEW.email, NEW.id::text || '@pending.local'),
    COALESCE(NULLIF(NEW.raw_user_meta_data ->> 'display_name', ''), split_part(COALESCE(NEW.email, 'User'), '@', 1)),
    true,
    now(),
    now()
  )
  ON CONFLICT ("authUserId") DO UPDATE
  SET "email" = EXCLUDED."email", "updatedAt" = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_texasrenters_auth_user_created ON auth.users;
CREATE TRIGGER on_texasrenters_auth_user_created
AFTER INSERT OR UPDATE OF email, raw_user_meta_data ON auth.users
FOR EACH ROW EXECUTE FUNCTION public.handle_texasrenters_auth_user();

DO $$
BEGIN
  IF to_regclass('public."UserProfile"') IS NOT NULL THEN
    ALTER TABLE public."UserProfile" ENABLE ROW LEVEL SECURITY;

    DROP POLICY IF EXISTS "profiles_select_own" ON public."UserProfile";
    CREATE POLICY "profiles_select_own"
      ON public."UserProfile" FOR SELECT TO authenticated
      USING ("authUserId" = auth.uid()::text);

    DROP POLICY IF EXISTS "profiles_update_own" ON public."UserProfile";
    CREATE POLICY "profiles_update_own"
      ON public."UserProfile" FOR UPDATE TO authenticated
      USING ("authUserId" = auth.uid()::text)
      WITH CHECK ("authUserId" = auth.uid()::text);

    REVOKE INSERT, UPDATE, DELETE ON public."UserProfile" FROM authenticated;
    GRANT UPDATE ("displayName", "updatedAt") ON public."UserProfile" TO authenticated;
  END IF;

  IF to_regclass('public."OrganizationMember"') IS NOT NULL
     AND to_regclass('public."UserProfile"') IS NOT NULL THEN
    ALTER TABLE public."OrganizationMember" ENABLE ROW LEVEL SECURITY;

    DROP POLICY IF EXISTS "memberships_select_own" ON public."OrganizationMember";
    CREATE POLICY "memberships_select_own"
      ON public."OrganizationMember" FOR SELECT TO authenticated
      USING (
        EXISTS (
          SELECT 1
          FROM public."UserProfile" profile
          WHERE profile."id" = "OrganizationMember"."userProfileId"
            AND profile."authUserId" = auth.uid()::text
        )
      );

    REVOKE INSERT, UPDATE, DELETE ON public."OrganizationMember" FROM authenticated;
  END IF;
END
$$;
