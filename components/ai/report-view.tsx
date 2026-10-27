'use client';

// ─────────────────────────────────────────────────────────────────────────────
// One detailed report, laid out: its key figures, its chart, the rows behind
// it, and what stands out — the infographic under an answer.
//
// Three sizes of the same thing. Compact fits the corner panel; full sits in
// the conversation on the assistant's page; the sheet is the expanded view and
// the downloaded image. Nothing here fetches or charges — it draws a report.
// ─────────────────────────────────────────────────────────────────────────────

import { useState, type ReactNode } from 'react';
import {
  ArrowDownRight, ArrowUpRight, ChartColumnBig, CircleCheck, Lightbulb, Minus, Table2, TriangleAlert,
} from 'lucide-react';
import { formatCell, formatFigure, type AiReport, type ReportKpi, type ReportTable } from '@/lib/ai/reports';
import { cn } from '@/lib/utils';
import { ChartTable, ReportChartView } from './report-chart';

export type ReportVariant = 'compact' | 'full' | 'sheet';

const ROWS: Record<ReportVariant, number> = { compact: 4, full: 8, sheet: 12 };
const CHART_HEIGHT: Record<ReportVariant, number> = { compact: 170, full: 230, sheet: 300 };

/** Direction by icon and sign first, colour second — never colour alone. */
function Delta({ change }: { change: NonNullable<ReportKpi['change']> }) {
  const { pct, upIsGood, against } = change;
  if (pct === null) return <p className="mt-0.5 truncate text-[11px] text-muted-foreground">No earlier figure to compare</p>;
  const Icon = pct === 0 ? Minus : pct > 0 ? ArrowUpRight : ArrowDownRight;
  const good = pct === 0 ? null : pct > 0 === upIsGood;
  return (
    <p className="mt-0.5 flex min-w-0 items-center gap-1 text-[11px]" title={`Against ${against}`}>
      <span
        className={cn(
          'inline-flex shrink-0 items-center gap-0.5 font-medium',
          good === null ? 'text-muted-foreground' : good ? 'text-emerald-700 dark:text-emerald-400' : 'text-red-700 dark:text-red-400',
        )}
      >
        <Icon className="size-3" aria-hidden />
        {`${pct > 0 ? '+' : ''}${pct.toFixed(1)}%`}
      </span>
      <span className="truncate text-muted-foreground">vs the period before</span>
    </p>
  );
}

function Kpi({ k }: { k: ReportKpi }) {
  const Icon = k.tone === 'good' ? CircleCheck : k.tone ? TriangleAlert : null;
  return (
    <div className="min-w-0 rounded-md border bg-background/60 px-3 py-2.5" data-slot="ai-report-kpi" data-tone={k.tone}>
      <p className="flex min-w-0 items-center gap-1 text-[11px] font-medium text-muted-foreground">
        {Icon && (
          <Icon
            className={cn('size-3 shrink-0', k.tone === 'good' ? 'text-success' : k.tone === 'bad' ? 'text-destructive' : 'text-warning')}
            aria-label={k.tone === 'good' ? 'Healthy' : k.tone === 'bad' ? 'Needs action' : 'Worth a look'}
          />
        )}
        <span className="truncate">{k.label}</span>
      </p>
      {/* Proportional figures: equal-width digits look loose at this size. */}
      <p className="mt-1 truncate text-lg font-semibold leading-tight" title={formatFigure(k.value, k.unit)}>
        {formatFigure(k.value, k.unit)}
        {k.side && <span className="ml-1 text-xs font-medium text-muted-foreground">{k.side}</span>}
      </p>
      {k.change ? <Delta change={k.change} /> : k.note ? <p className="mt-0.5 truncate text-[11px] text-muted-foreground">{k.note}</p> : null}
    </div>
  );
}

function DetailTable({ table, limit, still }: { table: ReportTable; limit: number; still: boolean }) {
  const [all, setAll] = useState(false);
  const rows = all ? table.rows : table.rows.slice(0, limit);
  const hidden = table.rows.length - rows.length;
  return (
    <div className="space-y-1.5">
      <div className="overflow-x-auto rounded-md border thin-scroll" data-slot="ai-report-table">
        <table className="w-full text-xs">
          <thead className="bg-muted/40">
            <tr>
              {table.columns.map((c) => (
                <th key={c.label} className={cn('whitespace-nowrap px-2.5 py-1.5 font-medium text-muted-foreground', c.unit ? 'text-right' : 'text-left')}>
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className="border-t">
                {r.map((v, j) => {
                  const unit = table.columns[j]?.unit;
                  return (
                    <td key={j} className={cn('px-2.5 py-1.5', unit ? 'whitespace-nowrap text-right tabular-nums' : 'max-w-[16rem] truncate')}>
                      {formatCell(v, unit)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
          {table.total && (
            <tfoot>
              <tr className="border-t bg-muted/20 font-medium">
                {table.total.map((v, j) => {
                  const unit = table.columns[j]?.unit;
                  return (
                    <td key={j} className={cn('px-2.5 py-1.5', unit ? 'whitespace-nowrap text-right tabular-nums' : '')}>
                      {v === '' ? '' : formatCell(v, unit)}
                    </td>
                  );
                })}
              </tr>
            </tfoot>
          )}
        </table>
      </div>
      {(hidden > 0 || table.more) && (
        <p className="flex flex-wrap items-center gap-x-3 text-[11px] text-muted-foreground">
          {hidden > 0 && !still && (
            <button type="button" onClick={() => setAll(true)} className="font-medium text-primary hover:underline">
              Show all {table.rows.length} rows
            </button>
          )}
          {hidden > 0 && still && <span>{hidden} more rows in the app</span>}
          {!!table.more && <span>{table.more.toLocaleString('en-IN')} more in the full report</span>}
        </p>
      )}
    </div>
  );
}

export function ReportView({
  report,
  variant,
  actions,
  footer,
  still = false,
}: {
  report: AiReport;
  variant: ReportVariant;
  /** Beside the title. */
  actions?: ReactNode;
  footer?: ReactNode;
  /** Drawn for an image: no buttons, nothing that needs a click. */
  still?: boolean;
}) {
  const [tableView, setTableView] = useState(false);
  const compact = variant === 'compact';
  const kpis = compact ? report.kpis.slice(0, 4) : report.kpis;
  const cols = compact ? 'grid-cols-2' : kpis.length >= 4 ? 'grid-cols-2 sm:grid-cols-4' : kpis.length === 3 ? 'grid-cols-2 sm:grid-cols-3' : 'grid-cols-2';
  const insights = compact ? report.insights.slice(0, 1) : report.insights;

  return (
    <div className="space-y-3">
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-md bg-primary/10 text-primary" aria-hidden>
          <ChartColumnBig className="size-3.5" />
        </span>
        <div className="min-w-0 flex-1 leading-tight">
          <p className={cn('font-semibold', variant === 'sheet' ? 'text-base' : 'truncate text-sm')}>{report.title}</p>
          <p className="mt-0.5 truncate text-[11px] text-muted-foreground">{report.subtitle}</p>
        </div>
        {actions}
      </div>

      {kpis.length > 0 && <div className={cn('grid gap-2', cols)}>{kpis.map((k) => <Kpi key={k.label} k={k} />)}</div>}

      {report.chart && (
        <div className="space-y-1" data-slot="ai-report-chart">
          {!compact && !still && (
            <div className="flex justify-end">
              <button
                type="button"
                onClick={() => setTableView((v) => !v)}
                className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
                aria-pressed={tableView}
              >
                {tableView ? <ChartColumnBig className="size-3" /> : <Table2 className="size-3" />}
                {tableView ? 'Chart view' : 'Table view'}
              </button>
            </div>
          )}
          {tableView ? <ChartTable chart={report.chart} /> : <ReportChartView chart={report.chart} height={CHART_HEIGHT[variant]} compact={compact} />}
        </div>
      )}

      {report.table && report.table.rows.length > 0 && <DetailTable table={report.table} limit={still ? 20 : ROWS[variant]} still={still} />}

      {insights.length > 0 && (
        <ul className="space-y-1.5" data-slot="ai-report-insights">
          {insights.map((t) => (
            <li key={t} className="flex gap-2 text-xs leading-relaxed">
              <Lightbulb className="mt-0.5 size-3.5 shrink-0 text-primary" aria-hidden />
              <span>{t}</span>
            </li>
          ))}
        </ul>
      )}

      {footer}
    </div>
  );
}
