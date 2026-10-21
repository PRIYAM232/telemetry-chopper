"use client";

// The rate-card form. A client component so savePricing's validation errors
// render inline via useActionState, and so the vendor-name input can appear
// only for a custom vendor.
//
// Submitted through onSubmit rather than <form action>, like the dashboard's
// CreateRuleForm: React resets a form after every action it runs, which would
// wipe a rejected price the operator needs to fix. Nothing resets here — the
// saved values are exactly what's in the inputs.

import { startTransition, useActionState, useState } from "react";
import { ObservabilityVendor } from "@/generated/prisma/enums";
import { Field, inputClass } from "@/app/dashboard/form-ui";
import type { RateCard } from "@/lib/pricing";
import { savePricing, type SavePricingState } from "./actions";

const initialState: SavePricingState = { error: null, savedAt: null };

const PRICE_FIELDS = [
  { name: "logsPricePerGb", label: "Logs", key: "logsPricePerGb" },
  { name: "tracesPricePerGb", label: "Traces (spans)", key: "tracesPricePerGb" },
  { name: "metricsPricePerGb", label: "Metrics", key: "metricsPricePerGb" },
] as const;

// Split-metric pricing: indexing billed per million events on top of ingest.
// Metrics aren't indexed events, so they have no field here.
const INDEX_PRICE_FIELDS = [
  { name: "logsIndexPricePerMillion", label: "Indexed log events", key: "logsIndexPricePerMillion" },
  { name: "tracesIndexPricePerMillion", label: "Indexed spans", key: "tracesIndexPricePerMillion" },
] as const;

export function PricingForm({
  fleetId,
  card,
  vendorLabels,
}: {
  fleetId: string;
  card: RateCard;
  vendorLabels: Record<ObservabilityVendor, string>;
}) {
  const [state, formAction, pending] = useActionState(savePricing, initialState);
  const [vendor, setVendor] = useState<string>(card.vendor ?? "");

  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    startTransition(() => formAction(formData));
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-5">
      <input type="hidden" name="fleetId" value={fleetId} />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Observability vendor">
          <select
            name="vendor"
            required
            value={vendor}
            onChange={(e) => setVendor(e.target.value)}
            className={inputClass}
          >
            <option value="" disabled>
              Select a vendor…
            </option>
            {Object.values(ObservabilityVendor).map((v) => (
              <option key={v} value={v}>
                {vendorLabels[v]}
              </option>
            ))}
          </select>
        </Field>
        {vendor === ObservabilityVendor.CUSTOM && (
          <Field label="Vendor name">
            <input
              name="customVendorName"
              required
              maxLength={64}
              defaultValue={card.customVendorName ?? ""}
              placeholder="Grafana Cloud"
              className={inputClass}
            />
          </Field>
        )}
      </div>

      <fieldset className="flex flex-col gap-3">
        <legend className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
          Ingest price, USD per GB
        </legend>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          {PRICE_FIELDS.map((f) => (
            <Field key={f.name} label={f.label}>
              <div className="relative">
                <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-sm text-zinc-400">
                  $
                </span>
                <input
                  name={f.name}
                  required
                  inputMode="decimal"
                  pattern="\d{1,6}(\.\d{1,4})?"
                  title="USD per GB, up to 4 decimal places (e.g. 0.10)"
                  defaultValue={String(card[f.key])}
                  className={`${inputClass} pl-7 tabular-nums`}
                />
              </div>
            </Field>
          ))}
        </div>
        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          Use the rate from your contract. A signal your vendor doesn&apos;t bill
          per GB can be set to 0. If your vendor bills metrics per series, as
          Datadog does, set metrics to 0 here and use the series price below.
        </p>
      </fieldset>

      <fieldset className="flex flex-col gap-3">
        <legend className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
          Indexing price, USD per million events
        </legend>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          {INDEX_PRICE_FIELDS.map((f) => (
            <Field key={f.name} label={f.label}>
              <div className="relative">
                <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-sm text-zinc-400">
                  $
                </span>
                <input
                  name={f.name}
                  required
                  inputMode="decimal"
                  pattern="\d{1,6}(\.\d{1,4})?"
                  title="USD per million indexed events, up to 4 decimal places (e.g. 2.04)"
                  defaultValue={String(card[f.key])}
                  className={`${inputClass} pl-7 tabular-nums`}
                />
              </div>
            </Field>
          ))}
        </div>
        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          For vendors that bill search indexing separately from ingest (split-metric
          pricing). Dropped records save both ingest and indexing; records an
          EXCLUDE_INDEX rule keeps out of the index save indexing only. Leave 0 if your
          vendor doesn&apos;t bill indexing separately.
        </p>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          {(
            [
              ["tracesIndexedSharePct", "Spans indexed, %"],
              ["logsIndexedSharePct", "Log events indexed, %"],
            ] as const
          ).map(([name, label]) => (
            <Field key={name} label={label}>
              <input
                name={name}
                inputMode="decimal"
                pattern="\d{1,3}(\.\d{1,2})?"
                title="Percent of ingested events your vendor indexes, from 0 to 100 (e.g. 5)"
                defaultValue={String(card[name])}
                className={`${inputClass} tabular-nums`}
              />
            </Field>
          ))}
        </div>
        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          The share of ingested events your vendor would index without Telemetry Chopper.
          Datadog indexes spans only through retention filters, usually a small sample:
          divide <code>datadog.estimated_usage.apm.indexed_spans</code> by{" "}
          <code>datadog.estimated_usage.apm.ingested_spans</code> over a month. Logs are
          usually 100% unless index exclusion filters already drop some.
          Dropped and excluded events save indexing only at this rate.
        </p>
      </fieldset>

      <fieldset className="flex flex-col gap-3">
        <legend className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
          Metric series price, USD per 100 series per month
        </legend>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Field label="Metric series">
            <div className="relative">
              <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-sm text-zinc-400">
                $
              </span>
              <input
                name="metricsPricePer100Series"
                required
                inputMode="decimal"
                pattern="\d{1,6}(\.\d{1,4})?"
                title="USD per 100 metric series per month, up to 4 decimal places (e.g. 5.00)"
                defaultValue={String(card.metricsPricePer100Series)}
                className={`${inputClass} pl-7 tabular-nums`}
              />
            </div>
          </Field>
        </div>
        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          For vendors that bill custom metrics by series (a metric name plus one
          combination of tag values) instead of by volume, such as Datadog. A series
          your rules drop entirely saves its share of this price for every hour it
          stays dropped. Leave 0 if your vendor doesn&apos;t bill metrics by series.
        </p>
      </fieldset>

      <fieldset className="flex flex-col gap-3">
        <legend className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
          Included span allowance per month
        </legend>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Field label="Ingested spans, GB">
            <input
              name="tracesIncludedGbPerMonth"
              inputMode="decimal"
              pattern="\d{1,11}(\.\d{1,3})?"
              title="GB of ingested spans included per month, up to 3 decimal places (e.g. 1500)"
              defaultValue={String(card.tracesIncludedGbPerMonth)}
              className={`${inputClass} tabular-nums`}
            />
          </Field>
          <Field label="Indexed spans, millions">
            <input
              name="tracesIncludedIndexedMillionsPerMonth"
              inputMode="decimal"
              pattern="\d{1,11}(\.\d{1,3})?"
              title="Millions of indexed spans included per month, up to 3 decimal places (e.g. 10)"
              defaultValue={String(card.tracesIncludedIndexedMillionsPerMonth)}
              className={`${inputClass} tabular-nums`}
            />
          </Field>
        </div>
        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          Span volume your plan includes each month before ingest and indexing are
          billed. Datadog includes 150 GB of ingested spans and 1 million indexed spans
          per APM host (30 GB and 195,000 per Fargate task), pooled across your account:
          with 10 APM hosts, enter 1500 and 10. Dropped spans only save money above the
          allowance. Leave 0 if your plan has none.
        </p>
      </fieldset>

      {state.error && (
        <p
          role="alert"
          className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs break-words text-rose-700 dark:border-rose-900 dark:bg-rose-950 dark:text-rose-400"
        >
          {state.error}
        </p>
      )}
      {state.error === null && state.savedAt !== null && !pending && (
        <p
          role="status"
          className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-400"
        >
          Rate card saved. The dashboard&apos;s savings now use these prices.
        </p>
      )}

      <button
        type="submit"
        disabled={pending}
        className="self-start rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white transition-opacity hover:bg-zinc-700 disabled:cursor-wait disabled:opacity-40 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-300"
      >
        Save rate card
      </button>
    </form>
  );
}
