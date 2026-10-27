'use client';

import { useRouter } from 'next/navigation';
import {
  CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList,
} from '@/components/ui/command';
import { NAV_GROUPS, BOTTOM_LEVEL, TOP_LEVEL } from './nav-config';
import {
  Banknote, FileText, Receipt, Wallet, CreditCard, Users, Building2, Split, BookOpen,
} from 'lucide-react';

/*
  Every href here must be a real route. Expenses, vendors and manual journals
  are created from a dialog on their list page, so they link to the list — not
  to a /new route that does not exist.
*/
const CREATE_ACTIONS = [
  { label: 'New Invoice', href: '/sales/invoices/new', icon: Receipt },
  { label: 'New Bill', href: '/purchases/bills/new', icon: FileText },
  { label: 'Record Payment Received', href: '/sales/payments/new', icon: Wallet },
  { label: 'Record Payment Made', href: '/purchases/payments/new', icon: Banknote },
  { label: 'Record Expense', href: '/purchases/expenses', icon: CreditCard },
  { label: 'New Customer', href: '/sales/customers/new', icon: Users },
  { label: 'New Vendor', href: '/purchases/vendors', icon: Building2 },
  { label: 'New Estimate', href: '/sales/estimates', icon: FileText },
  { label: 'New Manual Journal', href: '/accountant/journals', icon: BookOpen },
  { label: 'Reconcile Bank', href: '/banking/reconcile', icon: Split },
];

export function QuickCreate({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const router = useRouter();
  const go = (href: string) => {
    onOpenChange(false);
    router.push(href);
  };

  const allPages = [
    ...TOP_LEVEL,
    ...NAV_GROUPS.flatMap((g) => g.items.map((i) => ({ ...i, label: `${g.label} › ${i.label}` }))),
    ...BOTTOM_LEVEL,
  ];

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      <CommandInput placeholder="Create something or jump to a screen…" />
      <CommandList>
        <CommandEmpty>No matches.</CommandEmpty>
        <CommandGroup heading="Create">
          {CREATE_ACTIONS.map((a) => (
            <CommandItem key={a.href} onSelect={() => go(a.href)}>
              <a.icon className="mr-2 size-4" />
              {a.label}
            </CommandItem>
          ))}
        </CommandGroup>
        <CommandGroup heading="Go to">
          {allPages.map((p) => (
            <CommandItem key={p.href} onSelect={() => go(p.href)}>
              <p.icon className="mr-2 size-4" />
              {p.label}
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
