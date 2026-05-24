/**
 * /api/billing/fee-schedules
 *
 * Admin surface for the contracted fee schedule that drives the
 * Underpayments workqueue. Each row pegs an `allowed_amount` to a
 * (payer contract, CPT/HCPCS, modifiers, place_of_service, effective
 * window) tuple. The Underpayments worker looks these up via
 * `pickFeeSchedule()` to flag ERA lines paid below contract.
 *
 *   GET    — list active rows for the org, with optional filter `q`
 *            (matches procedure code, schedule name, payer name).
 *   POST   — create a new fee schedule row, or bulk-create rows from
 *            a CSV body (`{ csv: "...payer,cpt,modifiers,allowed..." }`).
 *   PATCH  — update an existing row by id.
 *   DELETE — soft-archive a row by id.
 */
import { NextResponse } from "next/server";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import { requireBillingAccess } from "@/lib/billing/requireBillingAccess";

const text = (v: unknown) => String(v ?? "").trim();
const money = (v: unknown) => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
};

interface FeeRowOut {
  id: string;
  organizationId: string;
  payerContractId: string | null;
  payerProfileId: string | null;
  payerName: string | null;
  contractName: string | null;
  scheduleName: string;
  procedureCode: string;
  modifiers: string[];
  placeOfService: string | null;
  allowedAmount: number;
  billedRate: number | null;
  effectiveDate: string | null;
  expirationDate: string | null;
  notes: string | null;
  updatedAt: string | null;
}

function mapRow(
  r: any,
  contractIndex: Map<string, { name: string; payerProfileId: string | null }>,
  payerIndex: Map<string, string>,
): FeeRowOut {
  const contractId = text(r.payer_contract_id) || null;
  const contract = contractId ? contractIndex.get(contractId) ?? null : null;
  const payerProfileId = contract?.payerProfileId ?? null;
  return {
    id: text(r.id),
    organizationId: text(r.organization_id),
    payerContractId: contractId,
    payerProfileId,
    payerName: payerProfileId ? payerIndex.get(payerProfileId) ?? null : null,
    contractName: contract?.name ?? null,
    scheduleName: text(r.schedule_name),
    procedureCode: text(r.procedure_code).toUpperCase(),
    modifiers: Array.isArray(r.modifiers)
      ? (r.modifiers as unknown[]).map((m) => String(m).toUpperCase())
      : [],
    placeOfService: text(r.place_of_service) || null,
    allowedAmount: Number(r.allowed_amount ?? 0),
    billedRate: r.billed_rate == null ? null : Number(r.billed_rate),
    effectiveDate: text(r.effective_date) || null,
    expirationDate: text(r.expiration_date) || null,
    notes: text(r.notes) || null,
    updatedAt: text(r.updated_at) || null,
  };
}

async function loadContractIndex(supabase: any, organizationId: string) {
  const { data: contracts } = await supabase
    .from("payer_contracts")
    .select("id, contract_name, payer_profile_id")
    .eq("organization_id", organizationId)
    .is("archived_at", null);
  const { data: payers } = await supabase
    .from("payer_profiles")
    .select("id, payer_name")
    .eq("organization_id", organizationId);
  const payerIndex = new Map<string, string>(
    ((payers as any[]) ?? []).map((p) => [text(p.id), text(p.payer_name)]),
  );
  const contractIndex = new Map<
    string,
    { name: string; payerProfileId: string | null }
  >(
    ((contracts as any[]) ?? []).map((c) => [
      text(c.id),
      {
        name: text(c.contract_name) || "Unnamed contract",
        payerProfileId: text(c.payer_profile_id) || null,
      },
    ]),
  );
  return { contractIndex, payerIndex };
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const guard = await requireBillingAccess({
      requestedOrganizationId: searchParams.get("organizationId"),
    });
    if (guard instanceof NextResponse) return guard;
    const organizationId = guard.organizationId;

    const supabase = createServerSupabaseAdminClient();
    if (!supabase) {
      return NextResponse.json(
        { success: false, error: "Database not available" },
        { status: 500 },
      );
    }

    const q = text(searchParams.get("q")).toLowerCase();

    const { contractIndex, payerIndex } = await loadContractIndex(
      supabase,
      organizationId,
    );

    const { data, error } = await (supabase as any)
      .from("fee_schedules")
      .select(
        "id, organization_id, payer_contract_id, schedule_name, procedure_code, modifiers, place_of_service, allowed_amount, billed_rate, effective_date, expiration_date, notes, updated_at",
      )
      .eq("organization_id", organizationId)
      .is("archived_at", null)
      .order("procedure_code", { ascending: true })
      .order("updated_at", { ascending: false })
      .limit(2000);
    if (error) {
      return NextResponse.json(
        { success: false, error: error.message },
        { status: 422 },
      );
    }

    let rows = ((data as any[]) ?? []).map((r) =>
      mapRow(r, contractIndex, payerIndex),
    );
    if (q) {
      rows = rows.filter((r) =>
        [
          r.procedureCode,
          r.scheduleName,
          r.payerName ?? "",
          r.contractName ?? "",
          r.modifiers.join(" "),
          r.notes ?? "",
        ]
          .join(" ")
          .toLowerCase()
          .includes(q),
      );
    }

    const contractOptions = Array.from(contractIndex.entries()).map(
      ([id, c]) => ({
        id,
        name: c.name,
        payerProfileId: c.payerProfileId,
        payerName: c.payerProfileId
          ? payerIndex.get(c.payerProfileId) ?? null
          : null,
      }),
    );
    const payerOptions = Array.from(payerIndex.entries()).map(([id, name]) => ({
      id,
      name,
    }));

    return NextResponse.json({
      success: true,
      organizationId,
      rows,
      contracts: contractOptions,
      payers: payerOptions,
    });
  } catch (e) {
    return NextResponse.json(
      { success: false, error: e instanceof Error ? e.message : "Failed" },
      { status: 500 },
    );
  }
}

interface PostBody {
  organizationId?: string;
  payerContractId?: string | null;
  scheduleName?: string;
  procedureCode?: string;
  modifiers?: string[] | string;
  placeOfService?: string | null;
  allowedAmount?: number | string;
  billedRate?: number | string | null;
  effectiveDate?: string | null;
  expirationDate?: string | null;
  notes?: string | null;
  // bulk
  csv?: string;
  defaultContractId?: string | null;
}

function parseModifiers(input: unknown): string[] {
  if (Array.isArray(input)) {
    return input
      .map((m) => String(m ?? "").trim().toUpperCase())
      .filter(Boolean);
  }
  if (typeof input === "string") {
    return input
      .split(/[,\s]+/)
      .map((m) => m.trim().toUpperCase())
      .filter(Boolean);
  }
  return [];
}

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else if (c === '"') {
        inQ = false;
      } else {
        cur += c;
      }
    } else if (c === '"') {
      inQ = true;
    } else if (c === ",") {
      out.push(cur);
      cur = "";
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as PostBody;
    const guard = await requireBillingAccess({
      requestedOrganizationId: body.organizationId ?? null,
    });
    if (guard instanceof NextResponse) return guard;
    const organizationId = guard.organizationId;

    const supabase = createServerSupabaseAdminClient();
    if (!supabase) {
      return NextResponse.json(
        { success: false, error: "Database not available" },
        { status: 500 },
      );
    }

    // ── Bulk CSV ─────────────────────────────────────────────────────
    if (typeof body.csv === "string" && body.csv.trim()) {
      const lines = body.csv
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith("#"));
      if (lines.length === 0) {
        return NextResponse.json(
          { success: false, error: "CSV body is empty" },
          { status: 400 },
        );
      }

      const header = parseCsvLine(lines[0]).map((h) => h.toLowerCase());
      const dataLines = lines.slice(1);
      const colIdx = (...names: string[]) =>
        header.findIndex((h) => names.includes(h));
      const iCpt = colIdx("cpt", "procedure_code", "code");
      const iAllowed = colIdx("allowed", "allowed_amount", "rate");
      const iMods = colIdx("modifiers", "modifier", "mods");
      const iPos = colIdx("place_of_service", "pos");
      const iSchedule = colIdx("schedule", "schedule_name", "name");
      const iContract = colIdx("contract_id", "payer_contract_id");
      const iEff = colIdx("effective", "effective_date");
      const iExp = colIdx("expiration", "expiration_date");
      const iBilled = colIdx("billed", "billed_rate");
      const iNotes = colIdx("notes");

      if (iCpt < 0 || iAllowed < 0) {
        return NextResponse.json(
          {
            success: false,
            error:
              "CSV header must include at least `cpt` and `allowed_amount` columns",
          },
          { status: 400 },
        );
      }

      const defaultContractId = text(body.defaultContractId) || null;
      const rows: Array<Record<string, unknown>> = [];
      const errors: Array<{ line: number; error: string }> = [];

      dataLines.forEach((line, idx) => {
        const cells = parseCsvLine(line);
        const cpt = text(cells[iCpt]).toUpperCase();
        const allowed = money(cells[iAllowed]);
        if (!cpt) {
          errors.push({ line: idx + 2, error: "missing cpt" });
          return;
        }
        if (allowed == null) {
          errors.push({ line: idx + 2, error: "invalid allowed_amount" });
          return;
        }
        rows.push({
          organization_id: organizationId,
          payer_contract_id:
            (iContract >= 0 ? text(cells[iContract]) : "") ||
            defaultContractId,
          schedule_name:
            (iSchedule >= 0 ? text(cells[iSchedule]) : "") ||
            `Imported ${new Date().toISOString().slice(0, 10)}`,
          procedure_code: cpt,
          modifiers: iMods >= 0 ? parseModifiers(cells[iMods]) : [],
          place_of_service:
            (iPos >= 0 ? text(cells[iPos]) : "") || null,
          allowed_amount: allowed,
          billed_rate: iBilled >= 0 ? money(cells[iBilled]) : null,
          effective_date:
            (iEff >= 0 ? text(cells[iEff]) : "") || null,
          expiration_date:
            (iExp >= 0 ? text(cells[iExp]) : "") || null,
          notes: (iNotes >= 0 ? text(cells[iNotes]) : "") || null,
        });
      });

      if (rows.length === 0) {
        return NextResponse.json(
          { success: false, error: "No valid rows parsed", errors },
          { status: 400 },
        );
      }

      const { data: inserted, error: insErr } = await (supabase as any)
        .from("fee_schedules")
        .insert(rows)
        .select("id");
      if (insErr) {
        return NextResponse.json(
          { success: false, error: insErr.message, errors },
          { status: 422 },
        );
      }

      await (supabase as any)
        .from("audit_logs")
        .insert({
          organization_id: organizationId,
          user_id: guard.userId,
          event_type: "fee_schedule.bulk_import",
          event_summary: `Bulk-imported ${rows.length} fee schedule rows`,
          event_metadata: {
            inserted: ((inserted as any[]) ?? []).length,
            skipped: errors.length,
            errors: errors.slice(0, 20),
          },
          action: "create",
          object_type: "fee_schedule",
          object_id: null,
        })
        .then(() => undefined, () => undefined);

      return NextResponse.json({
        success: true,
        inserted: ((inserted as any[]) ?? []).length,
        skipped: errors.length,
        errors,
      });
    }

    // ── Single row insert ─────────────────────────────────────────────
    const procedureCode = text(body.procedureCode).toUpperCase();
    const allowed = money(body.allowedAmount);
    if (!procedureCode) {
      return NextResponse.json(
        { success: false, error: "procedureCode is required" },
        { status: 400 },
      );
    }
    if (allowed == null || allowed < 0) {
      return NextResponse.json(
        { success: false, error: "allowedAmount (>= 0) is required" },
        { status: 400 },
      );
    }

    const insert = {
      organization_id: organizationId,
      payer_contract_id: text(body.payerContractId) || null,
      schedule_name:
        text(body.scheduleName) ||
        `Fee schedule ${new Date().toISOString().slice(0, 10)}`,
      procedure_code: procedureCode,
      modifiers: parseModifiers(body.modifiers),
      place_of_service: text(body.placeOfService) || null,
      allowed_amount: allowed,
      billed_rate: money(body.billedRate),
      effective_date: text(body.effectiveDate) || null,
      expiration_date: text(body.expirationDate) || null,
      notes: text(body.notes) || null,
    };

    const { data, error } = await (supabase as any)
      .from("fee_schedules")
      .insert(insert)
      .select("id")
      .single();
    if (error) {
      return NextResponse.json(
        { success: false, error: error.message },
        { status: 422 },
      );
    }

    await (supabase as any)
      .from("audit_logs")
      .insert({
        organization_id: organizationId,
        user_id: guard.userId,
        event_type: "fee_schedule.create",
        event_summary: `Added fee schedule for ${procedureCode}`,
        event_metadata: { ...insert, id: (data as any)?.id },
        action: "create",
        object_type: "fee_schedule",
        object_id: text((data as any)?.id),
      })
      .then(() => undefined, () => undefined);

    return NextResponse.json({ success: true, id: (data as any)?.id });
  } catch (e) {
    return NextResponse.json(
      { success: false, error: e instanceof Error ? e.message : "Failed" },
      { status: 500 },
    );
  }
}

interface PatchBody extends PostBody {
  id?: string;
}

export async function PATCH(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as PatchBody;
    const guard = await requireBillingAccess({
      requestedOrganizationId: body.organizationId ?? null,
    });
    if (guard instanceof NextResponse) return guard;
    const organizationId = guard.organizationId;

    const id = text(body.id);
    if (!id) {
      return NextResponse.json(
        { success: false, error: "id is required" },
        { status: 400 },
      );
    }

    const supabase = createServerSupabaseAdminClient();
    if (!supabase) {
      return NextResponse.json(
        { success: false, error: "Database not available" },
        { status: 500 },
      );
    }

    const patch: Record<string, unknown> = {
      updated_at: new Date().toISOString(),
    };
    if (body.payerContractId !== undefined)
      patch.payer_contract_id = text(body.payerContractId) || null;
    if (body.scheduleName !== undefined)
      patch.schedule_name = text(body.scheduleName);
    if (body.procedureCode !== undefined)
      patch.procedure_code = text(body.procedureCode).toUpperCase();
    if (body.modifiers !== undefined)
      patch.modifiers = parseModifiers(body.modifiers);
    if (body.placeOfService !== undefined)
      patch.place_of_service = text(body.placeOfService) || null;
    if (body.allowedAmount !== undefined) {
      const m = money(body.allowedAmount);
      if (m == null || m < 0) {
        return NextResponse.json(
          { success: false, error: "allowedAmount must be >= 0" },
          { status: 400 },
        );
      }
      patch.allowed_amount = m;
    }
    if (body.billedRate !== undefined) patch.billed_rate = money(body.billedRate);
    if (body.effectiveDate !== undefined)
      patch.effective_date = text(body.effectiveDate) || null;
    if (body.expirationDate !== undefined)
      patch.expiration_date = text(body.expirationDate) || null;
    if (body.notes !== undefined) patch.notes = text(body.notes) || null;

    const { data, error } = await (supabase as any)
      .from("fee_schedules")
      .update(patch)
      .eq("id", id)
      .eq("organization_id", organizationId)
      .is("archived_at", null)
      .select("id")
      .maybeSingle();
    if (error) {
      return NextResponse.json(
        { success: false, error: error.message },
        { status: 422 },
      );
    }
    if (!data) {
      return NextResponse.json(
        { success: false, error: "Fee schedule not found" },
        { status: 404 },
      );
    }

    await (supabase as any)
      .from("audit_logs")
      .insert({
        organization_id: organizationId,
        user_id: guard.userId,
        event_type: "fee_schedule.update",
        event_summary: `Updated fee schedule ${id}`,
        event_metadata: { id, patch },
        action: "update",
        object_type: "fee_schedule",
        object_id: id,
      })
      .then(() => undefined, () => undefined);

    return NextResponse.json({ success: true });
  } catch (e) {
    return NextResponse.json(
      { success: false, error: e instanceof Error ? e.message : "Failed" },
      { status: 500 },
    );
  }
}

export async function DELETE(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const guard = await requireBillingAccess({
      requestedOrganizationId: searchParams.get("organizationId"),
    });
    if (guard instanceof NextResponse) return guard;
    const organizationId = guard.organizationId;

    const id = text(searchParams.get("id"));
    if (!id) {
      return NextResponse.json(
        { success: false, error: "id is required" },
        { status: 400 },
      );
    }

    const supabase = createServerSupabaseAdminClient();
    if (!supabase) {
      return NextResponse.json(
        { success: false, error: "Database not available" },
        { status: 500 },
      );
    }

    const { error } = await (supabase as any)
      .from("fee_schedules")
      .update({
        archived_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", id)
      .eq("organization_id", organizationId)
      .is("archived_at", null);
    if (error) {
      return NextResponse.json(
        { success: false, error: error.message },
        { status: 422 },
      );
    }

    await (supabase as any)
      .from("audit_logs")
      .insert({
        organization_id: organizationId,
        user_id: guard.userId,
        event_type: "fee_schedule.archive",
        event_summary: `Archived fee schedule ${id}`,
        event_metadata: { id },
        action: "delete",
        object_type: "fee_schedule",
        object_id: id,
      })
      .then(() => undefined, () => undefined);

    return NextResponse.json({ success: true });
  } catch (e) {
    return NextResponse.json(
      { success: false, error: e instanceof Error ? e.message : "Failed" },
      { status: 500 },
    );
  }
}
