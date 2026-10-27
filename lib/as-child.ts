import { isValidElement, type ReactElement, type ReactNode } from 'react';

/**
 * Compatibility shim: this shadcn style is built on Base UI, which composes via
 * a `render` prop rather than Radix's `asChild`. Rather than rewrite every call
 * site, primitives accept `asChild` and we translate it here.
 */
export function withAsChild<P extends object>(
  props: P & { asChild?: boolean; children?: ReactNode },
): P {
  const { asChild, children, ...rest } = props as P & {
    asChild?: boolean;
    children?: ReactNode;
  };
  if (asChild && isValidElement(children)) {
    return { ...(rest as P), render: children as ReactElement } as P;
  }
  return props as P;
}
