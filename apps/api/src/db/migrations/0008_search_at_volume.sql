-- Phase 8 load test: global name search had p95 5.4 s at 1M customers with the GIN trigram
-- index alone (it can filter but not rank). A GiST trigram index serves "nearest names first"
-- (ORDER BY term <<-> full_name LIMIT n) straight from the index; branch_id first so a branch-scoped user's search uses it too.
CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE INDEX IF NOT EXISTS customers_name_trgm_gist ON customers USING gist (branch_id, full_name gist_trgm_ops);

