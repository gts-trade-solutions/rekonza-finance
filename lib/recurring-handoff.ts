// The New Invoice form's "Make Recurring" (Zoho's) hands the unsaved form to
// the recurring profile under this session-storage key; the recurring page
// reads it once and clears it.
export const RECURRING_FROM_FORM = 'rekonza-recurring-from-invoice-form';
