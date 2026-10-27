'use client';

// GSTR-3B — the monthly summary, and the return you actually pay against.
//
// The interesting part is the set-off. Input credit must be used in an order
// the law fixes, not one you choose: IGST credit first and against any head,
// then CGST and SGST credit against their own heads only. CGST credit can never
// clear SGST liability, because one belongs to the central government and the
// other to your state — they are different creditors.

import { useState } from 'react';
import { ArrowRight, Info, ShieldAlert, Wallet } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { PageHeader } from '@/components/shared/page-header';
import { Money } from '@/components/shared/money';
import { AsyncPage } from '@/components/shared/async-state';
import { gst, type Gstr3bResponse } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';

const thisMonth = () => new Date().toISOString().slice(0, 7);

function Row({
  label, hint, cgst, sgst, igst, emphasis,
}: {
  label: string; hint?: string; cgst: number; sgst: number; igst: number; emphasis?: boolean;
}) {
  return (
    <tr className={'border-b last:border-0 ' + (emphasis ? 'bg-muted/40 font-semibold' : '')}>
      <td className="px-4 py-2.5">
        {label}
        {hint && <p className="mt-0.5 text-xs font-normal text-muted-foreground">{hint}</p>}
      </td>
      <td className="px-4 py-2.5 text-right"><Money value={cgst} showZero={false} /></td>
      <td className="px-4 py-2.5 text-right"><Money value={sgst} showZero={false} /></td>
      <td className="px-4 py-2.5 text-right"><Money value={igst} showZero={false} /></td>
      <td className="px-4 py-2.5 text-right"><Money value={cgst + sgst + igst} /></td>
    </tr>
  );
}

export default function Gstr3bPage() {
  const [month, setMonth] = useState(thisMonth());
  const state = useApi<Gstr3bResponse>(() => gst.gstr3b(month), [month]);

  return (
    <>
      <PageHeader
        title="GSTR-3B — monthly summary"
        description="What you owe the government this month, after using up the credit you've already paid on purchases."
        actions={
          <Input
            type="month"
            value={month}
            onChange={(e) => setMonth(e.target.value)}
            className="h-8 w-40"
          />
        }
      />

      <AsyncPage state={state}>
        {(d) => {
          const outputTotal = d.outward.cgstPaise + d.outward.sgstPaise + d.outward.igstPaise + d.outward.cessPaise;
          const creditTotal = d.itc.cgstPaise + d.itc.sgstPaise + d.itc.igstPaise + d.itc.cessPaise;
          const hasRcm = d.inwardRcm.cgstPaise + d.inwardRcm.sgstPaise + d.inwardRcm.igstPaise + d.inwardRcm.cessPaise > 0;
          // Cess is shown only when the month has any; most businesses never do.
          const heads = d.setOff.filter((s) => s.head !== 'CESS' || s.liabilityPaise > 0 || s.creditUsedPaise > 0);

          const byHead = (head: 'CGST' | 'SGST' | 'IGST') =>
            d.setOff.find((s) => s.head === head) ?? { liabilityPaise: 0, creditUsedPaise: 0, cashPaise: 0 };

          return (
            <>
              <div className="grid gap-3 sm:grid-cols-3">
                <Card className="p-4">
                  <p className="text-xs text-muted-foreground">Tax collected on sales</p>
                  <Money value={outputTotal} className="mt-1 block text-2xl font-semibold" />
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    on <Money value={d.outward.taxablePaise} /> of taxable supplies
                  </p>
                  {(d.advances.receivedTaxPaise > 0 || d.advances.adjustedTaxPaise > 0) && (
                    <p className="mt-1 text-xs text-muted-foreground">
                      Includes <Money value={d.advances.receivedTaxPaise} /> on advances received
                      {d.advances.adjustedTaxPaise > 0 && <>, less <Money value={d.advances.adjustedTaxPaise} /> on earlier advances now invoiced</>}.
                    </p>
                  )}
                </Card>
                <Card className="p-4">
                  <p className="text-xs text-muted-foreground">Credit available on purchases</p>
                  <Money value={creditTotal} className="mt-1 block text-2xl font-semibold" />
                  {d.itc.blockedPaise > 0 && (
                    <p className="mt-0.5 flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400">
                      <ShieldAlert className="size-3" />
                      <Money value={d.itc.blockedPaise} /> blocked under 17(5)
                    </p>
                  )}
                  {d.itc.reversedPaise > 0 && (
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      after <Money value={d.itc.reversedPaise} /> reversed by vendor credits
                    </p>
                  )}
                  {(d.itc.reversedRule42Paise ?? 0) !== 0 && (
                    <p className="mt-0.5 text-xs text-muted-foreground">4(B)(1): <Money value={d.itc.reversedRule42Paise ?? 0} /> reversed under Rules 42/43</p>
                  )}
                  {(d.itc.reversedRule37Paise ?? 0) !== 0 && (
                    <p className="mt-0.5 text-xs text-muted-foreground">4(B)(2): <Money value={d.itc.reversedRule37Paise ?? 0} /> reversed under Rule 37</p>
                  )}
                  {(d.itc.reclaimedPaise ?? 0) !== 0 && (
                    <p className="mt-0.5 text-xs text-muted-foreground">4(D)(1): <Money value={d.itc.reclaimedPaise ?? 0} /> taken back on payment</p>
                  )}
                </Card>
                <Card
                  className={
                    'p-4 ' +
                    (d.totalCashPaise > 0
                      ? 'border-amber-500/40 bg-amber-500/5'
                      : 'border-emerald-500/40 bg-emerald-500/5')
                  }
                >
                  <p className="text-xs text-muted-foreground">Cash payable</p>
                  <Money value={d.totalCashPaise} className="mt-1 block text-2xl font-semibold" />
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {d.totalCashPaise > 0 ? 'Due by the 20th of next month' : 'Fully covered by input credit'}
                  </p>
                </Card>
              </div>

              <Card className="overflow-hidden p-0">
                <div className="overflow-x-auto thin-scroll">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
                        <th className="px-4 py-2.5 text-left font-semibold">Particulars</th>
                        <th className="px-4 py-2.5 text-right font-semibold">CGST</th>
                        <th className="px-4 py-2.5 text-right font-semibold">SGST</th>
                        <th className="px-4 py-2.5 text-right font-semibold">IGST</th>
                        <th className="px-4 py-2.5 text-right font-semibold">Total</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr className="border-b bg-muted/30">
                        <td colSpan={5} className="px-4 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                          3.1 — Outward supplies (what you collected)
                        </td>
                      </tr>
                      <Row
                        label="Taxable outward supplies"
                        hint="GST charged on your sales this month"
                        cgst={d.outward.cgstPaise}
                        sgst={d.outward.sgstPaise}
                        igst={d.outward.igstPaise}
                      />
                      {hasRcm && (
                        <Row
                          label="Inward supplies liable to reverse charge"
                          hint="Tax you owe directly on purchases from unregistered suppliers"
                          cgst={d.inwardRcm.cgstPaise}
                          sgst={d.inwardRcm.sgstPaise}
                          igst={d.inwardRcm.igstPaise}
                        />
                      )}

                      <tr className="border-b bg-muted/30">
                        <td colSpan={5} className="px-4 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                          4 — Eligible input tax credit (what you already paid)
                        </td>
                      </tr>
                      <Row
                        label="Credit on purchases and expenses"
                        hint="GST your suppliers charged you, claimable back — including the reverse-charge tax you paid yourself"
                        cgst={d.itc.cgstPaise}
                        sgst={d.itc.sgstPaise}
                        igst={d.itc.igstPaise}
                      />

                      <tr className="border-b bg-muted/30">
                        <td colSpan={5} className="px-4 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                          6.1 — Payment of tax
                        </td>
                      </tr>
                      <Row
                        label="Credit set off against liability"
                        cgst={byHead('CGST').creditUsedPaise}
                        sgst={byHead('SGST').creditUsedPaise}
                        igst={byHead('IGST').creditUsedPaise}
                      />
                      <Row
                        label="Cash payable after set-off"
                        emphasis
                        cgst={byHead('CGST').cashPaise}
                        sgst={byHead('SGST').cashPaise}
                        igst={byHead('IGST').cashPaise}
                      />
                    </tbody>
                  </table>
                </div>
              </Card>

              <Card className="p-5">
                <div className="mb-3 flex items-start gap-2">
                  <Wallet className="mt-0.5 size-4 shrink-0 text-primary" />
                  <div>
                    <h3 className="text-sm font-semibold">How the set-off worked</h3>
                    <p className="text-xs text-muted-foreground">
                      The law fixes the order in which credit is used up. You can&apos;t choose — and getting it
                      wrong means paying cash you didn&apos;t need to.
                    </p>
                  </div>
                </div>

                <div className="space-y-2">
                  {heads.map((s, i) => (
                    <div key={s.head} className="flex flex-wrap items-center gap-3 rounded-md border p-3">
                      <Badge variant="secondary" className="shrink-0 tabular text-[10px]">{i + 1}</Badge>
                      <span className="min-w-0 flex-1 text-sm">
                        {s.head === 'CESS' ? 'Cess' : s.head} liability <Money value={s.liabilityPaise} />
                        {s.creditUsedPaise > 0 && (
                          <>
                            {' '}less credit <Money value={s.creditUsedPaise} />
                          </>
                        )}
                        {s.rcmPaise > 0 && (
                          <span className="block text-xs text-muted-foreground">
                            <Money value={s.rcmPaise} /> of it is reverse charge, paid in cash and claimed back as credit
                          </span>
                        )}
                      </span>
                      <ArrowRight className="size-3.5 shrink-0 text-muted-foreground" />
                      <Money
                        value={s.cashPaise}
                        className={'text-sm font-medium ' + (s.cashPaise > 0 ? '' : 'text-muted-foreground')}
                      />
                    </div>
                  ))}
                </div>

                <div className="mt-4 flex items-start gap-2 rounded-md border bg-muted/40 p-3">
                  <Info className="mt-0.5 size-3.5 shrink-0 text-primary" />
                  <p className="text-[11px] leading-relaxed text-muted-foreground">
                    IGST credit is the flexible one and must be used first — against IGST, then whatever is left
                    spills onto CGST and SGST. After that, CGST credit clears CGST and then any IGST still owed, and
                    SGST credit the same; CGST and SGST credit never cross, because one belongs to the central
                    government and the other to your state. Cess credit only clears cess. Reverse-charge tax is
                    never set off: it is paid in cash and claimed back as credit in the same return.
                  </p>
                </div>
              </Card>
            </>
          );
        }}
      </AsyncPage>
    </>
  );
}
