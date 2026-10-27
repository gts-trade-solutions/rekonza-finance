'use client';

// Warehouses.
//
// Each one belongs to a branch, and each branch has its own GST registration.
// That link is the point: moving stock between warehouses in different states
// is treated as a supply under GST even though nothing was sold, and needs a
// delivery challan and an e-way bill.

import { useState } from 'react';
import { Building, Package, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Combobox } from '@/components/ui/combobox';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog';
import { PageHeader } from '@/components/shared/page-header';
import { Money } from '@/components/shared/money';
import { EmptyState } from '@/components/shared/empty-state';
import { AsyncPage } from '@/components/shared/async-state';
import { Field } from '@/components/shared/form-bits';
import { inventory, type StockResponse, type WarehouseRow } from '@/lib/api/client';
import { useApi, useApiAction } from '@/lib/api/use-api';
import { useAppStore } from '@/lib/store';
import { useCanSeeCosts, usePermission } from '@/lib/store/hooks';

const BLANK = { name: '', code: '', address: '', branchId: '' };

export default function WarehousesPage() {
  const canCreate = usePermission('inventory', 'create');
  const canSeeCosts = useCanSeeCosts();
  const branches = useAppStore((s) => s.branches);

  const state = useApi<{ warehouses: WarehouseRow[] }>(() => inventory.warehouses(), []);
  const stock = useApi<StockResponse>(() => inventory.stock(), []);

  const [open, setOpen] = useState(false);
  const [f, setF] = useState(BLANK);
  const create = useApiAction(inventory.createWarehouse);

  const save = async () => {
    if (!f.name.trim()) {
      toast.error('Give the warehouse a name.');
      return;
    }
    const done = await create.run({
      name: f.name.trim(),
      code: f.code || null,
      address: f.address || null,
      branchId: f.branchId || null,
    });
    if (!done) {
      toast.error(create.error ?? 'The warehouse was not created');
      return;
    }
    toast.success(`${done.name} added`);
    setOpen(false);
    setF(BLANK);
    state.refetch();
  };

  return (
    <>
      <PageHeader
        title="Warehouses"
        description="Where stock physically sits, and which GST registration it sits under."
        actions={
          canCreate && (
            <Dialog open={open} onOpenChange={setOpen}>
              <DialogTrigger asChild>
                <Button size="sm" className="gap-1.5"><Plus className="size-4" /> New warehouse</Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>New warehouse</DialogTitle>
                  <DialogDescription>
                    Tie it to the branch whose GST registration covers that location — that is what decides whether
                    a transfer out of it is a taxable supply.
                  </DialogDescription>
                </DialogHeader>
                <div className="space-y-4">
                  <Field label="Name" required error={create.fieldErrors.name}>
                    <Input
                      value={f.name}
                      onChange={(e) => setF({ ...f, name: e.target.value })}
                      placeholder="Main store"
                    />
                  </Field>
                  <div className="grid grid-cols-2 gap-4">
                    <Field label="Code" hint="Short reference for labels">
                      <Input
                        value={f.code}
                        onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase() })}
                        placeholder="WH-01"
                        className="font-mono"
                      />
                    </Field>
                    <Field label="Branch">
                      <Combobox
                        options={branches.map((b) => ({
                          value: b.id,
                          label: b.name,
                          sublabel: b.gstin ?? undefined,
                        }))}
                        value={f.branchId}
                        onChange={(v) => setF({ ...f, branchId: v })}
                        placeholder="Not tied to a branch"
                        searchPlaceholder="Search branches"
                        showAvatar={false}
                        clearable
                      />
                    </Field>
                  </div>
                  <Field label="Address">
                    <Input
                      value={f.address}
                      onChange={(e) => setF({ ...f, address: e.target.value })}
                      placeholder="Building, street, city and pincode"
                    />
                  </Field>
                  {create.error && <p className="text-sm text-destructive">{create.error}</p>}
                </div>
                <DialogFooter>
                  <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
                  <Button onClick={save} disabled={create.busy}>
                    {create.busy ? 'Saving…' : 'Add warehouse'}
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          )
        }
      />

      <AsyncPage state={state}>
        {(d) =>
          d.warehouses.length === 0 ? (
            <EmptyState
              icon={Building}
              title="No warehouses"
              description="Add one to record where stock physically sits. Stock quantities work without it; a warehouse is for knowing which location they are in."
            />
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {d.warehouses.map((w) => {
                const branch = branches.find((b) => b.id === w.branchId);
                return (
                  <Card key={w.id} className="p-5">
                    <div className="flex items-start gap-3">
                      <div className="rounded-lg bg-primary/10 p-2.5">
                        <Building className="size-4 text-primary" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <p className="font-medium">{w.name}</p>
                          {w.isPrimary && <Badge variant="secondary" className="text-[9px]">Default</Badge>}
                        </div>
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          {w.address ?? w.branchName ?? 'No address on file'}
                        </p>
                        {branch?.gstin && (
                          <Badge variant="secondary" className="mt-1.5 font-mono text-[10px]">{branch.gstin}</Badge>
                        )}
                      </div>
                    </div>
                  </Card>
                );
              })}
            </div>
          )
        }
      </AsyncPage>

      <AsyncPage state={stock}>
        {(s) => (
          <Card className="p-5">
            <h3 className="mb-3 text-sm font-semibold">Stock across all locations</h3>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <p className="text-xs text-muted-foreground">Distinct items</p>
                <p className="mt-0.5 flex items-center gap-1.5 text-lg font-semibold tabular">
                  <Package className="size-3.5 text-muted-foreground" /> {s.summary.tracked}
                </p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Stock value</p>
                {canSeeCosts ? (
                  <Money value={s.summary.totalValuePaise} className="mt-0.5 block text-lg font-semibold" />
                ) : (
                  <p className="mt-0.5 text-lg font-semibold text-muted-foreground">Hidden</p>
                )}
              </div>
            </div>
            <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
              Quantities are not yet split per warehouse — a bill records what arrived, not which door it came
              through. Until receipts carry a location, this total is the honest figure.
            </p>
          </Card>
        )}
      </AsyncPage>

      <Card className="flex items-start gap-3 p-4">
        <Building className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <p className="text-xs leading-relaxed text-muted-foreground">
          Each warehouse belongs to a branch, and each branch has its own GST registration. That link matters:
          moving stock between warehouses in different states is treated as a supply under GST even though nothing
          was sold, and needs a delivery challan and an e-way bill.
        </p>
      </Card>
    </>
  );
}
