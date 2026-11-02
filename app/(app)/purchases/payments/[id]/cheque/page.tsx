'use client';

// Printing a cheque for a payment made by cheque, on the standard CTS-2010
// leaf every Indian bank issues (8 × 3⅔ inches): the date in its eight boxes,
// the payee, the amount in words and in figures, and "A/c Payee" across the
// top left when the cheque is to be crossed.
//
// Banks place the boxes a few millimetres differently, and every printer
// feeds a little off, so the layout can be nudged up, down, left and right;
// the nudge is remembered on this computer for the next cheque.

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { ArrowLeft, Printer } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { AsyncPage } from '@/components/shared/async-state';
import { api } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { rupeesInWords } from '@/lib/billing/words';
import { printPage } from '@/lib/output-guard';

interface Payment { id: string; number: string; kind: string; date: string; status: string; payeeName: string; mode: string; reference: string | null; bankName: string | null; amountPaise: number }

const STORE = 'rekonza.cheque-offset';
const readOffset = () => {
  try { return JSON.parse(localStorage.getItem(STORE) ?? '') as { x: number; y: number }; } catch { return { x: 0, y: 0 }; }
};

export default function ChequePrintPage() {
  const { id } = useParams<{ id: string }>();
  const state = useApi<Payment>(() => api.get(`/api/payments/${id}`), [id]);
  const [crossed, setCrossed] = useState(true);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  useEffect(() => { setOffset(readOffset()); }, []);
  useEffect(() => { try { localStorage.setItem(STORE, JSON.stringify(offset)); } catch { /* private window */ } }, [offset]);

  return (
    <AsyncPage state={state}>
      {(p) => {
        const [y, m, d] = p.date.split('-');
        const digits = `${d}${m}${y}`.split('');
        const words = rupeesInWords(p.amountPaise).replace(/^Rupees\s*/i, '');
        const figure = (p.amountPaise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        const problem = p.kind !== 'made' ? 'This is a receipt; a cheque is printed only for a payment made.'
          : p.status === 'void' ? 'This payment is void.' : p.mode !== 'cheque' ? `This payment was made by ${p.mode.toUpperCase()}, not by cheque.` : null;
        return (
          <div className="space-y-4">
            <div className="flex flex-wrap items-end justify-between gap-3 no-print">
              <Button variant="outline" size="sm" asChild><Link href="/purchases/payments"><ArrowLeft className="size-3.5" /> Payments made</Link></Button>
              <div className="flex flex-wrap items-end gap-3 text-xs">
                <label className="flex items-center gap-2">A/c Payee <Switch checked={crossed} onCheckedChange={setCrossed} /></label>
                <label className="grid gap-1">Move right (mm)<Input type="number" className="h-8 w-20" value={offset.x} onChange={(e) => setOffset({ ...offset, x: Number(e.target.value) || 0 })} /></label>
                <label className="grid gap-1">Move down (mm)<Input type="number" className="h-8 w-20" value={offset.y} onChange={(e) => setOffset({ ...offset, y: Number(e.target.value) || 0 })} /></label>
                <Button size="sm" onClick={() => printPage()} disabled={!!problem} data-slot="print-cheque-button"><Printer className="size-3.5" /> Print cheque</Button>
              </div>
            </div>
            {problem && <p className="text-sm text-destructive no-print">{problem}</p>}
            <p className="text-xs text-muted-foreground no-print">
              {p.number} · {p.bankName ?? 'bank account'}{p.reference ? ` · cheque no. ${p.reference}` : ''}. Put the leaf in the printer face up, top edge first; print a test on plain paper and hold it against a leaf to set the nudge.
            </p>
            {/* The leaf itself: 203 × 93 mm. Only this prints. */}
            <div className="mx-auto overflow-x-auto">
              <div
                className="relative mx-auto bg-white text-[13px] text-black shadow-sm ring-1 ring-slate-300 print:shadow-none print:ring-0"
                style={{ width: '203mm', height: '93mm', fontFamily: 'Arial, sans-serif' }}
                data-slot="cheque-leaf"
              >
                <div className="absolute inset-0" style={{ transform: `translate(${offset.x}mm, ${offset.y}mm)` }}>
                  {crossed && (
                    <div className="absolute text-[11px] font-semibold" style={{ left: '8mm', top: '6mm', transform: 'rotate(-20deg)', borderTop: '1px solid', borderBottom: '1px solid', padding: '1px 4px' }}>
                      A/c Payee
                    </div>
                  )}
                  {/* Date boxes, DDMMYYYY, top right. */}
                  <div className="absolute flex" style={{ left: '153mm', top: '8mm', gap: '0' }}>
                    {digits.map((c, i) => <span key={i} className="inline-block text-center font-semibold" style={{ width: '5mm', letterSpacing: 0 }}>{c}</span>)}
                  </div>
                  <div className="absolute font-semibold uppercase" style={{ left: '16mm', top: '21mm', width: '160mm' }}>{p.payeeName}</div>
                  <div className="absolute leading-[7.5mm]" style={{ left: '26mm', top: '29mm', width: '120mm' }}>{words}</div>
                  <div className="absolute font-semibold" style={{ left: '158mm', top: '37mm', width: '38mm' }}>{figure}/-</div>
                </div>
              </div>
            </div>
          </div>
        );
      }}
    </AsyncPage>
  );
}
