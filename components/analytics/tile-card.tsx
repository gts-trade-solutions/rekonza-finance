'use client';

// One tile on a report: a titled card holding a chart, with its own menu.
//
// Every tile can flip to the table behind it. That is not a nicety — it is the
// accessible reading of the chart, the answer to "what exactly is that bar",
// and the view a finance reader copies figures from.

import { useMemo, useState, type CSSProperties } from 'react';
import {
  ArrowDown, ArrowUp, ChartColumnBig, Copy, Download, Ellipsis, Pencil, Table2, Trash2,
} from 'lucide-react';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup,
  DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent,
  DropdownMenuSubTrigger, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { downloadCsv } from '@/components/shared/report-shell';
import type { DatasetData, Filter, QueryResult, Tile, TileWidth } from '@/lib/analytics/types';
import { cn } from '@/lib/utils';
import { ChartView, ResultTable, autoTitle, queryTile } from './chart-view';

/** Column spans on the 12-column grid, collapsing on narrow screens. */
export const SPAN: Record<TileWidth, string> = {
  3: 'col-span-12 sm:col-span-6 lg:col-span-3',
  4: 'col-span-12 sm:col-span-6 lg:col-span-4',
  6: 'col-span-12 lg:col-span-6',
  8: 'col-span-12 lg:col-span-8',
  12: 'col-span-12',
};

export const WIDTH_LABELS: Record<TileWidth, string> = {
  3: 'Quarter width',
  4: 'Third width',
  6: 'Half width',
  8: 'Two-thirds width',
  12: 'Full width',
};

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'chart';

/** The tile's numbers as a CSV — raw values, not the formatted text, so a spreadsheet can add them up. */
export function resultCsv(result: QueryResult): (string | number)[][] {
  const head = [result.categoryLabel ?? ''];
  const cols: { m: number; s: number }[] = [];
  if (result.series.length) {
    result.measures.forEach((meta, m) =>
      result.series.forEach((s, i) => {
        head.push(result.measures.length > 1 ? `${meta.label} · ${s}` : s);
        cols.push({ m, s: i });
      }),
    );
  } else {
    result.measures.forEach((meta, m) => {
      head.push(meta.label);
      cols.push({ m, s: 0 });
    });
  }
  const body = result.categories.map((cat, c) => [cat, ...cols.map(({ m, s }) => result.values[m][c][s] ?? '')]);
  return [head, ...body];
}

export function TileCard({
  tile,
  data,
  filters,
  editable,
  index,
  count,
  large,
  onEdit,
  onDuplicate,
  onRemove,
  onMove,
  onResize,
}: {
  tile: Tile;
  data: DatasetData;
  filters: Filter[];
  editable: boolean;
  index: number;
  count: number;
  /** Presenting: taller plots, no chrome that can be clicked. */
  large?: boolean;
  onEdit?: () => void;
  onDuplicate?: () => void;
  onRemove?: () => void;
  onMove?: (delta: -1 | 1) => void;
  onResize?: (width: TileWidth) => void;
}) {
  const [asTable, setAsTable] = useState(false);
  const result = useMemo(() => queryTile(data, tile.spec, filters), [data, tile.spec, filters]);
  const title = autoTitle(tile.spec, result);
  const kind = tile.spec.type;
  const isGrid = kind === 'table' || kind === 'pivot';
  const isKpi = kind === 'kpi';
  const height = large ? (tile.width >= 8 ? 380 : 320) : tile.width >= 8 ? 300 : 260;

  const notes: string[] = [];
  const folded = (n: number, label: string | null) =>
    `${n} more ${label ?? ''} ${n === 1 ? 'value is' : 'values are'} combined into Other.`.replace(/\s+/g, ' ');
  if (result.folded.categories) notes.push(folded(result.folded.categories, result.categoryLabel));
  if (result.folded.series) notes.push(folded(result.folded.series, result.seriesLabel));

  return (
    <section
      className={cn('analytics-tile flex min-w-0 flex-col rounded-[3px] border bg-card', SPAN[tile.width])}
      style={{ '--span': tile.width } as CSSProperties}
      aria-label={title}
      data-slot="analytics-tile"
      data-tile-type={kind}
    >
      <header className="flex items-start gap-2 px-4 pt-3">
        <h3 className={cn('min-w-0 flex-1 font-semibold leading-snug', isKpi ? 'text-xs text-muted-foreground' : 'text-[13px]')}>
          {title}
        </h3>
        {!large && (
          <div className="-mr-1.5 -mt-0.5 flex shrink-0 items-center no-print">
            {!isKpi && !isGrid && (
              <button
                type="button"
                onClick={() => setAsTable((v) => !v)}
                className="grid size-7 place-items-center rounded-[3px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                aria-label={asTable ? 'Show as chart' : 'Show as table'}
                title={asTable ? 'Show as chart' : 'Show as table'}
                aria-pressed={asTable}
                data-slot="tile-view-toggle"
              >
                {asTable ? <ChartColumnBig className="size-3.5" /> : <Table2 className="size-3.5" />}
              </button>
            )}
            <DropdownMenu>
              <DropdownMenuTrigger
                aria-label="Chart options"
                data-slot="tile-menu"
                className="grid size-7 place-items-center rounded-[3px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                <Ellipsis className="size-4" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-52">
                {editable && (
                  <>
                    <DropdownMenuItem onClick={onEdit}>
                      <Pencil /> Edit chart
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={onDuplicate}>
                      <Copy /> Duplicate
                    </DropdownMenuItem>
                    <DropdownMenuSub>
                      <DropdownMenuSubTrigger>Width</DropdownMenuSubTrigger>
                      <DropdownMenuSubContent className="w-44">
                        <DropdownMenuRadioGroup value={String(tile.width)} onValueChange={(v) => onResize?.(Number(v) as TileWidth)}>
                          {([3, 4, 6, 8, 12] as TileWidth[]).map((w) => (
                            <DropdownMenuRadioItem key={w} value={String(w)}>
                              {WIDTH_LABELS[w]}
                            </DropdownMenuRadioItem>
                          ))}
                        </DropdownMenuRadioGroup>
                      </DropdownMenuSubContent>
                    </DropdownMenuSub>
                    <DropdownMenuItem disabled={index === 0} onClick={() => onMove?.(-1)}>
                      <ArrowUp /> Move earlier
                    </DropdownMenuItem>
                    <DropdownMenuItem disabled={index === count - 1} onClick={() => onMove?.(1)}>
                      <ArrowDown /> Move later
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                  </>
                )}
                <DropdownMenuItem onClick={() => downloadCsv(`${slug(title)}.csv`, resultCsv(result))}>
                  <Download /> Download as CSV
                </DropdownMenuItem>
                {editable && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem variant="destructive" onClick={onRemove}>
                      <Trash2 /> Remove from report
                    </DropdownMenuItem>
                  </>
                )}
                {!editable && (
                  <DropdownMenuLabel className="font-normal">
                    Only the owner can change this report. Save a copy to make your own.
                  </DropdownMenuLabel>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        )}
      </header>

      <div className={cn('min-w-0 flex-1 px-4 pb-3', isKpi ? 'pt-1' : 'pt-2')}>
        {asTable && !isKpi ? (
          <ResultTable result={result} />
        ) : (
          <ChartView spec={tile.spec} result={result} data={data} filters={filters} height={height} />
        )}
      </div>

      {notes.length > 0 && !isKpi && (
        <footer className="border-t px-4 py-1.5 text-[11px] text-muted-foreground">{notes.join(' ')}</footer>
      )}
    </section>
  );
}
