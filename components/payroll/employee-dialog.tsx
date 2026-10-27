'use client';

// Adding or editing an employee: who they are, how the statutory schemes
// apply to them, where their salary goes, and the salary itself. A raise is a
// new structure from a date, so earlier months keep the pay they were earned at.

import { useEffect, useMemo, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { EmployeeConsents } from './employee-privacy';
import { Attachments } from '@/components/shared/attachments';
import { Field, MoneyInput } from '@/components/shared/form-bits';
import { Money } from '@/components/shared/money';
import { useSession } from '@/components/layout/session-provider';
import { api } from '@/lib/api/client';
import { today } from '@/lib/selectors';
import { esi, pf, professionalTax, annualTax } from '@/lib/payroll/statutory';

export interface EmployeeRow {
  id: string; branchId: string; branchName: string; stateCode: string; code: string; name: string;
  gender: 'male' | 'female' | 'other' | null; dateOfBirth: string | null; dateOfJoining: string; dateOfLeaving: string | null;
  designation: string | null; department: string | null; email: string | null; mobile: string | null;
  pan: string | null; uan: string | null; esiIpNumber: string | null;
  pfMember: boolean; epsMember: boolean; pfOnActual: boolean; ptApplicable: boolean; lwfApplicable: boolean; disabled: boolean;
  taxRegime: 'new' | 'old'; declaredDeductionsPaise: number; metroCity: boolean;
  bankAccountName: string | null; bankAccountNo: string | null; bankIfsc: string | null;
  aadhaarMasked?: string | null;
  salary: Structure | null; monthlyGrossPaise: number;
  salaryHistory: (Structure & { effectiveFrom: string })[];
}
interface Structure { basic: number; da: number; hra: number; special: number; other: number }

const blank = (branchId: string) => ({
  branchId, code: '', name: '', gender: '' as '' | 'male' | 'female' | 'other', dateOfBirth: '', dateOfJoining: today(), dateOfLeaving: '',
  designation: '', department: '', email: '', mobile: '', pan: '', uan: '', esiIpNumber: '',
  pfMember: true, epsMember: true, pfOnActual: false, ptApplicable: true, lwfApplicable: true, disabled: false,
  taxRegime: 'new' as 'new' | 'old', declaredDeductionsPaise: 0, metroCity: false, bankAccountName: '', bankAccountNo: '', bankIfsc: '',
  /** Typed only to set or change it; it is never sent back from the server. */
  aadhaarNo: '',
});

export function EmployeeDialog({ open, employee, onClose, onSaved }: {
  open: boolean; employee: EmployeeRow | null; onClose: () => void; onSaved: () => void;
}) {
  const session = useSession();
  const branches = session.branches ?? [];
  const [f, setF] = useState(() => blank(branches[0]?.id ?? ''));
  const [salary, setSalary] = useState<Structure & { effectiveFrom: string }>({ basic: 0, da: 0, hra: 0, special: 0, other: 0, effectiveFrom: today() });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    if (employee) {
      setF({
        ...blank(employee.branchId), ...employee, gender: employee.gender ?? '', dateOfBirth: employee.dateOfBirth ?? '',
        dateOfLeaving: employee.dateOfLeaving ?? '', designation: employee.designation ?? '', department: employee.department ?? '',
        email: employee.email ?? '', mobile: employee.mobile ?? '', pan: employee.pan ?? '', uan: employee.uan ?? '',
        esiIpNumber: employee.esiIpNumber ?? '', bankAccountName: employee.bankAccountName ?? '', bankAccountNo: employee.bankAccountNo ?? '',
        bankIfsc: employee.bankIfsc ?? '',
      });
      setSalary({ ...(employee.salary ?? { basic: 0, da: 0, hra: 0, special: 0, other: 0 }), effectiveFrom: today() });
    } else {
      setF(blank(branches[0]?.id ?? ''));
      setSalary({ basic: 0, da: 0, hra: 0, special: 0, other: 0, effectiveFrom: today() });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, employee]);

  const gross = salary.basic + salary.da + salary.hra + salary.special + salary.other;
  const stateCode = branches.find((b) => b.id === f.branchId)?.stateCode ?? '';
  // What the structure means each month, worked out as a payroll run would.
  const preview = useMemo(() => {
    const pfr = pf({ pfWage: salary.basic + salary.da, member: f.pfMember, epsMember: f.epsMember, onActual: f.pfOnActual });
    const esir = esi({ esiWage: gross, rateWage: gross, paidDays: 30, disabled: f.disabled, coveredThisPeriod: false });
    const pt = f.ptApplicable ? professionalTax({ stateCode, month: today().slice(0, 7), gross, gender: f.gender || null }) : 0;
    const tax = annualTax({ regime: f.taxRegime, grossSalary: gross * 12, deductions: f.declaredDeductionsPaise, professionalTax: pt * 12 }).tax;
    const tds = Math.round(tax / 12 / 100) * 100;
    return { pfr, esir, pt, tds, net: gross - pfr.employee - esir.employee - pt - tds, cost: gross + pfr.employerEpf + pfr.employerEps + pfr.admin + pfr.edli + esir.employer };
  }, [salary, gross, f, stateCode]);

  const changedSalary = !!employee && JSON.stringify({ ...employee.salary }) !== JSON.stringify({ basic: salary.basic, da: salary.da, hra: salary.hra, special: salary.special, other: salary.other });
  const save = async () => {
    setBusy(true);
    try {
      const body = { ...f, gender: f.gender || null, aadhaarNo: f.aadhaarNo.trim() ? f.aadhaarNo : undefined };
      if (employee) {
        await api.post('/api/payroll/employees', { action: 'update', id: employee.id, employee: body });
        if (changedSalary) await api.post('/api/payroll/employees', { action: 'salary', id: employee.id, salary });
      } else {
        const { effectiveFrom: _ignored, ...structure } = salary;
        await api.post('/api/payroll/employees', { action: 'create', employee: body, salary: structure });
      }
      toast.success(employee ? `${f.name} updated` : `${f.name} added`);
      onSaved();
    } catch (e) {
      toast.error('Not saved', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));
  const toggle = (k: 'pfMember' | 'epsMember' | 'pfOnActual' | 'ptApplicable' | 'lwfApplicable' | 'disabled', label: string, hint: string) => (
    <div className="flex items-center justify-between gap-3 border-t pt-2.5">
      <div><p className="text-sm">{label}</p><p className="text-xs text-muted-foreground">{hint}</p></div>
      <Switch checked={f[k]} onCheckedChange={(v) => set(k, v)} />
    </div>
  );

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader><DialogTitle>{employee ? `${employee.code} · ${employee.name}` : 'Add an employee'}</DialogTitle></DialogHeader>
        <Tabs defaultValue="details">
          <TabsList>
            <TabsTrigger value="details">Details</TabsTrigger>
            <TabsTrigger value="salary">Salary</TabsTrigger>
            <TabsTrigger value="statutory">PF, ESI and tax</TabsTrigger>
            <TabsTrigger value="bank">Bank</TabsTrigger>
            {employee && <TabsTrigger value="papers">Papers</TabsTrigger>}
            {employee && <TabsTrigger value="privacy">Privacy</TabsTrigger>}
          </TabsList>
          <TabsContent value="details" className="mt-4 grid gap-3 sm:grid-cols-3">
            <Field label="Employee code" required><Input value={f.code} onChange={(e) => set('code', e.target.value)} /></Field>
            <Field label="Name" required className="sm:col-span-2"><Input value={f.name} onChange={(e) => set('name', e.target.value)} /></Field>
            <Field label="Works at" hint="Its state decides professional tax and LWF">
              <div><Select value={f.branchId} onValueChange={(v) => set('branchId', String(v))}>
                <SelectTrigger><SelectValue placeholder="Branch" /></SelectTrigger>
                <SelectContent>{branches.map((b) => <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>)}</SelectContent>
              </Select></div>
            </Field>
            <Field label="Designation"><Input value={f.designation} onChange={(e) => set('designation', e.target.value)} /></Field>
            <Field label="Department"><Input value={f.department} onChange={(e) => set('department', e.target.value)} /></Field>
            <Field label="Joined on" required><Input type="date" value={f.dateOfJoining} onChange={(e) => set('dateOfJoining', e.target.value)} /></Field>
            <Field label="Left on" hint="Pay stops after this day"><Input type="date" value={f.dateOfLeaving} onChange={(e) => set('dateOfLeaving', e.target.value)} /></Field>
            <Field label="Date of birth"><Input type="date" value={f.dateOfBirth} onChange={(e) => set('dateOfBirth', e.target.value)} /></Field>
            <Field label="Gender" hint="Professional tax differs in some states">
              <div><Select value={f.gender} onValueChange={(v) => set('gender', v as typeof f.gender)}>
                <SelectTrigger><SelectValue placeholder="—" /></SelectTrigger>
                <SelectContent><SelectItem value="male">Male</SelectItem><SelectItem value="female">Female</SelectItem><SelectItem value="other">Other</SelectItem></SelectContent>
              </Select></div>
            </Field>
            <Field label="Email"><Input type="email" value={f.email} onChange={(e) => set('email', e.target.value)} /></Field>
            <Field label="Mobile"><Input value={f.mobile} onChange={(e) => set('mobile', e.target.value)} /></Field>
          </TabsContent>

          <TabsContent value="salary" className="mt-4 space-y-4">
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Basic" required hint="PF is worked on basic and DA"><MoneyInput valuePaise={salary.basic} onChangePaise={(v) => setSalary({ ...salary, basic: v })} /></Field>
              <Field label="Dearness allowance"><MoneyInput valuePaise={salary.da} onChangePaise={(v) => setSalary({ ...salary, da: v })} /></Field>
              <Field label="HRA"><MoneyInput valuePaise={salary.hra} onChangePaise={(v) => setSalary({ ...salary, hra: v })} /></Field>
              <Field label="Special allowance"><MoneyInput valuePaise={salary.special} onChangePaise={(v) => setSalary({ ...salary, special: v })} /></Field>
              <Field label="Other allowances"><MoneyInput valuePaise={salary.other} onChangePaise={(v) => setSalary({ ...salary, other: v })} /></Field>
              {employee && (
                <Field label="Effective from" hint={changedSalary ? 'The revised pay applies from this date' : 'Change a figure to revise the pay'}>
                  <Input type="date" value={salary.effectiveFrom} onChange={(e) => setSalary({ ...salary, effectiveFrom: e.target.value })} disabled={!changedSalary} />
                </Field>
              )}
            </div>
            <div className="grid gap-x-6 gap-y-1.5 rounded-md border p-4 text-sm sm:grid-cols-2">
              <p className="font-medium sm:col-span-2">A full month on this salary</p>
              <span className="text-muted-foreground">Gross</span><Money value={gross} className="text-right" />
              <span className="text-muted-foreground">Employee PF</span><Money value={-preview.pfr.employee} className="text-right" />
              <span className="text-muted-foreground">Employee ESI</span><Money value={-preview.esir.employee} className="text-right" />
              <span className="text-muted-foreground">Professional tax</span><Money value={-preview.pt} className="text-right" />
              <span className="text-muted-foreground">TDS (estimate)</span><Money value={-preview.tds} className="text-right" />
              <span className="border-t pt-1.5 font-medium">Take-home</span><Money value={preview.net} className="border-t pt-1.5 text-right font-semibold" />
              <span className="text-muted-foreground">Cost to the business</span><Money value={preview.cost} className="text-right" />
            </div>
            {employee && employee.salaryHistory.length > 0 && (
              <ul className="divide-y rounded-md border text-xs">
                {employee.salaryHistory.map((h) => (
                  <li key={h.effectiveFrom} className="flex justify-between px-3 py-2">
                    <span className="text-muted-foreground">From {h.effectiveFrom}</span>
                    <Money value={h.basic + h.da + h.hra + h.special + h.other} />
                  </li>
                ))}
              </ul>
            )}
          </TabsContent>

          <TabsContent value="statutory" className="mt-4 space-y-3">
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="PAN" hint="Without it TDS is at 20% at least"><Input value={f.pan} onChange={(e) => set('pan', e.target.value.toUpperCase())} maxLength={10} className="font-mono" /></Field>
              <Field label="UAN" hint="For the PF return"><Input value={f.uan} onChange={(e) => set('uan', e.target.value)} maxLength={12} className="font-mono" /></Field>
              <Field label="ESI IP number"><Input value={f.esiIpNumber} onChange={(e) => set('esiIpNumber', e.target.value)} className="font-mono" /></Field>
              <Field label="Tax regime">
                <div><Select value={f.taxRegime} onValueChange={(v) => set('taxRegime', v as 'new' | 'old')}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent><SelectItem value="new">New regime (default)</SelectItem><SelectItem value="old">Old regime</SelectItem></SelectContent>
                </Select></div>
              </Field>
              {f.taxRegime === 'old' && (
                <Field label="Declared deductions for the year" hint="Used until investment declarations are entered under Payroll → Declarations" className="sm:col-span-2">
                  <MoneyInput valuePaise={f.declaredDeductionsPaise} onChangePaise={(v) => set('declaredDeductionsPaise', v)} />
                </Field>
              )}
              {f.taxRegime === 'old' && (
                <label className="flex items-start gap-2 text-sm sm:col-span-2">
                  <input type="checkbox" className="mt-1" checked={f.metroCity} onChange={(e) => set('metroCity', e.target.checked)} />
                  <span>Lives in Delhi, Mumbai, Kolkata or Chennai<span className="block text-xs text-muted-foreground">Half of basic and DA counts towards the HRA exemption, not two-fifths.</span></span>
                </label>
              )}
            </div>
            {toggle('pfMember', 'Provident fund', 'Contributions at 12% each from employee and employer')}
            {f.pfMember && toggle('epsMember', 'Pension scheme (EPS)', 'Off for someone who joined after September 2014 on more than ₹15,000')}
            {f.pfMember && toggle('pfOnActual', 'PF on the whole wage', 'Off contributes on the ₹15,000 ceiling')}
            {toggle('ptApplicable', 'Professional tax', 'At the rates of the state they work in')}
            {toggle('lwfApplicable', 'Labour welfare fund', 'Where the state levies it')}
            {toggle('disabled', 'Person with a disability', 'ESI covers wages up to ₹25,000 instead of ₹21,000')}
          </TabsContent>

          <TabsContent value="bank" className="mt-4 grid gap-3 sm:grid-cols-3">
            <Field label="Name on the account"><Input value={f.bankAccountName} onChange={(e) => set('bankAccountName', e.target.value)} /></Field>
            <Field label="Account number"><Input value={f.bankAccountNo} onChange={(e) => set('bankAccountNo', e.target.value)} className="font-mono" /></Field>
            <Field label="IFSC"><Input value={f.bankIfsc} onChange={(e) => set('bankIfsc', e.target.value.toUpperCase())} maxLength={11} className="font-mono" /></Field>
          </TabsContent>
          {employee && (
            <TabsContent value="papers" className="mt-4">
              <Attachments targetType="employee" targetId={employee.id} canEdit title="Offer letter, ID and address proof, forms" />
            </TabsContent>
          )}
          {employee && (
            <TabsContent value="privacy" className="mt-4 space-y-4">
              <Field label="Aadhaar number" hint={employee.aadhaarMasked ? `On file: ${employee.aadhaarMasked}. Type a new one to change it.` : 'Optional. Kept sealed, and only ever shown masked.'}>
                <Input value={f.aadhaarNo} onChange={(e) => set('aadhaarNo', e.target.value.replace(/[^0-9 ]/g, '').slice(0, 14))} placeholder="1234 5678 9012" inputMode="numeric" className="font-mono" autoComplete="off" />
              </Field>
              <EmployeeConsents employeeId={employee.id} canEdit />
            </TabsContent>
          )}
        </Tabs>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={() => void save()} disabled={busy || !f.code || !f.name || !f.branchId || salary.basic <= 0} className="gap-1.5">
            {busy && <Loader2 className="size-3.5 animate-spin" />} {employee ? 'Save' : 'Add employee'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
