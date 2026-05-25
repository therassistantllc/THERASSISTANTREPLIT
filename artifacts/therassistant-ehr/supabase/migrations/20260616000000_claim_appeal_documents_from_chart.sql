-- Task #584: Let billers attach existing chart documents to an appeal in one
-- click. We add a nullable source_document_id pointer so a row in
-- claim_appeal_documents can either (a) own an uploaded file in its own
-- storage object (legacy path) or (b) reference a chart document
-- (public.documents) and reuse the same storage object.
--
-- Linked rows must not delete the underlying chart file when the appeal
-- attachment is removed; the route layer enforces that based on the presence
-- of source_document_id.

alter table public.claim_appeal_documents
  add column if not exists source_document_id uuid
    references public.documents(id) on delete set null;

create index if not exists idx_claim_appeal_documents_source_doc
  on public.claim_appeal_documents (source_document_id)
  where source_document_id is not null;

notify pgrst, 'reload schema';
