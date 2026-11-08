-- Initial administrator-only installation, in a dedicated test/project database.
-- Run as the database owner. Existing/partial namespaces are rejected, never repaired.
BEGIN;
SELECT pg_advisory_xact_lock(686100430001);
CREATE SCHEMA fin_supabase;
REVOKE ALL ON SCHEMA fin_supabase FROM PUBLIC, anon, authenticated, service_role;

CREATE TABLE fin_supabase.migrations (
  version integer PRIMARY KEY CHECK (version = 1),
  identity text NOT NULL,
  fingerprint text NOT NULL
);
CREATE TABLE fin_supabase.vaults (
  id text PRIMARY KEY,
  payload jsonb NOT NULL CHECK (payload->>'id' = id),
  generation text NOT NULL,
  stamp bigint NOT NULL CHECK (stamp >= 0)
);
CREATE TABLE fin_supabase.accounts (
  vault_id text NOT NULL REFERENCES fin_supabase.vaults(id),
  payload jsonb NOT NULL,
  id text GENERATED ALWAYS AS (payload->>'id') STORED NOT NULL,
  name text GENERATED ALWAYS AS (payload->>'name') STORED NOT NULL,
  PRIMARY KEY (vault_id,id), UNIQUE (vault_id,name)
);
CREATE TABLE fin_supabase.settings (
  vault_id text PRIMARY KEY REFERENCES fin_supabase.vaults(id),
  payload jsonb NOT NULL,
  income_id text GENERATED ALWAYS AS (payload->>'incomeAccountId') STORED,
  expense_id text GENERATED ALWAYS AS (payload->>'expenseAccountId') STORED,
  FOREIGN KEY (vault_id,income_id) REFERENCES fin_supabase.accounts(vault_id,id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (vault_id,expense_id) REFERENCES fin_supabase.accounts(vault_id,id) DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE fin_supabase.categories (
  vault_id text NOT NULL REFERENCES fin_supabase.vaults(id),
  payload jsonb NOT NULL,
  id text GENERATED ALWAYS AS (payload->>'id') STORED NOT NULL,
  parent_id text GENERATED ALWAYS AS (payload->>'parentId') STORED,
  name text GENERATED ALWAYS AS (payload->>'name') STORED NOT NULL,
  PRIMARY KEY (vault_id,id),
  UNIQUE NULLS NOT DISTINCT (vault_id,parent_id,name),
  FOREIGN KEY (vault_id,parent_id) REFERENCES fin_supabase.categories(vault_id,id) DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE fin_supabase.transactions (
  vault_id text NOT NULL REFERENCES fin_supabase.vaults(id),
  payload jsonb NOT NULL,
  id text GENERATED ALWAYS AS (payload->>'id') STORED NOT NULL,
  account_id text GENERATED ALWAYS AS (payload->>'accountId') STORED,
  source_id text GENERATED ALWAYS AS (payload->>'sourceAccountId') STORED,
  destination_id text GENERATED ALWAYS AS (payload->>'destinationAccountId') STORED,
  PRIMARY KEY (vault_id,id),
  FOREIGN KEY (vault_id,account_id) REFERENCES fin_supabase.accounts(vault_id,id),
  FOREIGN KEY (vault_id,source_id) REFERENCES fin_supabase.accounts(vault_id,id),
  FOREIGN KEY (vault_id,destination_id) REFERENCES fin_supabase.accounts(vault_id,id),
  CHECK (payload->>'kind' IN ('income','expense','adjustment','transfer')),
  CHECK ((payload->>'kind'='transfer' AND account_id IS NULL AND source_id IS NOT NULL AND destination_id IS NOT NULL AND source_id<>destination_id)
    OR (payload->>'kind'<>'transfer' AND account_id IS NOT NULL AND source_id IS NULL AND destination_id IS NULL))
);
CREATE TABLE fin_supabase.assignments (
  vault_id text NOT NULL,
  transaction_id text NOT NULL,
  category_id text NOT NULL,
  PRIMARY KEY (vault_id,transaction_id,category_id),
  FOREIGN KEY (vault_id,transaction_id) REFERENCES fin_supabase.transactions(vault_id,id) ON DELETE CASCADE,
  FOREIGN KEY (vault_id,category_id) REFERENCES fin_supabase.categories(vault_id,id)
);
CREATE TABLE fin_supabase.relations (
  vault_id text NOT NULL,
  source_id text NOT NULL,
  target_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('refund_of','fee_for')),
  PRIMARY KEY (vault_id,source_id,target_id,kind),
  FOREIGN KEY (vault_id,source_id) REFERENCES fin_supabase.transactions(vault_id,id) ON DELETE CASCADE,
  FOREIGN KEY (vault_id,target_id) REFERENCES fin_supabase.transactions(vault_id,id) DEFERRABLE INITIALLY DEFERRED,
  CHECK (source_id<>target_id)
);
CREATE TABLE fin_supabase.history (
  vault_id text NOT NULL REFERENCES fin_supabase.vaults(id),
  id text NOT NULL,
  sequence bigint GENERATED ALWAYS AS IDENTITY,
  payload jsonb NOT NULL CHECK (payload->>'id'=id AND payload->>'vaultId'=vault_id),
  PRIMARY KEY (vault_id,id), UNIQUE (sequence)
);

-- Internal catalog attestation. Includes columns, defaults, constraints, indexes,
-- triggers, policies, RLS, ownership, privileges and every fin RPC's full definition.
CREATE FUNCTION fin_supabase.fingerprint() RETURNS text
LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT md5(coalesce(string_agg(value, E'\n' ORDER BY value),'')) FROM (
    SELECT 'schema:' || n.nspname || ':' || n.nspowner || ':' || coalesce(n.nspacl::text,'') AS value
      FROM pg_namespace n WHERE n.nspname='fin_supabase'
    UNION ALL
    SELECT 'relation:' || c.relname || ':' || c.relkind::text || ':' || c.relowner || ':' || c.relrowsecurity || ':' || c.relforcerowsecurity || ':' || coalesce(c.relacl::text,'')
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='fin_supabase'
    UNION ALL
    SELECT 'column:' || c.relname || ':' || a.attnum || ':' || a.attname || ':' || format_type(a.atttypid,a.atttypmod) || ':' || a.attnotnull || ':' || a.attidentity::text || ':' || a.attgenerated::text || ':' || coalesce(pg_get_expr(d.adbin,d.adrelid),'')
      FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
      WHERE n.nspname='fin_supabase' AND a.attnum>0 AND NOT a.attisdropped
    UNION ALL
    SELECT 'constraint:' || c.relname || ':' || x.conname || ':' || pg_get_constraintdef(x.oid)
      FROM pg_constraint x JOIN pg_class c ON c.oid=x.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='fin_supabase'
    UNION ALL
    SELECT 'index:' || indexname || ':' || indexdef FROM pg_indexes WHERE schemaname='fin_supabase'
    UNION ALL
    SELECT 'trigger:' || t.tgname || ':' || pg_get_triggerdef(t.oid) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='fin_supabase' AND NOT t.tgisinternal
    UNION ALL
    SELECT 'policy:' || tablename || ':' || policyname || ':' || coalesce(qual,'') || ':' || coalesce(with_check,'') FROM pg_policies WHERE schemaname='fin_supabase'
    UNION ALL
    SELECT 'function:' || n.nspname || ':' || p.proname || ':' || p.proowner || ':' || coalesce(p.proacl::text,'') || ':' || pg_get_functiondef(p.oid)
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='fin_supabase' OR (n.nspname='public' AND left(p.proname,13)='fin_supabase_')
  ) assets;
$$;

CREATE FUNCTION public.fin_supabase_check_schema() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF (SELECT count(*) FROM fin_supabase.migrations) <> 1 OR NOT EXISTS (
    SELECT FROM fin_supabase.migrations WHERE version=1 AND identity='fin-supabase-v1:e1c7a08a530042615350af6cd5284c4e5c84e5570f341d059ead8b0a5f6accc8'
      AND fingerprint=fin_supabase.fingerprint()
  ) THEN RAISE EXCEPTION USING ERRCODE='PT412', MESSAGE='fin schema incompatible'; END IF;
  RETURN jsonb_build_object('identity','fin-supabase-v1:e1c7a08a530042615350af6cd5284c4e5c84e5570f341d059ead8b0a5f6accc8');
EXCEPTION WHEN undefined_table OR undefined_function OR undefined_column THEN
  RAISE EXCEPTION USING ERRCODE='PT412', MESSAGE='fin schema incomplete';
END;
$$;

-- STABLE functions and the single outer SELECT use one statement snapshot even
-- under READ COMMITTED. No financial decisions or derived balances run in SQL.
CREATE FUNCTION public.fin_supabase_context(p_request jsonb, p_nonce text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_id text := p_request->>'vaultId';
  v_kind text := p_request->>'kind';
  v_guard jsonb := NULL;
  v_vault jsonb := NULL;
  v_vaults jsonb := '[]';
  v_settings jsonb := NULL;
  v_accounts jsonb := '[]';
  v_categories jsonb := '[]';
  v_transactions jsonb := '[]';
  v_records jsonb := '[]';
BEGIN
  PERFORM public.fin_supabase_check_schema();
  IF v_kind='vaults' THEN
    SELECT coalesce(jsonb_agg(payload ORDER BY id),'[]') INTO v_vaults FROM fin_supabase.vaults;
  ELSIF v_kind<>'createVault' THEN
    SELECT payload,jsonb_build_object('generation',generation,'stamp',stamp::text)
      INTO v_vault,v_guard FROM fin_supabase.vaults WHERE id=v_id;
    IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='PT404', MESSAGE='fin vault missing'; END IF;
    SELECT payload INTO STRICT v_settings FROM fin_supabase.settings WHERE vault_id=v_id;
    SELECT coalesce(jsonb_agg(payload ORDER BY id),'[]') INTO v_accounts FROM fin_supabase.accounts WHERE vault_id=v_id;
    SELECT coalesce(jsonb_agg(payload ORDER BY id),'[]') INTO v_categories FROM fin_supabase.categories WHERE vault_id=v_id;
    SELECT coalesce(jsonb_agg(payload ORDER BY payload->>'occurredOn',id),'[]') INTO v_transactions FROM fin_supabase.transactions WHERE vault_id=v_id;
    SELECT coalesce(jsonb_agg(payload ORDER BY sequence),'[]') INTO v_records FROM fin_supabase.history WHERE vault_id=v_id;
  END IF;
  RETURN jsonb_build_object('identity','fin-supabase-v1:e1c7a08a530042615350af6cd5284c4e5c84e5570f341d059ead8b0a5f6accc8','nonce',p_nonce,'kind',v_kind,'vaultId',v_id,'guard',v_guard,
    'counts',jsonb_build_object('vaults',jsonb_array_length(v_vaults),'accounts',jsonb_array_length(v_accounts),'categories',jsonb_array_length(v_categories),'transactions',jsonb_array_length(v_transactions),'records',jsonb_array_length(v_records)),
    'context',jsonb_build_object('vault',v_vault,'vaults',v_vaults,'settings',v_settings,'accounts',v_accounts,'categories',v_categories,'transactions',v_transactions,'records',v_records));
END;
$$;

CREATE FUNCTION public.fin_supabase_commit(p_request jsonb, p_guard jsonb, p_changes jsonb, p_record jsonb, p_nonce text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_id text := p_record->>'vaultId';
  v_root fin_supabase.vaults;
  v_item jsonb;
  v_child jsonb;
  v_count bigint;
BEGIN
  PERFORM public.fin_supabase_check_schema();
  IF v_id IS NULL OR (p_changes ? 'vault' AND p_changes->'vault'->>'id' IS DISTINCT FROM v_id)
    OR (p_request->>'kind' IS DISTINCT FROM 'createVault' AND p_request->>'vaultId' IS DISTINCT FROM v_id)
    OR p_guard->>'generation' IS NULL OR p_guard->>'stamp' IS NULL THEN
    RAISE EXCEPTION USING ERRCODE='PT400', MESSAGE='fin invalid scope';
  END IF;
  IF p_request->>'kind'='createVault' THEN
    IF NOT (p_changes ? 'vault' AND p_changes ? 'settings') OR p_guard->>'stamp'<>'0' THEN
      RAISE EXCEPTION USING ERRCODE='PT400', MESSAGE='fin invalid creation';
    END IF;
    INSERT INTO fin_supabase.vaults(id,payload,generation,stamp) VALUES (v_id,p_changes->'vault',p_guard->>'generation',0);
  END IF;
  SELECT * INTO v_root FROM fin_supabase.vaults WHERE id=v_id FOR UPDATE;
  IF NOT FOUND OR v_root.generation IS DISTINCT FROM p_guard->>'generation' OR v_root.stamp::text IS DISTINCT FROM p_guard->>'stamp' THEN
    -- Raising, rather than relying on UPDATE row counts, aborts the entire plan.
    RAISE EXCEPTION USING ERRCODE='PT409', MESSAGE='fin stale vault guard';
  END IF;
  IF p_changes ? 'vault' THEN UPDATE fin_supabase.vaults SET payload=p_changes->'vault' WHERE id=v_id; END IF;
  FOR v_item IN SELECT value FROM jsonb_array_elements(coalesce(p_changes->'accounts','[]')) LOOP
    INSERT INTO fin_supabase.accounts(vault_id,payload) VALUES (v_id,v_item-'balanceMinor')
      ON CONFLICT (vault_id,id) DO UPDATE SET payload=excluded.payload;
  END LOOP;
  IF p_changes ? 'settings' THEN
    INSERT INTO fin_supabase.settings(vault_id,payload) VALUES (v_id,p_changes->'settings')
      ON CONFLICT (vault_id) DO UPDATE SET payload=excluded.payload;
  END IF;
  FOR v_item IN SELECT value FROM jsonb_array_elements(coalesce(p_changes->'categories','[]')) LOOP
    INSERT INTO fin_supabase.categories(vault_id,payload) VALUES (v_id,v_item-'path')
      ON CONFLICT (vault_id,id) DO UPDATE SET payload=excluded.payload;
  END LOOP;
  -- Insert all referenced transactions before their assignment/relation edges.
  FOR v_item IN SELECT value FROM jsonb_array_elements(coalesce(p_changes->'transactions','[]')) LOOP
    INSERT INTO fin_supabase.transactions(vault_id,payload) VALUES (v_id,v_item)
      ON CONFLICT (vault_id,id) DO UPDATE SET payload=excluded.payload;
  END LOOP;
  FOR v_item IN SELECT value FROM jsonb_array_elements(coalesce(p_changes->'transactions','[]')) LOOP
    DELETE FROM fin_supabase.assignments WHERE vault_id=v_id AND transaction_id=v_item->>'id';
    DELETE FROM fin_supabase.relations WHERE vault_id=v_id AND source_id=v_item->>'id';
    FOR v_child IN SELECT value FROM jsonb_array_elements(v_item->'assignments') LOOP
      INSERT INTO fin_supabase.assignments VALUES (v_id,v_item->>'id',v_child->>'categoryId');
    END LOOP;
    FOR v_child IN SELECT value FROM jsonb_array_elements(v_item->'relations') LOOP
      INSERT INTO fin_supabase.relations VALUES (v_id,v_item->>'id',v_child->>'targetTransactionId',v_child->>'kind');
    END LOOP;
  END LOOP;
  IF p_changes ? 'deleteTransactionId' THEN
    DELETE FROM fin_supabase.transactions WHERE vault_id=v_id AND id=p_changes->>'deleteTransactionId';
    GET DIAGNOSTICS v_count = ROW_COUNT;
    IF v_count<>1 THEN RAISE EXCEPTION USING ERRCODE='PT409', MESSAGE='fin deletion missing'; END IF;
  END IF;
  -- The supplied record is stored verbatim as JSON, never reconstructed from SQL.
  INSERT INTO fin_supabase.history(vault_id,id,payload) VALUES (v_id,p_record->>'id',p_record);
  UPDATE fin_supabase.vaults SET stamp=stamp+1 WHERE id=v_id RETURNING * INTO v_root;
  RETURN jsonb_build_object('identity','fin-supabase-v1:e1c7a08a530042615350af6cd5284c4e5c84e5570f341d059ead8b0a5f6accc8','nonce',p_nonce,'vaultId',v_id,'recordId',p_record->>'id','generation',v_root.generation,'stamp',v_root.stamp::text);
END;
$$;

-- Tables are private. Only the three bounded RPCs are callable by service_role.
-- Secret keys map to service_role at the hosted gateway; no user-JWT profile.
REVOKE ALL ON ALL TABLES IN SCHEMA fin_supabase FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA fin_supabase FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA fin_supabase FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fin_supabase_check_schema() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fin_supabase_context(jsonb,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fin_supabase_commit(jsonb,jsonb,jsonb,jsonb,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fin_supabase_check_schema(), public.fin_supabase_context(jsonb,text), public.fin_supabase_commit(jsonb,jsonb,jsonb,jsonb,text) TO service_role;
INSERT INTO fin_supabase.migrations VALUES (1,'fin-supabase-v1:e1c7a08a530042615350af6cd5284c4e5c84e5570f341d059ead8b0a5f6accc8',fin_supabase.fingerprint());
NOTIFY pgrst, 'reload schema';
COMMIT;
